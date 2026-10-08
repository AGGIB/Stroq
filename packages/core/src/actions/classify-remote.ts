import type { ActionClass } from '../types.js';
import type { ClassifyOptions, CommandGroups } from './classify-bash.js';
import { isDangerousRmTarget } from './dangerous-target.js';
import type { TextTest } from './followed-by.js';
import type { FunctionRoom } from './function-readings.js';
import { normalizePathForMatch } from './normalize-path.js';
import type { Budget, ShellInput } from './shell-input.js';
import { commandWord, splitCommand, tokenize } from './shell-segments.js';

/**
 * What a command sent over `ssh` is: the text after the host, read in the shell syntax of the
 * machine it runs on, and judged by what is routine on a server. Both the typed form
 * (`ssh prod 'docker rmi x'`) and the program a shell that `ssh` started is handed
 * (`echo 'docker rmi x' | ssh prod sh`) come to the same questions, asked here.
 */

/** Classifies a text as a command: the reader of commands, handed in so that this does not import it. */
export type Classifier = (
  text: string,
  cwd: string,
  depth: number,
  options: ClassifyOptions,
) => CommandGroups;

/**
 * The letters of the `ssh` options that take a value. In a cluster (`-tp 22`) the first
 * one ends it: what follows in the same word is its value (`-p22`), and when nothing does
 * the value is the next word.
 */
const SSH_VALUE_LETTERS: ReadonlySet<string> = new Set('pilFJLRDbcEeImOQSWwBo');

/** Most `ssh` invocations in one command that are read, and the most text of each. */
const MAX_SSH_INVOCATIONS = 16;
const MAX_REMOTE_CHARS = 32 * 1024;
/** A word, with a quoted span kept whole: `-o "A b"` is one option and one value. */
const SHELL_WORD = /(?:"[^"]*"|'[^']*'|\S)+/g;
const REMOTE_COMMAND_END = /[;\n|&]/;

/**
 * The command a remote shell is given by the `ssh` that starts at `from` in `text`: what
 * follows the host, in the quotes it was given in when it was quoted (`ssh prod "a | b"`
 * is one command to the remote side, though its `|` is no pipe to the local shell) and
 * up to the next local operator when it was not. The second value is whether the text
 * went on past what is read.
 */
