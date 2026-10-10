import { baseName } from './stroq-commands.js';

/**
 * Folding the line breaks of a command that are text and not the end of a command, for the reading of
 * `stroq-state.ts`: a string that spans lines, and the body of a heredoc that no shell is given.
 */

const SHELL_WORDS: ReadonlySet<string> = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'source',
  '.',
]);
/** Text before a quote that makes the quoted string a script: `sh -c "…"`, `eval "…"`. */
const RUNS_STRING = /(?:\b(?:ba|z|da|k)?sh\s+(?:-\w+\s+)*-c|\beval)\s*$/;

interface Heredoc {
  readonly delim: string;
  readonly stripTabs: boolean;
  /** Fed to a shell, so its lines are commands and keep their newlines. */
  readonly script: boolean;
}

/**
 * The command with the newlines of its text folded to spaces: inside a quoted string
 * that is not a script, and inside a heredoc whose command is not a shell. One pass,
 * no pattern that can backtrack: the classifier's ReDoS gate runs over this too.
 */
export function joinText(command: string): string {
  let out = '';
  let quote: { readonly char: string; readonly script: boolean } | null = null;
  const pending: Heredoc[] = [];
  let nextPending = 0;
  let body: Heredoc | null = null;
  let bodyLine = '';
  let lineStart = 0;
  for (let i = 0; i < command.length; i += 1) {
    const c = command.charAt(i);
    if (body !== null) {
      if (c !== '\n') {
        bodyLine += c;
        out += c;
        continue;
      }
      const line = body.stripTabs ? bodyLine.replace(/^\t+/, '') : bodyLine;
      if (line === body.delim) {
        out += '\n';
        body = pending[nextPending++] ?? null;
        lineStart = i + 1;
      } else {
        out += body.script ? '\n' : ' ';
      }
      bodyLine = '';
      continue;
    }
    if (quote !== null) {
      if (quote.char === '"' && c === '\\' && i + 1 < command.length) {
        out += c + command.charAt(i + 1);
        i += 1;
        continue;
      }
      if (c === quote.char) quote = null;
      out += c === '\n' && quote !== null && !quote.script ? ' ' : c;
      continue;
    }
    if (c === '\\' && i + 1 < command.length) {
      out += c + command.charAt(i + 1);
      i += 1;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = { char: c, script: RUNS_STRING.test(command.slice(Math.max(lineStart, i - 40), i)) };
      out += c;
      continue;
    }
    if (c === '<' && command.charAt(i + 1) === '<' && command.charAt(i + 2) !== '<') {
      // Only the start of the line is needed, for its command word: slicing the whole
      // line for each of many operators on it was quadratic (47 s on 256 KiB).
      const lineHead = command.slice(lineStart, Math.min(i, lineStart + 256));
      const { heredoc, end } = readHeredoc(command, i + 2, lineHead);
      if (heredoc !== null) pending.push(heredoc);
      out += command.slice(i, end);
      i = end - 1;
      continue;
    }
    if (c === '\n') {
      body = pending[nextPending++] ?? null;
      // The newline that opens a text heredoc's body is part of that text too: kept,
      // it made the body's first line a command of its own.
      out += body !== null && !body.script ? ' ' : c;
      lineStart = i + 1;
      continue;
    }
    out += c;
  }
  return out;
}

/** The heredoc whose operator ends at `from`, and where its delimiter word ends. */
function readHeredoc(
  command: string,
  from: number,
  lineBefore: string,
): { readonly heredoc: Heredoc | null; readonly end: number } {
  let j = from;
  const stripTabs = command.charAt(j) === '-';
  if (stripTabs) j += 1;
  while (command.charAt(j) === ' ' || command.charAt(j) === '\t') j += 1;
  const q = command.charAt(j);
  let delim = '';
  if (q === '"' || q === "'") {
    // Each operator's own quote is the next one to find, so this stays linear; a
    // quote with no close anywhere after it is answered without a scan.
    const close = command.lastIndexOf(q) > j ? command.indexOf(q, j + 1) : -1;
    if (close === -1) return { heredoc: null, end: j };
    delim = command.slice(j + 1, close);
    j = close + 1;
  } else {
    const start = j;
    while (j < command.length && /[\w.-]/.test(command.charAt(j))) j += 1;
    delim = command.slice(start, j);
  }
  if (delim === '') return { heredoc: null, end: j };
  const word = baseName(lineBefore.trim().split(/\s+/)[0] ?? '');
  return { heredoc: { delim, stripTabs, script: SHELL_WORDS.has(word) }, end: j };
}
