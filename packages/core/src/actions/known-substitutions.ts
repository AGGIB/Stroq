import type { Lexed } from './shell-lex.js';
import { printed } from './shell-print.js';
import { resolve } from './shell-words.js';

/**
 * A command with each substitution that only prints a literal put where it stands.
 *
 * `$(echo rm) -rf ~`, `` `printf rm` -rf ~ `` and `"$(echo rm)" -rf ~` run `rm -rf ~`: the shell
 * puts what `echo` prints where the substitution is, and the classifier reads words, so a command
 * word that is a substitution names no command. Where what is printed is known (a literal, with no
 * variable, glob or format it cannot model in it), the line is read a second time as the shell
 * would expand it, as a text of its own, and what that reading finds is added to what the first did.
 */

/** The most substitutions that are put in place, and the longest text one is put in as. */
const MAX_SUBSTITUTIONS = 256;
const MAX_TEXT_CHARS = 256;
/**
 * What a printed text may hold to be put in a word as it is: letters, digits and a few signs, a
 * pattern (`x.s?`, which the shell expands where it stands), and blanks.
 */
const PLAIN_TEXT = /^[\w./~:@%+=,*?[\]-]+(?: [\w./~:@%+=,*?[\]-]+)*$/;

/**
 * `which rm`, `command -v rm`, `type -p rm`: a path whose last part is the name asked for, which is
 * the command that runs, and what is put in its place.
 */
const LOOKUP = /^\s*(?:which(?:\s+-a)?|whence(?:\s+-p)?|type\s+-p|command\s+-v)\s+([\w.+-]+)\s*$/;

/** The text of a substitution's command, as the shell hands it on (a backtick pair unescapes). */
const bodyOf = (text: string, from: number, to: number, backtick: boolean): string => {
  const body = text.slice(from, to);
  return backtick ? body.replace(/\\([`$\\])/g, '$1') : body;
};

/** What the command of a substitution prints, where that is known and reaches the substitution. */
function printedBy(body: string): string | null {
  const lookup = LOOKUP.exec(body);
  if (lookup !== null) return lookup[1] as string;
  const command = resolve(body);
  const output = command === null ? null : printed(command);
  if (output === null || output.dynamic || output.unknown) return null;
  // Output sent to a file or another stream is not what the substitution is replaced by.
  if (command?.args.some((word) => word.redirect) === true) return null;
  // The shell takes the line breaks off the end of what a substitution prints.
  return output.text.replace(/\n+$/, '');
}

/** The text with its literal substitutions replaced, or null where it holds none. */
export function withLiteralSubstitutions(text: string, lexed: Lexed): string | null {
  if (lexed.nested.length === 0) return null;
  const parts: string[] = [];
  let at = 0;
  let made = 0;
  for (const found of lexed.nested) {
    // `$(…)` or a pair of backticks: not `<(…)`, which is a file name, not what a command prints.
    const open = found.backtick ? found.from - 1 : found.from - 2;
    const close = found.to + 1;
    const right = found.backtick
      ? text.charAt(open) === '`' && text.charAt(found.to) === '`'
      : text.startsWith('$(', open) && text.charAt(found.to) === ')';
    if (!right || open < at || made >= MAX_SUBSTITUTIONS) continue;
    const value = printedBy(bodyOf(text, found.from, found.to, found.backtick));
    if (value === null || value.length > MAX_TEXT_CHARS || !PLAIN_TEXT.test(value)) continue;
    parts.push(text.slice(at, open), value);
    at = close;
    made += 1;
  }
  if (made === 0) return null;
  parts.push(text.slice(at));
  return parts.join('');
}