function remoteAfterHost(text: string, from: number): readonly [string | null, boolean] {
  SHELL_WORD.lastIndex = from;
  let sawSsh = false;
  let skipValue = false;
  let optionsEnded = false;
  for (let word = SHELL_WORD.exec(text); word !== null; word = SHELL_WORD.exec(text)) {
    const token = word[0];
    if (!sawSsh) {
      sawSsh = token.replace(/^.*\//, '') === 'ssh';
      continue;
    }
    if (skipValue) {
      skipValue = false;
      continue;
    }
    if (!optionsEnded && token === '--') {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && token.startsWith('-')) {
      const letters = token.slice(1);
      for (let i = 0; i < letters.length; i += 1) {
        if (SSH_VALUE_LETTERS.has(letters.charAt(i))) {
          skipValue = i === letters.length - 1;
          break;
        }
      }
      continue;
    }
    const after = word.index + token.length;
    const window = text.slice(after, after + MAX_REMOTE_CHARS + 1);
    const rest = window.trimStart();
    const quote = rest.charAt(0);
    if (quote === '"' || quote === "'") {
      let close = 1;
      while (close < rest.length && rest.charAt(close) !== quote) {
        close += quote === '"' && rest.charAt(close) === '\\' ? 2 : 1;
      }
      return [rest.slice(1, close), close >= MAX_REMOTE_CHARS];
    }
    const stop = rest.search(REMOTE_COMMAND_END);
    const remote = (stop === -1 ? rest : rest.slice(0, stop)).trim();
    return [remote === '' ? null : remote, stop === -1 && rest.length > MAX_REMOTE_CHARS];
  }
  return [null, false];
}

interface RemoteCommands {
  readonly commands: readonly string[];
  /** True when an `ssh` was left unread: past the invocation limit, or a command past the text limit. */
  readonly truncated: boolean;
}

/**
 * What a remote shell is told to run: the words after the host of an `ssh` invocation, as
 * one command. A command sent over `ssh` runs on someone else's machine, usually a
 * production one, and its text is written in the same shell syntax as a local one — so it
 * is read as one (claude-code #94579: `ssh prod docker rmi <image>` removed the
 * production image). Read from the command itself where the segment is a part of it,
 * because the segments are cut at every `|`, quoted or not.
 */
function remoteCommands(command: string, segments: readonly string[]): RemoteCommands {
  const commands: string[] = [];
  let searchFrom = 0;
  let seen = 0;
  let truncated = false;
  for (const segment of segments) {
    const word = commandWord(segment);
    if (word !== 'ssh' && word !== 'sshpass') continue;
    seen += 1;
    if (seen > MAX_SSH_INVOCATIONS) {
      truncated = true;
      break;
    }
    const at = command.indexOf(segment, searchFrom);
    if (at !== -1) searchFrom = at + segment.length;
    const [remote, cut] = at === -1 ? remoteAfterHost(segment, 0) : remoteAfterHost(command, at);
    if (cut) truncated = true;
    if (remote !== null && remote !== '') commands.push(remote);
  }
  return { commands, truncated };
}

/**
 * What is routine to run locally and not on a production server: removing an image,
 * pruning, and a recursive delete of anything but a scratch directory. (A volume's data is
 * asked about wherever it is removed; see `DESTRUCTIVE`.) Stopping a service, rebooting
 * and removing one file are an administrator's day, and a question for each would be the
 * check people switch off.
 */
const REMOTE_DESTRUCTIVE: ReadonlyArray<readonly [TextTest, string]> = [
  [
    /\bdocker(?:-compose)?\s+(?:rmi|system\s+prune|volume\s+(?:rm|prune)|(?:container|image)\s+(?:rm|prune)|compose\s+down\s+(?:\S+\s+)*-v)\b/,
    'remote-destructive',
  ],
];

const REMOTE_CLASSES: ReadonlySet<ActionClass> = new Set<ActionClass>([
  'shell.exec_encoded',
  'shell.destructive',
]);

const REMOTE_SCRATCH = /^(?:\/var)?\/tmp\//;

/**
 * A recursive `rm` on a server, aimed anywhere but `/tmp`. A name that is not absolute is
 * relative to the directory an earlier `cd` of the same command moved into, so the
 * question is where that is; with no `cd` it is the login directory, as a local relative
 * name is the project, and passes. The path is collapsed first: `/tmp/../var/www` is not
 * in `/tmp`.
 */
function remoteRmIsDangerous(segment: string, directory: string | null): boolean {
  const tokens = tokenize(segment);
  const at = tokens.findIndex((t) => t.replace(/^.*\//, '') === 'rm');
  if (at < 0) return false;
  const args = tokens.slice(at + 1);
  const recursive = args.some(
    (a) => a === '--recursive' || (/^-[A-Za-z]+$/.test(a) && /[rR]/.test(a)),
  );
  if (!recursive) return false;
  return args
    .filter((a) => !a.startsWith('-'))
    .some((a) => {
      const target = a.replace(/["']/g, '');
      const relative = !/^[/~$]/.test(target);
      const full = relative && directory !== null ? `${directory}/${target}` : target;
      const dangerous =
        isDangerousRmTarget(target, '/__remote__') ||
        (relative && directory !== null && isDangerousRmTarget(full, '/__remote__'));
      return dangerous && !REMOTE_SCRATCH.test(normalizePathForMatch(full));
    });
}

/** The directory a remote `cd` leaves the command in; a relative one only extends a known directory. */
function remoteDirectoryAfter(segment: string, directory: string | null): string | null {
  if (commandWord(segment) !== 'cd') return directory;
  const target = segment
    .split(/\s+/)
    .slice(1)
    .find((w) => w !== '' && !w.startsWith('-'))
    ?.replace(/["']/g, '');
  if (target === undefined) return directory;
  if (/^[/~$]/.test(target)) return target;
  return directory === null ? null : `${directory}/${target}`;
}

/**
 * The signal that says an `rm` target is outside the project: a question about THIS machine's
 * checkout, which the remote's own rules ask again (below), with `/tmp` allowed. Also as a
 * program read from a pipe or a here-string carries it.
 */
const LOCAL_TARGET_SIGNAL = /^(?:shell-input:)?rm-dangerous-target$/;

/** What a command that runs on a server is: the classes that mean the same there, and its own rules for a delete. */
export function remoteTextClassification(
  text: string,
  cwd: string,
  depth: number,
  budget: Budget,
  add: (cls: ActionClass, signal: string) => void,
  classify: Classifier,
  decoded?: ShellInput,
  room?: FunctionRoom,
): void {
  // The functions of the machine that sends the command are not in force on the one it is sent to, but what
  // reading them costs is spent from the same room.
  const options: ClassifyOptions = {
    budget,
    ...(decoded === undefined ? {} : { decoded }),
    ...(room === undefined ? {} : { room }),
  };
  for (const [cls, signals] of classify(text, cwd, depth + 1, options).groups) {
    if (!REMOTE_CLASSES.has(cls)) continue;
    const own = signals.filter((signal) => !LOCAL_TARGET_SIGNAL.test(signal));
    if (own.length > 0) add(cls, own[0] as string);
  }
  let directory: string | null = null;
  for (const seg of splitCommand(text, [], room).segments) {
    directory = remoteDirectoryAfter(seg, directory);
    for (const [test, name] of REMOTE_DESTRUCTIVE)
      if (test.test(seg)) add('shell.destructive', name);
    if (remoteRmIsDangerous(seg, directory)) add('shell.destructive', 'remote-rm-recursive');
  }
}

export function remoteClassification(
  command: string,
  segments: readonly string[],
  cwd: string,
  depth: number,
  budget: Budget,
  classify: Classifier,
  room?: FunctionRoom,
): ReadonlyArray<readonly [ActionClass, readonly string[]]> {
  if (depth >= 2) return [];
  const found = new Map<ActionClass, string[]>();
  const add = (cls: ActionClass, signal: string): void => {
    found.set(cls, [...(found.get(cls) ?? []), `ssh-remote:${signal}`]);
  };
  const remote = remoteCommands(command, segments);
  // A command that could not be read to its end is not a command that is safe.
  if (remote.truncated) add('shell.unparsed', 'too-large');
  for (const text of remote.commands)
    remoteTextClassification(text, cwd, depth, budget, add, classify, undefined, room);
  return [...found.entries()];
}
