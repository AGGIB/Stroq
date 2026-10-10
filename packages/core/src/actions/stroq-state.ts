/**
 * Known gaps, written down and left as they are. This reads the text of a command line, and an agent that can
 * run arbitrary code can write that text so that it is not read: the sandbox of `stroq run --sandbox`
 * (`run/sandbox.ts`) is the boundary, and this is one guard in front of it. Not read: the PowerShell call
 * operator (`& stroq untaint`, `& 'C:\npm\stroq.cmd' untaint`) and `cmd /c stroq …`; a subcommand that is not
 * in the command line, supplied on the input of `xargs` or `parallel` (`echo untaint | xargs stroq`); the
 * commands in a script run behind a launcher that is spelled with a path, `npx @stroq/cli` or `node …/index.js`
 * (`/usr/local/bin/stroq run -- bash x.sh`), because the readers of scripts know `stroq` as a launcher by its
 * bare name alone (`shell-wrappers.ts`); and arithmetic that shifts (`echo $((1<<3))`), whose `<<` `joinText`
 * takes for a heredoc, so that the lines after it are folded into the line of the command that stands there.
 * And outside this file: the hook entries in the host's own configuration (`settings.json`, `hooks.json`, the
 * plugin cache) are writable in the sandbox, so a program that none of this reads can switch the firewall off
 * from inside it.
 */
import { optionTakesValue } from './shell-wrappers.js';
import type { FunctionDefinition } from './inlined-functions.js';
import { joinText } from './join-text.js';
import { flattened } from './shell-names.js';
import { splitCommand, splitSegments, type SplitCommand } from './shell-segments.js';
import {
  LAUNCHERS,
  PASS_THROUGH,
  RUNNER_VALUE_FLAGS,
  RUNNER_VERBS,
  RUNNERS,
  STROQ_ENTRY,
  STROQ_PACKAGE,
  WRAPPERS,
  baseName,
  isExemptionFlag,
  subcommandChangesState,
} from './stroq-commands.js';
import { REDIRECT, resolve, withoutRedirects } from './shell-words.js';

/**
 * Stroq's own commands that change what it enforces: `untaint` clears a session's
 * taint, `trust <file>` waives the scan of a file, `init` and `uninstall` rewrite the
 * hooks. They touch no path the self-tamper gate protects — the state lives under
 * `~/.stroq` — so without this an agent could run them through Bash, in a tainted
 * session, and undo the decision that was about to stop it. They are the user's to
 * run, outside the agent. Asking how one works (`--help`, `-h`), `--dry-run`, `trust`
 * with no file and every reading command stay open. A flag asks only where it is an
 * argument of the command the agent typed: not behind a launcher, not in a comment, not
 * in the target of a redirect, not in a command line that holds the body of a heredoc.
 *
 * The commands that are still to come are listed ahead of their code, so that there is
 * no release in which an agent can run one: `harden apply|undo|forget` edit an agent's
 * settings, `prove` runs the live check, `add` and `remove` change what is installed,
 * `vet --online` goes to the network for a package, `task` starts a run under a permit,
 * and `permit extend|revoke` widen or end one. Their reading forms stay open (`harden`
 * alone or with `status`, `permit list`, `permit show`, `vet` without `--online`), and
 * so does any subcommand not named here: this is a list of what is denied, not of what
 * is allowed. It reads the text of a command line, so it is one guard among others and
 * can be spelled around; `run/sandbox.ts` lists the state in its `denyWrite` as another.
 *
 * Judged on the whole command rather than on the segments the self-tamper gate reads,
 * because those are cut at every newline: a commit message or a heredoc body with a
 * line that starts `stroq init` was a "command" there, and denied. `joinText` first
 * folds the newlines of text — a quoted argument, a heredoc fed to anything but a
 * shell — so only lines a shell would run are read as commands; a string handed to
 * `sh -c` or `eval`, and a heredoc fed to a shell, keep theirs.
 */
