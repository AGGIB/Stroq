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
]);

export const WRAPPER_VALUE_FLAGS: Readonly<Record<string, ReadonlySet<string>>> = {
  sudo: new Set(['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-T', '-U']),
  nice: new Set(['-n']),
  env: new Set(['-u', '-C']),
};

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

/**
 * Splits a raw command into segments: top-level pipeline/chain segments plus
 * the (further-split) inner text of any process/command substitutions and
 * backtick expressions found anywhere in the command.
 */
export function splitSegments(command: string): string[] {
  const substitutions = extractSubstitutions(command).flatMap(splitTop);
  return [...splitTop(command), ...substitutions];
}

function tokenize(segment: string): string[] {
  return segment.split(/\s+/).map(stripEmptyQuotePairs);
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
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? '';
    if (token === '' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
    if (SHELL_KEYWORDS.has(token)) continue;
    if (PREFIX_WORDS.has(token)) {
      wrapper = token;
      continue;
    }
    if (token.startsWith('-')) {
      if (WRAPPER_VALUE_FLAGS[wrapper]?.has(token)) i += 1;
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
  let sawCommand = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? '';
    if (token === '' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
    if (SHELL_KEYWORDS.has(token)) continue;
    if (!sawCommand) {
      if (PREFIX_WORDS.has(token)) {
        wrapper = token;
        continue;
      }
      if (token.startsWith('-')) {
        if (WRAPPER_VALUE_FLAGS[wrapper]?.has(token)) i += 1;
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
