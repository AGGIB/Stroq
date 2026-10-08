/**
 * Code that a shell finds in a value and runs later, where nothing in the command says it will: a
 * prompt string that is expanded on every traced line (`PS4='$(cmd)'` with `set -x`) or before every
 * prompt, and an array subscript that arithmetic evaluates (`x='a[$(cmd)]'; echo $((x))`). A quoted
 * `$( … )` is text to everything that reads the command, so a command in one of these is not read.
 * They are not followed (what the shell does with a value is its own business); that a command writes
 * one of them is a question.
 */

/**
 * A prompt string named anywhere that is not a read of it (`PS4='…'`, `PS4+=…`, `printf -v PS4`,
 * `read PS4`, `declare PS4`), and a substitution in the command, or `PROMPT_COMMAND`, which is a
 * command line: `PS4` is expanded on every traced line, so what is in it runs under `set -x`.
 */
const PROMPT_STRING = /(?<![A-Za-z0-9_$])(?<!\$\{)PS[0-4](?![A-Za-z0-9_])/;
const PROMPT_COMMAND = /(?<![A-Za-z0-9_$])(?<!\$\{)PROMPT_COMMAND(?![A-Za-z0-9_])/;
const SUBSTITUTION = /\$\(|`/;

/**
 * An array subscript with a substitution in it, where a name is being given a value or an operand
 * that is one (`x='a[$(cmd)]'`, `export 'a[$(cmd)]'`, `printf -v 'a[$(cmd)]'`): arithmetic evaluates it
 * as the shell does a word. Not `s[s.index(…)]` in a Python program or a `[` in a pattern.
 */
const SUBSCRIPT_CODE =
  /(?:=|\b(?:export|declare|typeset|local|readonly|let|printf\s+-v|read)\s+(?:-\w+\s+)*)['"]?[A-Za-z_]\w*\[[^\]\n]{0,200}\$\(/;

/** Whether the text sets a value that the shell will run as code later, or one that arithmetic evaluates. */
export const codeInValue = (text: string): boolean =>
  PROMPT_COMMAND.test(text) ||
  (PROMPT_STRING.test(text) && SUBSTITUTION.test(text)) ||
  SUBSCRIPT_CODE.test(text);