export function stroqStateSignals(command: string): string[] {
  const folded = joinText(command);
  return stateSignalsOf(splitSegments(folded.text), !folded.body);
}

/**
 * Whether a text names Stroq at all, as the words that run it are spelled (`stroq`, `@stroq/cli`, the entry of
 * a checkout). What does not is no command of it, and is not read for the commands it holds.
 */
const NAMES_STROQ = /stroq|packages[\\/]cli[\\/]dist[\\/]index\.js/i;
const namesStroq = (text: string): boolean =>
  NAMES_STROQ.test(text) || (/['"\\$`]/.test(text) && NAMES_STROQ.test(flattened(text)));

/**
 * `exempting`: whether a flag that asks for help may open a command at all. It may not where the body of a
 * heredoc was folded into the lines (`Folded.body`): its words stand beside the words of the commands there,
 * and a flag among them can be either's.
 */
function stateSignalsOf(segments: readonly string[], exempting: boolean): string[] {
  const assigned = assignments(segments);
  const reading: Reading = { depth: 0, exempting };
  return segments.some((segment) => runsStateCommand(segment, assigned, reading))
    ? ['stroq-state-change']
    : [];
}

/**
 * The same, read as part of the reading of a command that is classified: where the text with its line
 * breaks folded is the command itself (it holds no string or document that spans lines), its segments are
 * the ones that were already cut, and where it is not, it is read for the functions it calls with the room
 * that the command was given, and not with a room of its own: a text that is read again for each reader
 * is a cost that is paid again. `unread` says that a call is left in the folded text that was not read.
 */
export function stroqStateReading(
  command: string,
  split: SplitCommand,
  functions: readonly FunctionDefinition[] | null | undefined,
): { readonly signals: string[]; readonly unread: boolean } {
  // A text that none of the texts read from the command names is no command of Stroq: a name that a variable
  // is given by a substitution that prints it is written out in the text that the variable is replaced in.
  if (!namesStroq(command) && !split.texts.some(namesStroq)) return { signals: [], unread: false };
  const { text: folded, body } = joinText(command);
  // A text that is an approximation of a program (a script, read with its variables replaced) was not read for
  // its functions, and is for this: a function that wraps `stroq` is a way to run it, and it asks nothing.
  if (functions === null)
    return { signals: stateSignalsOf(splitSegments(folded), !body), unread: false };
  if (folded === command) return { signals: stateSignalsOf(split.segments, !body), unread: false };
  // What the folding changes is text: a string, a document that is written to a file. A function that stands in
  // it is no function of the shell (a plan of a few hundred lines has dozens), so the folded text is read for
  // functions only where the command has some of its own, as the command was read for them.
  const has = split.functions.length > 0 || (functions ?? []).length > 0;
  const own = splitCommand(folded, has ? functions : null, split.room);
  return { signals: stateSignalsOf(own.segments, !body), unread: own.functionsUnread };
}

const ASSIGNMENT = /^([A-Za-z_]\w*)=(\S*)$/;
const VARIABLE = /^\$\{?([A-Za-z_]\w*)\}?$/;

/** `NAME=value` words anywhere in the command, quotes removed: `S=stroq; $S untaint`. */
function assignments(segments: readonly string[]): ReadonlyMap<string, string> {
  const found = new Map<string, string>();
  for (const segment of segments)
    for (const word of words(segment)) {
      const match = ASSIGNMENT.exec(word);
      if (match) found.set(match[1] as string, match[2] as string);
    }
  return found;
}

const BLANK = /\s/;

/**
 * The segment's words, split at the blanks that stand outside a quote, with the quotes taken off and the
 * backslashes kept: Windows paths survive (`C:\npm\stroq.cmd`), which the reader of the shell cannot say, as it
 * takes a backslash for an escape. A quoted string is one word whatever it holds, so `"x -h"` is no `-h`. A quote
 * that is not closed holds the rest of the segment, as the shell has it.
 */
function words(segment: string): string[] {
  const found: string[] = [];
  let word = '';
  let quote = '';
  for (let i = 0; i < segment.length; i += 1) {
    const c = segment.charAt(i);
    if (quote !== '') {
      if (c === quote) quote = '';
      else word += c;
    } else if (c === '"' || c === "'") quote = c;
    else if (BLANK.test(c)) {
      if (word !== '') found.push(word);
      word = '';
    } else word += c;
  }
  if (word !== '') found.push(word);
  return found;
}

const isStroq = (word: string): boolean =>
  baseName(word) === 'stroq' || STROQ_PACKAGE.test(word) || STROQ_ENTRY.test(word);

/** Index of the word that is Stroq, when the segment runs it; -1 when it does not. */
function stroqAt(ws: readonly string[], assigned: ReadonlyMap<string, string>): number {
  let i = 0;
  while (i < ws.length) {
    const word = ws[i] as string;
    if (ASSIGNMENT.test(word)) i += 1;
    else if (WRAPPERS.has(baseName(word))) {
      const wrapper = baseName(word);
      i += 1;
      // The options of the wrapper, with the value of those that take one (`sudo -nu root stroq untaint`), and
      // the number that `timeout` takes.
      while (i < ws.length && /^-|^\d+[smhd]?$/.test(ws[i] as string)) {
        const option = ws[i] as string;
        i += 1;
        if (option.startsWith('-') && optionTakesValue(wrapper, option)) i += 1;
      }
    } else break;
  }
  const word = ws[i];
  if (word === undefined) return -1;
  const variable = VARIABLE.exec(word)?.[1];
  if (variable !== undefined) return isStroq(assigned.get(variable) ?? '') ? i : -1;
  // `$(which stroq) untaint`, `` `which stroq` untaint ``: the program is whatever the
  // substitution prints, and a substitution that names Stroq prints Stroq.
  if (word.startsWith('$(') || word.startsWith('`')) {
    const close = word.startsWith('$(') ? ')' : '`';
    for (let j = i; j < ws.length; j += 1) {
      const part = ws[j] as string;
      const ends =
        j === i ? part.slice(word.startsWith('$(') ? 2 : 1).includes(close) : part.includes(close);
      if (ends) return ws.slice(i, j + 1).some((w) => /\bstroq\b/.test(w)) ? j : -1;
    }
    return -1;
  }
  if (isStroq(word) && !RUNNERS.has(baseName(word))) return i;
  if (!RUNNERS.has(baseName(word))) return -1;
  // Whether the word is the value of an option that this does not know: `npx --tag next prettier`, where `next` is
  // no program. The program is the first word that is none, unless it stands right after an option, where it may be.
  let maybeValue = false;
  for (let j = i + 1; j < ws.length; j += 1) {
    const arg = ws[j] as string;
    // An option that takes a value, and `yarn workspace NAME`: the word after it is not the program.
    if (RUNNER_VALUE_FLAGS.has(arg) || arg === 'workspace' || arg === 'workspaces') {
      j += 1;
      maybeValue = false;
    } else if (arg.startsWith('-')) maybeValue = !arg.includes('=');
    else if (RUNNER_VERBS.has(arg)) maybeValue = false;
    else if (isStroq(arg)) return j;
    else if (maybeValue) maybeValue = false;
    else return -1;
  }
  return -1;
}

/**
 * What stands before the command of a segment and is not it: a group or a subshell that opens (`{ stroq
 * untaint; }`, `(stroq untaint)`), a keyword (`then stroq untaint`, `do stroq untaint`, `! stroq untaint`), the
 * head of a function (`f() { stroq untaint; }`, `function f {`), and the pattern of an arm of `case`
 * (`x) stroq untaint ;;`). A segment is cut at `;`, so each of these is where the command begins.
 */
const OPENING_WORDS: ReadonlySet<string> = new Set([
  '{',
  '(',
  '((',
  '!',
  'if',
  'then',
  'else',
  'elif',
  'while',
  'until',
  'do',
  'coproc',
]);
function afterOpeners(ws: readonly string[]): string[] {
  const rest = [...ws];
  while (rest.length > 0) {
    const word = rest[0] as string;
    if (OPENING_WORDS.has(word) || /^[^\s()]+\(\)$/.test(word) || /^[^\s()]*\)$/.test(word))
      rest.shift();
    else if (word === 'function') rest.splice(0, rest[2] === '()' ? 3 : 2);
    else if (word === 'case' && rest.includes('in')) rest.splice(0, rest.indexOf('in') + 1);
    else if (word.length > 1 && word.startsWith('(')) rest[0] = word.replace(/^\(+/, '');
    else break;
  }
  return rest;
}

/** A word of the arguments of a command that ends a group or a subshell: `untaint)`, `--all}`. */
function withoutClosers(word: string): string {
  // Not `word.replace(/[)}]+$/, '')`: for a word of many closers that ends in something else, that takes time
  // quadratic in its length (3 s at 64 KiB), and the hook runs it on whatever a command holds.
  let end = word.length;
  while (end > 0 && (word[end - 1] === ')' || word[end - 1] === '}')) end -= 1;
  return word.slice(0, end);
}

/**
 * `resolve` looks past `stroq run --` as it does past any launcher, to the program it starts. Here the launcher
 * is the command, read by `changesState` with its own flags and its operand, so it is not looked past.
 */
const LAUNCHED_BY_STROQ: ReadonlySet<string> = new Set(['stroq']);

/**
 * How many launchers are followed one behind another (`stroq run -- stroq run -- …`). Nobody
 * writes a chain of more than one or two, and one built to be too long to follow is the one to
 * stop: past this many the command is denied rather than let through unread.
 */
const MAX_LAUNCHER_DEPTH = 4;

/** How a segment is read: behind how many launchers it stands, and whether a flag may open the command. */
interface Reading {
  readonly depth: number;
  /**
   * A flag that asks for help (`--help`, `-h`, `--dry-run`) keeps a command open only in the command the agent
   * typed, so not behind a launcher, and not where the lines hold a heredoc body that was folded
   * (`Folded.body`).
   */
  readonly exempting: boolean;
}

/**
 * Whether a segment runs a command of Stroq that changes what it enforces. Read by its own words, past what
 * stands before a command (see `afterOpeners`), and by what the shell reads of it (`resolve`): past a
 * wrapper that this list does not know (`xargs`, `watch`, `stdbuf`, `builtin exec`), a redirect that stands
 * before the command (`> /dev/null stroq untaint`) and a function head. A segment that has no `stroq` in
 * it and no expansion that could make one is not read that way. `reading` says how many launchers it stands
 * behind and whether a flag may open it (see `changesState`).
 */
function runsStateCommand(
  segment: string,
  assigned: ReadonlyMap<string, string>,
  reading: Reading,
): boolean {
  if (changesState(afterOpeners(words(segment)), assigned, reading)) return true;
  if (!namesStroq(segment) && !/[$`]/.test(segment)) return false;
  const found = resolve(segment, LAUNCHED_BY_STROQ);
  if (found === null || found.word === '') return false;
  const rest = withoutRedirects(found.args).map((word) => word.value);
  return changesState([found.word, ...rest], assigned, reading);
}

/**
 * Whether the command whose words are `ws` is a command of Stroq that changes state.
 *
 * A command that hands its words on (`PASS_THROUGH`) has only the words before its `--` for its own, and the
 * exemption flags count among those alone: the CLI reads them so (`ownArgs` in `help.ts`), and `stroq task --
 * "fix --help"` starts a task. A launcher (`run`, `mcp`) starts the program after its `--`, which is judged by
 * the command it names: `stroq run -- stroq prove` changes state, `stroq run -- claude` does not. The operand is
 * read again as a command line of its own, so every wrapper, runner and spelling known for a command is known
 * behind a launcher, and launchers behind launchers are followed to `MAX_LAUNCHER_DEPTH`. A string handed to a
 * shell (`stroq run -- sh -c '…'`) is read with the segments of the command, as it is without a launcher.
 *
 * No exemption flag counts behind a launcher (`Reading.exempting`), whoever wrote it where. The operand is put
 * together again from words that were split on blanks with their quotes taken off, so an argument that holds a
 * flag among other words (`stroq run -- stroq uninstall --client "x -h"`) comes back as a flag that the program
 * is never given, and a command that runs would be read as a request for help. A request for help is made to
 * the command the agent typed, and `stroq prove --help` is open without the launcher.
 *
 * And a flag counts only among the arguments of the command, which the words of a line are not all: what a
 * comment holds (`stroq untaint --all # --help`) is dropped by the shell, and the body of a heredoc is text
 * that is given to a command on its input (`Folded.body`). In both the command runs.
 *
 * What is not followed: a program that an expansion makes into Stroq, where the command does not set it
 * (`stroq run -- $PROGRAM prove`, with `PROGRAM` from the environment), as for any command; and the body of a
 * script run behind a launcher spelled any way but the bare name (`/usr/local/bin/stroq run -- bash x.sh`,
 * `npx @stroq/cli run -- bash x.sh`), because the readers of scripts find the command through the table of
 * `shell-wrappers.ts`, where `stroq` is known by that name alone. The state commands in such a script are
 * not read there as they are behind `uv run` or the bare `stroq run`.
 */
function changesState(
  ws: readonly string[],
  assigned: ReadonlyMap<string, string>,
  reading: Reading,
): boolean {
  const at = stroqAt(ws, assigned);
  if (at === -1) return false;
  const after = ws.slice(at + 1);
  // The words as the subcommand sees them, with the closers of a group or a substitution that ends the
  // command taken off the last (`untaint)`); `after` keeps them, for an operand that is read as a command.
  const words = after.map(withoutClosers);
  const subAt = words.findIndex((word) => word !== '' && !word.startsWith('-'));
  const sub = words[subAt];
  const dashes = sub !== undefined && PASS_THROUGH.has(sub) ? words.indexOf('--', subAt + 1) : -1;
  const own = (dashes === -1 ? words : words.slice(0, dashes)).filter(
    (word) => word !== '--' && word !== '',
  );
  if (reading.exempting && asksForHelp(own)) return false;
  if (sub === undefined) return false;
  if (LAUNCHERS.has(sub)) {
    const operand = dashes === -1 ? [] : after.slice(dashes + 1);
    if (operand.length === 0) return false;
    return (
      reading.depth >= MAX_LAUNCHER_DEPTH ||
      runsStateCommand(operand.join(' '), assigned, { depth: reading.depth + 1, exempting: false })
    );
  }
  return subcommandChangesState(sub, own);
}

/**
 * Whether the arguments of a command ask for help or for a dry run. Not every word of a line is an argument.
 * What follows a word that begins with `#` is a comment, which the shell drops. The target of a redirect is a
 * file, not an argument (`stroq untaint --all > --help` writes one): where a word is the operator alone, the
 * word after it is the target. A quoted `"#x"` or `">"` is taken for either as well, which can only keep a
 * command that is asked about asked about: the quotes are off the words, and which of them were quoted is
 * no longer known.
 */
function asksForHelp(own: readonly string[]): boolean {
  for (let i = 0; i < own.length; i += 1) {
    const word = own[i] as string;
    if (word.startsWith('#')) return false;
    const redirect = REDIRECT.exec(word);
    if (redirect !== null) {
      if (redirect[0].length === word.length) i += 1;
    } else if (isExemptionFlag(word)) return true;
  }
  return false;
}
