import type { Lexed } from './shell-lex.js';
import { readWords, resolve, type Word } from './shell-words.js';

/**
 * The command lines that a command hands to a tool that runs them through a shell, written out in the
 * command: `git rebase -x 'make test'`, `git difftool --extcmd=…`, `git grep -O'less'`, and the variables
 * whose value is one (`GIT_SSH_COMMAND='ssh -i key'`, `EDITOR=…`, `PAGER=…`). What they hold is what
 * runs, so it is read as a command of its own, as the argument of `eval` and of `git bisect run` is.
 * A value that is made as the command runs (`"$cmd"`) is read as the word it is, and not followed.
 */

/** Variables whose value is a command line a tool runs: the editor, the pager, the ssh, the askpass. */
const COMMAND_VARIABLE =
  /^(?:GIT_(?:SSH_COMMAND|SSH|PROXY_COMMAND|EXTERNAL_DIFF|EDITOR|SEQUENCE_EDITOR|ASKPASS|PAGER)|SSH_ASKPASS|EDITOR|VISUAL|PAGER|BROWSER)\+?=([\s\S]+)$/;

/** Where such a variable may be set, and where a git command that takes a command line may be: looked for first. */
const VARIABLE_HINT =
  /_COMMAND\+?=|EDITOR\+?=|PAGER\+?=|BROWSER\+?=|ASKPASS\+?=|GIT_SSH\+?=|EXTERNAL_DIFF\+?=|VISUAL\+?=/;
const GIT_WORD = /\bgit\b/;
const GIT_SUBCOMMAND_HINT = /\b(?:rebase|difftool|grep)\b/;

interface CommandOption {
  /** The letter of the short option, and the name of the long one. */
  readonly short: string;
  readonly long: string;
  /** The value is only ever glued to the option: `-Oless`, `--open-files-in-pager=less`. */
  readonly attached: boolean;
}

/** The git commands that take a command line as the value of an option, and the option. */
const COMMAND_OPTIONS: ReadonlyMap<string, CommandOption> = new Map([
  ['rebase', { short: 'x', long: 'exec', attached: false }],
  ['difftool', { short: 'x', long: 'extcmd', attached: false }],
  ['grep', { short: 'O', long: 'open-files-in-pager', attached: true }],
]);

/** The values given for the command-line option of one git command. */
function optionValues(option: CommandOption, args: readonly Word[]): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const word = args[i] as Word;
    if (word.redirect) continue;
    const value = word.value;
    if (value === '--') break;
    const next = args[i + 1];
    if (value.startsWith('--')) {
      const eq = value.indexOf('=');
      const spelled = value.slice(2, eq === -1 ? undefined : eq);
      // `git` takes the start of a long option for it where that is not ambiguous.
      if (spelled.length < 2 || !option.long.startsWith(spelled)) continue;
      if (eq !== -1) values.push(value.slice(eq + 1));
      else if (!option.attached && next !== undefined) {
        values.push(next.value);
        i += 1;
      }
    } else if (value.startsWith('-') && value.length > 1) {
      // A cluster of short options: the letter takes the rest of the word, or the next word.
      const at = value.indexOf(option.short, 1);
      if (at === -1) continue;
      const rest = value.slice(at + 1);
      if (rest !== '') values.push(rest);
      else if (!option.attached && next !== undefined) {
        values.push(next.value);
        i += 1;
      }
    }
  }
  return values.filter((text) => text.trim() !== '');
}

/** The command lines the stages of a text give to a tool that runs them (see above). */
export function toolCommandBodies(text: string, lexed: Lexed): string[] {
  // Asked of the text as the shell reads its words: `re"base"` is `rebase`.
  const plain = text.replace(/['"\\]/g, '');
  const variables = VARIABLE_HINT.test(plain);
  const git = GIT_WORD.test(plain) && GIT_SUBCOMMAND_HINT.test(plain);
  if (!variables && !git) return [];
  const bodies: string[] = [];
  for (const pipeline of lexed.pipelines)
    for (const stage of pipeline) {
      if (variables)
        for (const word of readWords(stage.text).words) {
          const body = COMMAND_VARIABLE.exec(word.value)?.[1];
          if (body !== undefined) bodies.push(body);
        }
      if (!git) continue;
      const command = resolve(stage.text);
      if (command?.name !== 'git') continue;
      // Any word that names the subcommand: an option of `git` that takes a value and that is not known
      // (`--attr-source HEAD rebase`) would put the wrong word where the subcommand is.
      const named = new Set(
        command.args.filter((word) => !word.value.startsWith('-')).map((word) => word.value),
      );
      for (const [subcommand, option] of COMMAND_OPTIONS)
        if (named.has(subcommand)) bodies.push(...optionValues(option, command.args));
    }
  return bodies;
}
