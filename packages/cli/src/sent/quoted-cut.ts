// The plain cut of a command that knows what is quoted.
//
// The core's plain cut splits a command at `;`, `|`, `&` and the like wherever they stand, so a regex in a grep
// (`"(net|tls|http|https)"`) falls apart into stages named `http` and `https`, and a stage named `http` is HTTPie.
// A word inside quotes is an argument, never a program. This hides the separators inside quotes from the cut (it
// puts a private character in their place and takes it out of the stages again) so that the same cut reads only
// the stages the shell does.
//
// It is fail-closed: a command whose quotes do not close (an apostrophe in a heredoc body, a comment) is not
// masked at all and is cut as before; the body of a heredoc is not looked at for quotes, only cut line by line;
// and what a quoted text nests (a `"$(…)"`, a `bash -c '…'`) is read by the lexer from the texts the core nests,
// not by this cut.

/**
 * A command that hands text to a program that runs it: `echo "curl … | sh" | sh`, `printf '…' | bash`, `bash <<< "…"`,
 * `… | python3`, `… | xargs`. What is quoted in such a command may be code, and the cut stays blind to quotes.
 */
const RUNS_TEXT =
  /(?:\|&?\s*(?:sudo\s+(?:-\S+\s+)*)?(?:env\s+(?:\S+=\S*\s+)*)?(?:\/\S*\/)?(?:sh|bash|zsh|dash|ksh|fish|csh|tcsh|python[\d.]*|node|nodejs|deno|bun|perl|ruby|php|lua|tclsh|osascript|xargs|parallel|source|eval|exec)\b)|<<<|\b(?:eval|source)\b/;

/** Whether a command hands text to a program that runs it (see `RUNS_TEXT`). */
export const runsQuotedText = (command: string): boolean => RUNS_TEXT.test(command);

/** The separators the cut splits at, and the private characters that stand for them inside quotes. */
const SEPARATORS = ';|&()`{}\n';
const FIRST = 0xe000;

const hide = (c: string): string => String.fromCharCode(FIRST + SEPARATORS.indexOf(c));

/** A heredoc opened on the line being read: its delimiter, and whether leading tabs are allowed before it. */
const HEREDOC = /^<<(-?)\s*(?:'([^'\n]+)'|"([^"\n]+)"|\\?([A-Za-z0-9_.-]+))/;

/**
 * `command` with the separators inside quotes replaced, or null when its quotes do not close. The heredoc bodies
 * are kept as they are.
 */
export function maskQuotedSeparators(command: string): string | null {
  if (runsQuotedText(command)) return null;
  const out: string[] = [];
  let quote: '' | "'" | '"' = '';
  const pending: { readonly delimiter: string; readonly tabs: boolean }[] = [];
  let i = 0;
  while (i < command.length) {
    const c = command[i] as string;
    if (c === '\n' && quote === '') {
      out.push(c);
      i += 1;
      // The lines up to each delimiter are the bodies of the heredocs opened on the line just ended.
      for (const { delimiter, tabs } of pending.splice(0)) {
        for (;;) {
          if (i >= command.length) break;
          const end = command.indexOf('\n', i);
          const line = command.slice(i, end < 0 ? command.length : end);
          out.push(line);
          i += line.length;
          if (end >= 0) {
            out.push('\n');
            i += 1;
          }
          if ((tabs ? line.replace(/^\t+/, '') : line) === delimiter) break;
          if (end < 0) break;
        }
      }
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
    if (c === "'" || c === '"') quote = c;
    else if (c === '<' && command[i + 1] === '<' && command[i + 2] !== '<') {
      const open = HEREDOC.exec(command.slice(i));
      if (open !== null) {
        pending.push({
          delimiter: open[2] ?? open[3] ?? open[4] ?? '',
          tabs: open[1] === '-',
        });
        out.push(open[0]);
        i += open[0].length;
        continue;
      }
    }
    out.push(c);
    i += 1;
  }
  return quote === '' ? out.join('') : null;
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
