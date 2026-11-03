// The plain cut of a command that knows what is quoted.
//
// The core's plain cut splits a command at `;`, `|`, `&` and the like wherever they stand, so a regex in a grep
// (`"(net|tls|http|https)"`) falls apart into stages named `http` and `https`, and a stage named `http` is HTTPie.
// A word inside quotes is an argument, never a program. This hides the separators inside quotes from the cut (it
// puts a private character in their place and takes it out of the stages again) so that the same cut reads only
// the stages the shell does.
//
// It is fail-closed: a command whose quotes do not close (an apostrophe in a heredoc body, a comment) is not
// masked at all and is cut as before; the body of a heredoc that is code is not looked at for quotes, only cut line
// by line, and one that is text is one placeholder line (`heredoc-programs.ts`); and what a quoted text nests (a
// `"$(…)"`, a `bash -c '…'`) is read by the lexer from the texts the core nests, not by this cut.
import { firstProgram, isDataHeredoc } from './heredoc-programs.js';

/**
 * A command that hands text to a program that runs it: `echo "curl … | sh" | sh`, `printf '…' | bash`, `bash <<< "…"`,
 * `… | python3`, `… | xargs`. What is quoted in such a command may be code, and the cut stays blind to quotes.
 *
 * An assignment after `env` is cut at its first `=` (`[^\s=]*=`): a word with two of them read as `\S+=\S*` could be
 * cut at either, and a line of such words with no program after it was tried every way, in time that doubles with
 * each word. Every word the old reading took is still taken.
 */
const RUNS_TEXT =
  /(?:\|&?\s*(?:sudo\s+(?:-\S+\s+)*)?(?:env\s+(?:[^\s=]*=\S*\s+)*)?(?:\/\S*\/)?(?:sh|bash|zsh|dash|ksh|fish|csh|tcsh|python[\d.]*|node|nodejs|deno|bun|perl|ruby|php|lua|tclsh|osascript|xargs|parallel|source|eval|exec)\b)|<<<|(?<![\w.-])(?:eval|source)(?![\w-])/;

/** Whether a command hands text to a program that runs it (see `RUNS_TEXT`). */
export const runsQuotedText = (command: string): boolean => RUNS_TEXT.test(command);

/** Programs that run the text they are given: a stage of one is code, and so is the text piped into it. */
const RUNNERS =
  /^(?:sh|bash|zsh|dash|ksh|fish|csh|tcsh|python[\d.]*|nodejs?|deno|bun|perl|ruby|php|lua|tclsh|osascript|xargs|parallel|source|eval|exec|\.)$/;

/** Whether one stage runs text it is given: a shell or interpreter, `eval`, `source`, `xargs`, or a here-string. */
export const stageRunsText = (stage: string): boolean =>
  RUNNERS.test(firstProgram(stage)) || stage.includes('<<<');

/** The separators the cut splits at, and the private characters that stand for them inside quotes. */
const SEPARATORS = ';|&()`{}\n';
const FIRST = 0xe000;

const hide = (c: string): string => String.fromCharCode(FIRST + SEPARATORS.indexOf(c));

/** A heredoc opened on the line being read: its delimiter, and whether leading tabs are allowed before it. */
const HEREDOC = /^<<(-?)\s*(?:'([^'\n]+)'|"([^"\n]+)"|(\\?)([A-Za-z0-9_.-]+))/;

/** What reading the quotes of a command found. */
export interface QuoteScan {
  /** The command with the separators inside quotes hidden. */
  readonly masked: string;
  /** Where the quote that is never closed was opened, or null when every quote closes. */
  readonly unclosedAt: number | null;
}

interface PendingHeredoc {
  readonly delimiter: string;
  readonly tabs: boolean;
  /** The delimiter is quoted: nothing in the body is expanded. */
  readonly quoted: boolean;
  /** The program only reads text, and what it prints goes nowhere (see `isDataHeredoc`). */
  readonly reads: boolean;
  /** The text of the stage up to the heredoc, and the rest of its line. */
  readonly before: string;
  readonly rest: string;
}

