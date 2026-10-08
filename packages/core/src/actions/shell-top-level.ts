import { armCommands, splitTop, type SplitCommand } from './shell-segments.js';

/**
 * A command cut at its own top level the way a shell cuts it, for the detectors that read
 * COMMANDS. The cut that makes `segments` (`splitTop`) ignores quotes, which suits the detectors
 * that read text, and does not suit one that has to know which words are a command's own.
 */

const HEREDOC_OPENER = /<<-?\s*(['"]?)([A-Za-z_]\w*)\1/y;

/** A lone `&` ends a command that runs in the background: not `&&`, `>&`, `<&`, `|&`, `&>`. */
function isBackgroundAmpersand(command: string, i: number, start: number): boolean {
  // Where nothing comes before it, it is PowerShell's call operator: `& ./clean.ps1`.
  if (command.charAt(i) !== '&' || command.slice(start, i).trim() === '') return false;
  const next = command.charAt(i + 1);
  const prev = command.charAt(i - 1);
  return next !== '&' && next !== '>' && !['>', '<', '&', '|'].includes(prev);
}

/**
 * The command's own top-level segments, cut only where the shell cuts: at `|`, `||`, `&&`,
 * `;` and a line break outside quotes. The plain cut (`splitTop`) ignores quotes, so
 * `perl -pi -e 's/a/b|c/' ~/.zshrc` lost its file to a segment `c/' ~/.zshrc`, and
 * `grep -E "a|crontab|b"` grew a segment `crontab` that bash never runs. A heredoc body is
 * not shell text, so an apostrophe in it opens no quote: its lines are cut as the plain
 * cut does, as before. A quote that never closes runs to the end, as it does in the shell,
 * which refuses the command.
 */
export function splitTopQuoted(command: string): string[] {
  const out: string[] = [];
  const pending: string[] = [];
  let start = 0;
  let quote = '';
  const cut = (end: number): void => {
    const piece = command.slice(start, end).trim();
    if (piece !== '') out.push(piece);
  };
  for (let i = 0; i < command.length; i += 1) {
    const ch = command.charAt(i);
    if (quote !== '') {
      if (ch === '\\' && quote === '"') i += 1;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '<' && command.charAt(i + 1) === '<' && command.charAt(i + 2) !== '<') {
      HEREDOC_OPENER.lastIndex = i;
      const opener = HEREDOC_OPENER.exec(command);
      if (opener !== null) {
        pending.push(opener[2] as string);
        i = HEREDOC_OPENER.lastIndex - 1;
      }
      continue;
    }
    const two = command.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      cut(i);
      i += 1;
      start = i + 1;
      continue;
    }
    if (
      ch === ';' ||
      (ch === '|' &&
        command.charAt(i - 1) !== '>' &&
        !(command.charAt(i - 1) === '&' && command.charAt(i - 2) === '>')) ||
      isBackgroundAmpersand(command, i, start)
    ) {
      cut(i);
      if (ch === '|' && command.charAt(i + 1) === '&') i += 1;
      start = i + 1;
      continue;
    }
    if (ch !== '\n') continue;
    cut(i);
    start = i + 1;
    // The bodies of the heredocs this line opened, each up to its delimiter line.
    // An index, not `shift()`: a line that opens thousands of heredocs would make each
    // `shift` move the rest of the array.
    for (let next = 0; next < pending.length; next += 1) {
      const delimiter = pending[next] as string;
      let lineStart = start;
      while (lineStart <= command.length) {
        const lineEnd = command.indexOf('\n', lineStart);
        const end = lineEnd === -1 ? command.length : lineEnd;
        const line = command.slice(lineStart, end);
        lineStart = end + 1;
        if (line.trim() === delimiter) break;
        out.push(...splitTop(line));
        if (lineEnd === -1) break;
      }
      start = Math.min(lineStart, command.length);
      i = start - 1;
    }
    pending.length = 0;
  }
  if (quote === '' || start < command.length) cut(command.length);
  return out;
}

/**
 * The segments a detector that reads COMMANDS should see: the top level cut as the shell
 * cuts it (see `splitTopQuoted`), then the nested commands `splitCommand` extracted.
 */
export function commandSegments(command: string, split: SplitCommand): string[] {
  const top = splitTopQuoted(command);
  return [...top, ...armCommands(top), ...split.segments.slice(split.topLevel)];
}
