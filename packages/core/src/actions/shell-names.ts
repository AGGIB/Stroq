import { followedBy } from './followed-by.js';
import { decodeEscapes, stdinPath } from './shell-escapes.js';
import { SHELL_STARTERS, SHELL_WORDS, SHELL_WORD_ANYWHERE } from './shell-lex.js';
import { launchedLine } from './shell-launchers.js';
import { clusterValue, gluedValue } from './shell-wrappers.js';
import { REDIRECT, baseOf, resolve, type Resolved, type Word } from './shell-words.js';

/**
 * Which commands are shells, and whether a text could hand one a program at all: the names a shell
 * goes by (the shells, `su`, `ssh`, a copy under another name, a glob that matches one), and the
 * cheap tests that say a text is not worth reading for a program because nothing in it could be one.
 */

/** A `-c` string that is only the placeholder `xargs` or `parallel` fills in. */
export const PLACEHOLDER_PROGRAM = /^(?:\{\}|%|\$@|\$\*)$/;
/** `/dev/stdin`, `/dev/fd/3`, `/proc/self/fd/0`: a path that may name a standard input. */
const STDIN_PATH_ANYWHERE = /\/(?:dev|proc)\/[^\s;&|]{0,64}?(?:stdin|fd\/)/;
/** `source <(…)` and `. <(…)`: a program from a command's output, with no shell word in sight. */
const PROCESS_SOURCE = /(?:^|[\s;&|({])(?:source|\.)\s+(?:--\s+)?[<=]\(/;
/**
 * `eval` and `trap` run a string as a command line, with no shell word in sight, and `parallel` runs the lines it is
 * given as the arguments of the command it is told: each takes a program from where it is given one.
 */
const READS_A_PROGRAM = /\b(?:eval|trap|parallel)\b/;
/**
 * The commands that hand a line of their own to a shell (`watch 'cmd'`, `entr -s 'cmd'`, `script -c 'cmd'`, `sg group
 * 'cmd'`, `runuser -l user -c 'cmd'`, `nix-shell --run 'cmd'`, `nix develop -c cmd`, `tmux new-session -d 'cmd'`,
 * `screen -dmS name cmd`, `nodemon --exec 'cmd'`, `concurrently 'cmd'`, `osascript -e 'do shell script "cmd"'`): the
 * line is a program, and what is piped into the shell that mentions one is not.
 */
const RUNS_A_STRING_OF_ITS_OWN =
  /\b(?:watch|entr|script|sg|runuser|nix-shell|nix|tmux|screen|nodemon|concurrently|osascript|capsh)\b/;
/**
 * `npx -c 'cmd'`, `npm exec --call 'cmd'`, an editor told to run a line (`vim -es -c '!cmd'`, `ex '+!cmd'`), and the
 * options of `rg` and `fd` that give a command to run (`rg --pre cmd`, `fd -x cmd`): the program, and the option that
 * makes it run a string. Each is looked for on its own, in the text as a whole, so that this stays linear: a pattern
 * that looks for the option after the program in the same stage backtracks over the rest of the line at every
 * repeat of the program (`npx npx npx …`), and that is quadratic. It says only that a text may hand a shell its
 * program; the reading says whether it does.
 */
const RUNS_A_STRING_BY_OPTION: ReadonlyArray<readonly [RegExp, RegExp]> = [
  [/\brg\b/, /\s--pre\b/],
  [/\bfd\b/, /\s(?:-[A-Za-z]*[xX]|--exec)/],
  [/\bnpx\b/, /\s(?:-[A-Za-z]*c|--call)/],
  [/\b(?:npm|pnpm|yarn|bun)\s+(?:exec|x|dlx)\b/, /\s(?:-[A-Za-z]*c|--call)/],
  [/\b(?:vim|vi|nvim|ex|view|vimdiff)\b/, /\s-[A-Za-z]*c|\s--cmd|\s\+/],
];
const runsAStringByOption = (text: string): boolean =>
  RUNS_A_STRING_BY_OPTION.some(([program, option]) => program.test(text) && option.test(text));
/**
 * The variables that hold a shell: `$SHELL`, `${BASH}`, `$0`, and zsh's name for itself, `${(%):-%N}`.
 * Another variable is not asked about.
 */
export const SHELL_VARIABLE = /\$\{?(?:SHELL|BASH|SH|ZSH_NAME|ZSH_ARGZERO|0)\b|\(%\):-%[Nx0]/;
/** A shell given a name to be run by: `X=bash`, `S=$(command -v zsh)`. */
export const ASSIGNED_SHELL = new RegExp(
  `(?:\\b[A-Za-z_]\\w*\\+?=|:=|\\bread\\b[^;\\n|&]{0,32}?<<<|\\bfor\\s+[A-Za-z_]\\w*\\s+in\\b|\\bset\\s+--|\\bprintf\\s+-v\\b)[^;\\n|&]{0,64}?\\b(?:${[...SHELL_WORDS].join('|')})\\b`,
  'i',
);
/** Whether the text defines or aliases `echo` or `printf`, so that they print what it says. */
export const OVERRIDES_PRINTERS =
  /\b(?:echo|printf)\s*\(\s*\)|\bfunction\s+(?:echo|printf)\b|\balias\s+(?:echo|printf)=|\benable\s+-n\b/;
/** `sudo -s` and `sudo -i`: a shell, though no shell word is written. */
export const SUDO_SHELL = followedBy(
  /\bsudo\b/i,
  /\s(?:-[A-Za-z]*[si][A-Za-z]*|--shell|--login)(?=[\s;|&)<>]|$)/,
  'command',
);
/** `flock FILE -c 'cmd'` runs the string with a shell, though no shell word is written. */
export const FLOCK_SHELL = followedBy(/\bflock\b/i, /\s(?:-[A-Za-z]*c|--command)/, 'command');
/** A word that may be a glob or an expansion, and a pipe or a redirect that may feed it. */
const MAY_FEED = /[|<]/;
const EXPANDING = /[*?[$`=]/;
/** An option that gives a shell a string to run, beside a word that may name one: `/bin/ba?h -c '…'`. */
const STRING_OPTION = /\s-[A-Za-z]*c(?:\s|$)/;

/** The options of `ssh` whose next word is their value, not the host. */
const SSH_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '-b',
  '-c',
  '-D',
  '-E',
  '-e',
  '-F',
  '-I',
  '-i',
  '-J',
  '-L',
  '-l',
  '-m',
  '-O',
  '-o',
  '-p',
  '-Q',
  '-R',
  '-S',
  '-W',
  '-w',
]);

/**
 * The words of the command an `ssh` runs on the other machine: none when it is given none (it starts
 * the login shell), and null when no host can be found. The options that take a value are skipped.
 */
export function sshRemoteWords(command: Resolved): readonly Word[] | null {
  const plain = command.args.filter((word, i, all) => {
    if (!word.redirect) {
      // The target of a redirect that stands alone is not a word of the command.
      const before = all[i - 1];
      return !(
        before?.redirect === true &&
        /^(?:\d+|&)?(?:<<<|<<-|<<|<&|<>|<|>>|>&|>\||>)$/.test(before.value)
      );
    }
    return false;
  });
  let at = 0;
  while (at < plain.length) {
    const value = (plain[at] as Word).value;
    if (value === '--') {
      at += 1;
      break;
    }
    if (!value.startsWith('-')) break;
    at += SSH_VALUE_OPTIONS.has(value) ? 2 : 1;
  }
  return plain[at] === undefined ? null : plain.slice(at + 1);
}

/**
 * The shell an `ssh` starts on the other machine and its words, or null when it runs something
 * else: with no command it is the login shell, which reads its input, and with a shell for a
 * command (`ssh host sh`, `ssh host 'bash -s'`) it is that shell. The redirects on the `ssh`
 * itself feed it, so they are kept.
 */
function remoteShell(
  command: Resolved,
  aliases: ReadonlySet<string>,
  depth: number,
): readonly Word[] | null {
  const redirects: Word[] = [];
  const plain: Word[] = [];
  const words = command.args;
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i] as Word;
    if (!word.redirect) plain.push(word);
    else {
      redirects.push(word);
      const match = REDIRECT.exec(word.value);
      const target = words[i + 1];
      if (match !== null && word.value.length === match[0].length && target !== undefined) {
        redirects.push(target);
        i += 1;
      }
    }
  }
  let at = 0;
  while (at < plain.length) {
    const value = (plain[at] as Word).value;
    if (value === '--') {
      at += 1;
      break;
    }
    if (!value.startsWith('-')) break;
    at += SSH_VALUE_OPTIONS.has(value) ? 2 : 1;
  }
  if (plain[at] === undefined) return null;
  const run = plain.slice(at + 1);
  if (run.length === 0) return redirects;
  // What it runs is read as a command line in turn, a few `ssh` deep: past that, whatever it
  // runs is taken for a shell that reads its input, which asks about anything it cannot read.
  if (depth >= MAX_REMOTE_DEPTH) return redirects;
  const inner = resolve(run.map((w) => w.value).join(' '));
  const args = inner === null ? null : shellOf(inner, aliases, depth + 1);
  return args === null ? null : [...redirects, ...args];
}

/** How many `ssh` are read one inside another: `ssh a ssh b ssh c sh`. */
const MAX_REMOTE_DEPTH = 3;

const plainWord = (value: string, expands = false): Word => ({
  value,
  quoted: false,
  redirect: false,
  group: false,
  expands,
});

/** What follows `sg` when it is ast-grep and no group: its subcommands, and its options. */
const AST_GREP = /^(?:run|scan|test|new|lsp|completions|help|-.*)$/;
/** `npm exec -c 'cmd'`, `pnpm exec -c`, `npx -c`: the string is run by a shell. */
const PACKAGE_RUNNERS: ReadonlySet<string> = new Set(['npm', 'pnpm', 'yarn', 'bun']);
/** Editors that run a line with a shell where it begins with `!`: `vim -es -c '!cmd'`, `ex '+!cmd'`. */
const EDITORS: ReadonlySet<string> = new Set(['vim', 'vi', 'nvim', 'ex', 'view', 'vimdiff']);
/** The line that an editor is told to run with a shell: the command of `-c` or `+` that begins with `!`. */
function editorShellLine(args: readonly Word[]): string | null {
  for (let i = 0; i < args.length; i += 1) {
    const word = args[i] as Word;
    // `-c '!cmd'`, `-esc '!cmd'`, `-c'!cmd'`, `--cmd '!cmd'`, `+'!cmd'`.
    const given =
      /^-[A-Za-z]*c$/.test(word.value) || word.value === '--cmd'
        ? args[i + 1]?.value
        : (gluedValue('vim', word.value, 'c') ??
          (word.value.startsWith('+') ? word.value.slice(1) : undefined));
    const escape = given === undefined ? null : /^:?\s*(?:silent!?\s*)?!\s*(.+)$/s.exec(given);
    if (escape !== null) return escape[1] as string;
  }
  return null;
}

/**
 * The string that one of the commands that run a line with a shell is given, as the words of `sh -c LINE`: `su root
 * -c 'cmd'` (the option may stand after the user), `su --command=cmd`, `script -qc 'cmd' file`, `entr -s 'cmd'`,
 * `sg staff 'cmd'`. Null where the command is none of them, or has no string.
 */
function commandStringOf(command: Resolved): readonly Word[] | null {
  const name = command.name;
  // `sg group cmd` (the group's shell runs the line); not ast-grep's `sg run -p x`, `sg scan`, `sg --pattern x`.
  if (name === 'sg' && !AST_GREP.test(command.args[0]?.value ?? '-')) {
    const line = command.args.filter((w) => !w.redirect).slice(1);
    const text = line[0]?.value === '-c' ? line.slice(1) : line;
    return text.length === 0
      ? null
      : [
          plainWord('-c'),
          plainWord(
            text.map((w) => w.value).join(' '),
            text.some((w) => w.expands),
          ),
        ];
  }
  const editor = EDITORS.has(name) ? editorShellLine(command.args) : null;
  if (editor !== null) return [plainWord('-c'), plainWord(editor)];
  const launched = launchedLine(command);
  if (launched !== null) return [plainWord('-c'), plainWord(launched.line, launched.expands)];
  // `nix develop -c cmd args`, `nix shell nixpkgs#x --command cmd args`: what follows the option is run.
  if (name === 'nix' && /^(?:develop|shell)$/.test(command.args[0]?.value ?? '')) {
    const at = command.args.findIndex((w) => !w.redirect && /^(?:-c|--command)$/.test(w.value));
    const line = at === -1 ? [] : command.args.slice(at + 1).filter((w) => !w.redirect);
    return line.length === 0
      ? null
      : [
          plainWord('-c'),
          plainWord(
            line.map((w) => w.value).join(' '),
            line.some((w) => w.expands),
          ),
        ];
  }
  const runsPackage =
    name === 'npx' ||
    (PACKAGE_RUNNERS.has(name) && /^(?:exec|x|dlx)$/.test(command.args[0]?.value ?? ''));
  const flag =
    name === 'su' || name === 'runuser' || name === 'script' || runsPackage
      ? 'c'
      : name === 'entr'
        ? 's'
        : null;
  if (flag === null && name !== 'nix-shell') return null;
  const args = command.args;
  // The options of a package runner and of `entr` come before what it runs: a later `-c` is the program's
  // (`npx prettier -c .` checks, `npx eslint -c config.json` names a file). `su` and `script` take theirs
  // after a user or a file as well.
  const optionsFirst = runsPackage || name === 'entr';
  for (let i = 0; i < args.length; i += 1) {
    const word = args[i] as Word;
    if (word.redirect) continue;
    if (optionsFirst && /^(?:-p|--package)$/.test(word.value)) {
      i += 1;
      continue;
    }
    if (optionsFirst && !word.value.startsWith('-') && !/^(?:exec|x|dlx)$/.test(word.value)) break;
    const inline = /^--(?:command|shell-command|call|session-command)=(.*)$/s.exec(word.value);
    if (name !== 'entr' && inline !== null)
      return [plainWord('-c'), plainWord(inline[1] as string, word.expands)];
    // `su -c'cmd'`, `script -qc'cmd'`: the string is glued to the option.
    const glued = flag !== null && flag !== 's' ? gluedValue(name, word.value, flag) : null;
    if (glued !== null) return [plainWord('-c'), plainWord(glued, word.expands)];
    // `entr` has no option that takes a value, so its `-s` stands anywhere in a word of options (`-rs`, `-sd`);
    // the others take the string with the option, which then ends the word.
    const cluster =
      flag !== null &&
      /^-[A-Za-z]+$/.test(word.value) &&
      (name === 'entr' ? word.value.includes(flag) : word.value.endsWith(flag));
    const long =
      name !== 'entr' &&
      (word.value === '--command' ||
        word.value === '--shell-command' ||
        word.value === '--call' ||
        word.value === '--session-command' ||
        (name === 'nix-shell' && word.value === '--run'));
    const next = args[i + 1];
    if ((cluster || long) && next !== undefined)
      return [plainWord('-c'), plainWord(next.value, next.expands)];
  }
  return null;
}

/** The commands that start the shell of another user or group, given a name and no command: `su root`, `newgrp wheel`. */
const STARTS_A_SHELL_FOR: ReadonlySet<string> = new Set(['su', 'runuser', 'newgrp']);
/** The options of those that take the word after them. */
const USER_COMMAND_VALUES: ReadonlySet<string> = new Set([
  '-s',
  '--shell',
  '-g',
  '--group',
  '-G',
  '--supp-group',
  '-w',
  '--whitelist-environment',
]);

/** The words of `su root -s /bin/sh` without the user and the values of the options: what the shell is given. */
function withoutUser(command: string, args: readonly Word[]): readonly Word[] {
  const kept: Word[] = [];
  let named = false;
  for (let i = 0; i < args.length; i += 1) {
    const word = args[i] as Word;
    if (word.redirect) {
      kept.push(word);
      // A redirect that stands alone is followed by its target.
      const target = args[i + 1];
      if (target !== undefined && REDIRECT.exec(word.value)?.[0].length === word.value.length) {
        kept.push(target);
        i += 1;
      }
      continue;
    }
    if (word.value.startsWith('-')) {
      // The options of `su` that name a shell or a group are not for the shell it starts, with their values:
      // `-s csh`, `-scsh`, `-ls csh`.
      const given = USER_COMMAND_VALUES.has(word.value)
        ? 'next'
        : clusterValue(command, word.value);
      if (given === 'next') i += 1;
      if (given === null) kept.push(word);
      continue;
    }
    if (!named) {
      named = true;
      continue;
    }
    kept.push(word);
  }
  return kept;
}

/** The shell a stage runs and its words, or null when the stage is no shell. */
export function shellOf(
  command: Resolved,
  aliases: ReadonlySet<string>,
  depth = 0,
): readonly Word[] | null {
  if (command.name === 'ssh') return remoteShell(command, aliases, depth);
  if (command.name === 'busybox' && SHELL_WORDS.has(command.args[0]?.value ?? ''))
    return command.args.slice(1);
  const given = commandStringOf(command);
  if (given !== null) return given;
  if (SHELL_WORDS.has(command.name) || aliases.has(command.name)) return command.args;
  // `su root`, `runuser -l user`, `newgrp group`: the shell of another user or group, which reads standard
  // input as a program. The user or the group is not a file for it to read.
  if (STARTS_A_SHELL_FOR.has(command.name)) return withoutUser(command.name, command.args);
  // `source /dev/stdin` and `. /dev/stdin` run what is on standard input as a script.
  if ((command.name === 'source' || command.name === '.') && command.args.length > 0)
    return command.args;
  return null;
}

/** Whether the wrappers hand a shell its input as arguments, not as the program: `xargs bash`. */
export const fedByArguments = (command: Resolved): boolean =>
  command.wrappers.some((w) => w === 'xargs' || w === 'parallel' || w === 'watch');

/** Whether the shell's first operand reads standard input or a command's output: `source /dev/stdin`. */
export function sourcesProgram(args: readonly Word[]): boolean {
  const first = args.find((w) => !w.value.startsWith('-') || w.value === '-')?.value ?? '';
  return stdinPath(first) !== null || first.startsWith('<(') || first.startsWith('=(');
}

/** The words that name a program that is given another's input: a closing brace, `fi`, `done`. */
export const CLOSERS: ReadonlySet<string> = new Set(['}', ')', 'fi', 'done', 'esac', 'end']);

/** The longest glob that is read for the shell it may name; a longer one is taken to name one. */
const MAX_GLOB_CHARS = 128;
/** The most `*` a glob may have: each is a way to match the name again, and a pattern of many is slow to fail. */
const MAX_GLOB_STARS = 4;

/** Whether a glob could name a shell: `/bin/ba*`, `/bin/ba[s]h`, `/bin/?ash`. */
export function globNamesShell(word: string): boolean {
  const base = baseOf(word).replace(/\*{2,}/g, '*');
  if (!/[*?[]/.test(base)) return false;
  if (base.length > MAX_GLOB_CHARS || base.split('*').length - 1 > MAX_GLOB_STARS) return true;
  let source = '';
  for (let i = 0; i < base.length; i += 1) {
    const ch = base.charAt(i);
    if (ch === '*') source += '.*';
    else if (ch === '?') source += '.';
    else if (ch === '[') {
      const close = base.indexOf(']', i + 2);
      if (close === -1) source += '\\[';
      else {
        const set = base
          .slice(i + 1, close)
          .replace(/^[!^]/, '^')
          .replace(/\\/g, '\\\\');
        source += `[${set}]`;
        i = close;
      }
    } else source += ch.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  try {
    const glob = new RegExp(`^${source}$`);
    return [...SHELL_WORDS, ...SHELL_STARTERS].some((name) => glob.test(name));
  } catch {
    return true;
  }
}

/** The text with its quotes, backslashes and `$'…'` escapes taken off, as a shell would read a word. */
export function flattened(text: string): string {
  return text
    .replace(/\$'((?:[^'\\]|\\.)*)'/g, (_whole, inner: string) => decodeEscapes(inner, 'ansi'))
    .replace(/['"\\]/g, '');
}

/** The position of the last shell word in the text, or -1: where the analysis has to look. */
export function lastShellWordAt(text: string): number {
  SHELL_WORD_ANYWHERE.lastIndex = 0;
  let last = -1;
  for (
    let found = SHELL_WORD_ANYWHERE.exec(text);
    found !== null;
    found = SHELL_WORD_ANYWHERE.exec(text)
  )
    last = found.index;
  return last;
}

/**
 * Where the last shell word in the text stands, as a shell would read the text: a word spelt with
 * quotes or escapes (`b"as"h`, `$'\x62ash'`) is found after they are taken off, and stands, as far
 * as can be told, at the end.
 */
export function lastShellWordIn(text: string): number {
  const raw = lastShellWordAt(text);
  if (!/['"\\]/.test(text)) return raw;
  return lastShellWordAt(flattened(text)) === -1 ? raw : text.length;
}

/** The most words of a body that are looked at for a glob that names a shell; past it, it holds one. */
const MAX_BODY_WORDS = 2000;

/**
 * Whether the commands of a loop or a group could include a shell, by whatever name: a shell
 * word, a variable that names one, `sudo -s`, a path to standard input, or a glob that matches
 * one. What a loop is given on input reaches a program only through one of these.
 */
export function bodyMayRunShell(body: string): boolean {
  if (lastShellWordIn(body) !== -1) return true;
  if (SHELL_VARIABLE.test(body) || SUDO_SHELL.test(body) || FLOCK_SHELL.test(body)) return true;
  if (STDIN_PATH_ANYWHERE.test(body)) return true;
  if (!/[*?[]/.test(body)) return false;
  const words = body.split(/[\s;|&()<>]+/);
  return words.length > MAX_BODY_WORDS || words.some((word) => globNamesShell(word));
}

/**
 * Whether a text could hand a shell its program at all: if it could not, it is not read. With `strings` off, only
 * whether the shell that runs it could be handed a program on its input: a line that `watch` or `tmux` is told to
 * run is read as the line it is, and is no reason to read what is piped into the shell as a program.
 */
const triggersIn = (text: string, strings = true): boolean =>
  READS_A_PROGRAM.test(text) ||
  (strings && (RUNS_A_STRING_OF_ITS_OWN.test(text) || runsAStringByOption(text))) ||
  STDIN_PATH_ANYWHERE.test(text) ||
  SHELL_VARIABLE.test(text) ||
  PROCESS_SOURCE.test(text) ||
  SUDO_SHELL.test(text) ||
  FLOCK_SHELL.test(text) ||
  (EXPANDING.test(text) && (MAY_FEED.test(text) || STRING_OPTION.test(text)));

/** The same tests on the text as a shell reads it, so that `e\val` and `s"u"do -s` are not hidden. */
export const mentionsShell = (text: string, lastShellWord: number, strings = true): boolean =>
  lastShellWord !== -1 ||
  triggersIn(text, strings) ||
  (/['"\\]/.test(text) && triggersIn(flattened(text), strings));

export const mayHandShell = (text: string): boolean => mentionsShell(text, lastShellWordIn(text));

/** Whether a string that a shell is told to run could hand it a program from its input: `bash -c 'cat | sh'`. */
export const mayHandInputToShell = (text: string): boolean =>
  mentionsShell(text, lastShellWordIn(text), false);