/** Reads the quotes of a command: the separators inside them hidden, and where one is left open. */
export function scanQuotes(command: string): QuoteScan {
  const out: string[] = [];
  let quote: '' | "'" | '"' = '';
  let quoteAt = -1;
  const pending: PendingHeredoc[] = [];
  // Where the stage being read began: the heredoc it opens is text or code by the program it runs.
  let stageStart = 0;
  let i = 0;
  while (i < command.length) {
    const c = command[i] as string;
    if (c === '\n' && quote === '') {
      out.push(c);
      i += 1;
      // The lines up to each delimiter are the bodies of the heredocs opened on the line just ended.
      for (const open of pending.splice(0)) {
        const lines: string[] = [];
        let last = '';
        while (i < command.length) {
          const end = command.indexOf('\n', i);
          const line = command.slice(i, end < 0 ? command.length : end);
          i += line.length + (end >= 0 ? 1 : 0);
          const ends = (open.tabs ? line.replace(/^\t+/, '') : line) === open.delimiter;
          if (ends) {
            last = end >= 0 ? `${line}\n` : line;
            break;
          }
          lines.push(line);
          if (end < 0) break;
        }
        // A body that is text (a file written, a pattern given) is one placeholder line: its lines are no
        // stages, whatever they spell. The line that ends it stays.
        const data =
          open.reads && isDataHeredoc(open.before, open.rest, open.quoted, lines.join('\n'));
        out.push(data ? 'x\n' : lines.map((line) => `${line}\n`).join(''));
        out.push(last);
      }
      stageStart = i;
      continue;
    }
    if (quote === "'") {
      out.push(c === "'" ? c : SEPARATORS.includes(c) ? hide(c) : c);
      if (c === "'") quote = '';
      i += 1;
      continue;
    }
    if (c === '\\') {
      const next = command[i + 1] ?? '';
      out.push(c, quote !== '' && SEPARATORS.includes(next) ? hide(next) : next);
      i += 2;
      continue;
    }
    if (quote === '"') {
      out.push(c === '"' ? c : SEPARATORS.includes(c) ? hide(c) : c);
      if (c === '"') quote = '';
      i += 1;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      quoteAt = i;
    } else if (c === '<' && command[i + 1] === '<' && command[i + 2] !== '<') {
      const open = HEREDOC.exec(command.slice(i));
      if (open !== null) {
        const lineEnd = command.indexOf('\n', i);
        const before = command.slice(stageStart, i);
        const rest = command.slice(i + open[0].length, lineEnd < 0 ? command.length : lineEnd);
        pending.push({
          delimiter: open[2] ?? open[3] ?? open[5] ?? '',
          tabs: open[1] === '-',
          quoted: open[2] !== undefined || open[3] !== undefined || open[4] === '\\',
          // Only the program and the line decide here; the body decides when it has been read.
          reads: isDataHeredoc(before, rest, true, ''),
          before,
          rest,
        });
        out.push(open[0]);
        i += open[0].length;
        continue;
      }
    }
    out.push(c);
    i += 1;
    if (SEPARATORS.includes(c)) stageStart = i;
  }
  return { masked: out.join(''), unclosedAt: quote === '' ? null : quoteAt };
}

/**
 * `command` with the separators inside quotes replaced, or null when its quotes do not close or it hands text to a
 * program that runs it (the cut is then blind). The bodies of heredocs that are text are one line.
 */
export function maskQuotedSeparators(command: string): string | null {
  if (runsQuotedText(command)) return null;
  const scan = scanQuotes(command);
  return scan.unclosedAt === null ? scan.masked : null;
}

/** A text the cut gave back with the hidden separators put back. */
export function unmaskSeparators(text: string): string {
  let out = '';
  for (const c of text) {
    const at = c.charCodeAt(0) - FIRST;
    out += at >= 0 && at < SEPARATORS.length ? (SEPARATORS[at] as string) : c;
  }
  return out;
}

/**
 * The stages of a command as the quote-aware cut makes them: the texts between the separators outside quotes,
 * each with its quotes intact. Null where the quotes do not close or the command hands text to a program that runs
 * it, where every cut is blind.
 */
export function quotedStageTexts(
  command: string,
  split: (text: string) => readonly (readonly string[])[],
): string[] | null {
  const masked = maskQuotedSeparators(command);
  if (masked === null) return null;
  return split(masked)
    .flat()
    .map((text) => unmaskSeparators(text));
}
