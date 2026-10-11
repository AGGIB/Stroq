/**
 * The words that run another command: `sudo`, `env`, `nice`, `timeout`, and which of their options
 * take a value, so that the command they run can be found behind them.
 */

export const PREFIX_WORDS = new Set([
  'sudo',
  'time',
  'nohup',
  'exec',
  'command',
  'builtin',
  'env',
  'nice',
  'timeout',
  'watch',
  'xargs',
  'parallel',
  'doas',
  'stdbuf',
  'ionice',
  'chronic',
  'caffeinate',
]);

/**
 * Wrappers that put another command after their options, and how many plain words they take before it:
 * `flock FILE cmd`, `chrt PRIORITY cmd`. Beside the ones `PREFIX_WORDS` names; every reader that looks for the
 * command of a stage (`resolve`, `commandWord`, `firstArgAfter`) knows the same words, for a detector that is
 * handed `flock /tmp/l rm -rf .claude` reads the word it finds first.
 */
export const LOCAL_WRAPPERS: Readonly<Record<string, number>> = {
  coproc: 0,
  noglob: 0,
  nocorrect: 0,
  setsid: 0,
  unbuffer: 0,
  strace: 0,
  ltrace: 0,
  runuser: 0,
  unshare: 0,
  nsenter: 0,
  fakeroot: 0,
  firejail: 0,
  'systemd-run': 0,
  flock: 1,
  chrt: 1,
  taskset: 1,
  chroot: 1,
  sshpass: 0,
  // `corepack yarn cmd` and `corepack pnpm cmd` are `yarn cmd` and `pnpm cmd`.
  corepack: 0,
  // zsh: `repeat 3 bash`, and a lone `-`, which runs the command without the usual lookups.
  repeat: 1,
  '-': 0,
};

/**
 * How many words after a wrapper are looked at to tell what it runs (its verb, a `--`, an option that decides): a
 * wrapper that stands in a chain of them (`uv run uv run uv run …`) is looked past at every link, and a look at
 * the rest of the line each time is quadratic.
 */
export const MAX_LOOKAHEAD = 64;

interface VerbWrapper {
  /** The words after the program that make it run another command. */
  readonly verbs: ReadonlySet<string>;
  /** How many plain words stand between the verb and the command, after its options. */
  readonly words: number;
  /** The command is after a `--` where there is one: `mise exec node@20 -- cmd`. */
  readonly dashes?: boolean;
  /** The options that take a value and stand before the command: `conda run -n env cmd`, `uv run --with x cmd`. */
  readonly flags?: ReadonlySet<string>;
}
const verbs = (...names: string[]): ReadonlySet<string> => new Set(names);

/**
 * Programs that run another command after a verb, and are another command without it: `direnv exec DIR cmd`,
 * `mise exec TOOL -- cmd`, `asdf exec cmd`, `uv run cmd`, `bundle exec cmd`. `mise ls` and `uv pip install` are the
 * program itself.
 */
export const VERB_WRAPPERS: Readonly<Record<string, VerbWrapper>> = {
  direnv: { verbs: verbs('exec'), words: 1 },
  mise: {
    verbs: verbs('exec', 'x'),
    words: 0,
    dashes: true,
    flags: verbs('-C', '--cd', '-E', '--env', '-j', '--jobs'),
  },
  rtx: {
    verbs: verbs('exec', 'x'),
    words: 0,
    dashes: true,
    flags: verbs('-C', '--cd', '-E', '--env', '-j', '--jobs'),
  },
  asdf: { verbs: verbs('exec'), words: 0 },
  devbox: {
    verbs: verbs('run'),
    words: 0,
    flags: verbs('-c', '--config', '-e', '--env', '--env-file'),
  },
  volta: {
    verbs: verbs('run'),
    words: 0,
    flags: verbs('--node', '--npm', '--yarn', '--pnpm', '--bundled-npm'),
  },
  fnm: {
    verbs: verbs('exec'),
    words: 0,
    flags: verbs('--using', '--version-file-strategy', '--arch', '--fnm-dir'),
  },
  uv: {
    verbs: verbs('run'),
    words: 0,
    flags: verbs(
      '-p',
      '--python',
      '--with',
      '--with-editable',
      '--with-requirements',
      '--project',
      '--directory',
      '--env-file',
      '--extra',
      '--group',
      '--package',
      '--index',
      '--default-index',
      '--index-url',
      '--extra-index-url',
      '--find-links',
      '--config-file',
      '--cache-dir',
    ),
  },
  pipx: {
    verbs: verbs('run'),
    words: 0,
    flags: verbs('--spec', '--python', '--index-url', '--pip-args'),
  },
  poetry: { verbs: verbs('run'), words: 0 },
  pipenv: { verbs: verbs('run'), words: 0 },
  bundle: { verbs: verbs('exec'), words: 0 },
  // Stroq's own: `stroq run [--agent a] [--sandbox] -- agent …` starts the agent after the `--`, and `stroq mcp
  // --server s -- cmd …` the server. Any other word after `stroq` (`doctor`, `why`) is the program itself. Only the
  // bare name (and the system copy) is known here, as for the others; `stroq-state.ts` reads every spelling of it.
  stroq: {
    verbs: verbs('run', 'mcp'),
    words: 0,
    dashes: true,
    flags: verbs(
      '--agent',
      '--allow-domain',
      '--server',
      '--client',
      '--cwd',
      '--session',
      '--pass-env',
    ),
  },
  conda: { verbs: verbs('run'), words: 0, flags: verbs('-n', '--name', '-p', '--prefix', '--cwd') },
  mamba: { verbs: verbs('run'), words: 0, flags: verbs('-n', '--name', '-p', '--prefix', '--cwd') },
};

/**
 * How many words a verb wrapper takes before its command (the verb and what stands between), given the words that
 * follow it; null where it is not one (`mise ls`, a program that is not on the list).
 */
export function verbWrapperLength(wrapper: string, following: readonly string[]): number | null {
  if (!Object.hasOwn(VERB_WRAPPERS, wrapper)) return null;
  const found = VERB_WRAPPERS[wrapper] as VerbWrapper;
  if (following[0] === undefined || !found.verbs.has(following[0])) return null;
  if (found.dashes === true) {
    const dashes = following.indexOf('--');
    if (dashes !== -1) return dashes + 1;
  }
  // The options between the verb and the command, those that take a value with it.
  let at = 1;
  while (at < following.length) {
    const word = following[at] as string;
    if (word === '--') {
      at += 1;
      break;
    }
    if (!word.startsWith('-')) break;
    at += found.flags?.has(word) === true ? 2 : 1;
  }
  return at + found.words;
}

export const WRAPPER_VALUE_FLAGS: Readonly<Record<string, ReadonlySet<string>>> = {
  sudo: new Set([
    '-u',
    '-g',
    '-h',
    '-p',
    '-C',
    '-D',
    '-r',
    '-t',
    '-T',
    '-U',
    '-R',
    '-a',
    '--user',
    '--group',
    '--host',
    '--prompt',
    '--chdir',
    '--role',
    '--type',
    '--close-from',
    '--other-user',
    '--command-timeout',
    '--chroot',
  ]),
  doas: new Set(['-C', '-u']),
  nice: new Set(['-n', '--adjustment']),
  // GNU `-C dir`, `-a argv0`, `-u name`; BSD and macOS `-P altpath`, `-u name`.
  env: new Set(['-u', '-C', '-P', '-a', '--unset', '--chdir', '--argv0']),
  timeout: new Set(['-s', '-k', '--signal', '--kill-after']),
  time: new Set(['-f', '-o', '--format', '--output']),
  xargs: new Set([
    '-I',
    '-L',
    '-P',
    '-d',
    '-a',
    '-E',
    '-s',
    '-n',
    '--arg-file',
    '--delimiter',
    '--max-args',
    '--max-chars',
    '--max-lines',
    '--max-procs',
    '--process-slot-var',
  ]),
  stdbuf: new Set(['-o', '-e', '-i', '--input', '--output', '--error']),
  ionice: new Set([
    '-c',
    '-n',
    '-p',
    '-P',
    '-u',
    '--class',
    '--classdata',
    '--pid',
    '--pgid',
    '--uid',
  ]),
  // macOS: `caffeinate -t seconds`, `-w pid`; the rest are flags (`-d -i -m -s -u`).
  caffeinate: new Set(['-t', '-w']),
  // `sshpass -p password cmd`: the password is a value, and so are the file and the descriptor it is read from.
  sshpass: new Set(['-p', '-f', '-d', '-P']),
  // `fakeroot -s file`, `-i file`, `-l lib`: the others (`-u`, `--unknown-is-real`) are flags.
  fakeroot: new Set(['-l', '--lib', '-s', '-i', '-b', '--fd-base', '--faked']),
  strace: new Set([
    '-e',
    '-o',
    '-p',
    '-s',
    '-u',
    '-E',
    '-P',
    '-a',
    '-b',
    '-I',
    '-X',
    '-S',
    '-O',
    '--output',
    '--trace',
    '--abbrev',
    '--raw',
    '--signal',
    '--status',
    '--env',
    '--user',
    '--string-limit',
    '--attach',
    '--inject',
    '--fault',
  ]),
  ltrace: new Set(['-e', '-o', '-p', '-s', '-u', '-a', '-A', '-n', '-F', '-l']),
  // `runuser -u user -- cmd`, `runuser -g group -u user cmd`.
  runuser: new Set([
    '-u',
    '--user',
    '-g',
    '--group',
    '-G',
    '--supp-group',
    '-s',
    '--shell',
    '-w',
    '--whitelist-environment',
  ]),
  nsenter: new Set(['-t', '--target', '-S', '--setuid', '-G', '--setgid']),
  unshare: new Set([
    '-S',
    '--setuid',
    '-G',
    '--setgid',
    '-w',
    '--wd',
    '-R',
    '--root',
    '--propagation',
    '--setgroups',
    '--map-user',
    '--map-group',
    '--map-users',
    '--map-groups',
    '--monotonic',
    '--boottime',
  ]),
  flock: new Set(['-w', '--wait', '--timeout', '-E', '--conflict-exit-code']),
  chrt: new Set(['-p']),
  taskset: new Set(['-c', '--cpu-list']),
  'systemd-run': new Set([
    '-p',
    '--property',
    '-u',
    '--unit',
    '-E',
    '--setenv',
    '--description',
    '--slice',
    '--uid',
    '--gid',
    '--working-directory',
    '--service-type',
    '--on-calendar',
    '--on-active',
    '--on-boot',
    '--on-startup',
    '--on-unit-active',
    '--on-unit-inactive',
    '--timer-property',
    '-M',
    '--machine',
    '-H',
    '--host',
    '--nice',
  ]),
  // `watch -n 5 rm -rf x` runs `rm`, and `parallel -j 4 rm -rf {}` too: the number is a value.
  watch: new Set(['-n', '--interval']),
  parallel: new Set([
    '-j',
    '--jobs',
    '-n',
    '--max-args',
    '-N',
    '-S',
    '--sshlogin',
    '--slf',
    '--sshloginfile',
    '-a',
    '--arg-file',
    '-d',
    '--delimiter',
    '-L',
    '-l',
    '--max-lines',
    '-P',
    '--max-procs',
    '-I',
    '-E',
    '-C',
    '--colsep',
    '--results',
    '--joblog',
    '--tagstring',
    '--timeout',
    '--retries',
    '--workdir',
    '--wd',
    '--header',
    '--delay',
    '--nice',
    '--memfree',
    '--load',
    '--basefile',
    '--bf',
    '--transferfile',
    '--tf',
    '--return',
    '--env',
    '--halt',
    '--block',
    '--block-size',
    '--recstart',
    '--recend',
  ]),
};

/** Whether `flag` is an option of `wrapper` that takes the word after it (a name like `constructor` is no wrapper). */
export function wrapperTakesValue(wrapper: string, flag: string): boolean {
  return (
    Object.hasOwn(WRAPPER_VALUE_FLAGS, wrapper) && WRAPPER_VALUE_FLAGS[wrapper]?.has(flag) === true
  );
}

/**
 * Whether `flag` stands in for the plain word that `wrapper` takes before its command: `taskset 0x3 cmd` has a
 * mask, and `taskset -c 0,1 cmd` has none, for the list that the option takes is it.
 */
export const replacesPositional = (wrapper: string, flag: string): boolean =>
  wrapper === 'taskset' && /^(?:-c|--cpu-list)/.test(flag);

/** Wrapper options that take a value, beyond the short ones `WRAPPER_VALUE_FLAGS` knows. */
const LONG_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '--user',
  '--group',
  '--host',
  '--prompt',
  '--chdir',
  '--role',
  '--type',
  '--close-from',
  '--signal',
  '--kill-after',
  '--unset',
  '-e',
  '-o',
  '-u',
  '-g',
]);

/**
 * The wrappers whose options are all in `WRAPPER_VALUE_FLAGS` (or special-cased in `takesValueAsWritten`), so that
 * the options `LONG_VALUE_OPTIONS` describes (`-e`, `-o`, `-u`, `-g`, which are flags for most of them: `caffeinate
 * -u`, `xargs -o`, `parallel -u`) do not take the word after them and hide the command.
 */
const OWN_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  'env',
  'sudo',
  'doas',
  'nice',
  'nohup',
  'timeout',
  'time',
  'command',
  'builtin',
  'exec',
  'chronic',
  'xargs',
  'parallel',
  'watch',
  'stdbuf',
  'ionice',
  'caffeinate',
  // Each of these has the options that take a value in its own table, or has none (`systemd-run --user`,
  // `fakeroot -u` and `setsid -w` are flags): the list of the others does not apply.
  ...Object.keys(LOCAL_WRAPPERS),
]);

/** Whether the option, as it is written, is one of the wrapper that takes the word after it as its value. */
function takesValueAsWritten(wrapper: string, option: string): boolean {
  return (
    wrapperTakesValue(wrapper, option) ||
    (LONG_VALUE_OPTIONS.has(option) && !OWN_VALUE_OPTIONS.has(wrapper)) ||
    (wrapper === 'sudo' &&
      ['--user', '--group', '--host', '--prompt', '--chdir'].includes(option)) ||
    (wrapper === 'exec' && option === '-a')
  );
}

/**
 * Whether an option of the wrapper takes the word after it as its value. Short options stand together in one
 * word (`sudo -nu root`, `env -iu X`, `runuser -mu user`): the first of them that takes a value decides, and it
 * takes the next word only if it is the last of the word (`-uroot` has its value in it, `-nu` has it after).
 */
export function optionTakesValue(wrapper: string, option: string): boolean {
  if (takesValueAsWritten(wrapper, option)) return true;
  if (!/^-[A-Za-z]{2,}$/.test(option)) return false;
  for (let k = 1; k < option.length; k += 1)
    if (takesValueAsWritten(wrapper, `-${option.charAt(k)}`)) return k === option.length - 1;
  return false;
}

/** The letters of the options that take a value, other than the one that gives the string, of each command that runs one. */
const VALUED_LETTERS: Readonly<Record<string, string>> = {
  su: 'gGsw',
  runuser: 'gGswu',
  script: 'BEIOTmo',
  npx: 'p',
  npm: 'p',
  pnpm: 'p',
  yarn: 'p',
  bun: 'p',
  flock: 'wE',
  tmux: 'fLST',
  fd: 'dEteSocj',
  osascript: 'ls',
  vim: 'uUiwWtTSDlr',
};

/** The letters of a command's options that take a value, or none when it is not in the table. */
export const valuedLettersOf = (command: string): string =>
  Object.hasOwn(VALUED_LETTERS, command) ? (VALUED_LETTERS[command] as string) : '';

/**
 * Where the first option of a word of short options that takes a value (`valued` are the letters that do) has its
 * value: in the word itself (`su -scsh` gives `csh` to `-s`, `tmux new-session -sname` gives `name` to `-s`) or in
 * the word after it (`su -ls csh`). Null where no letter of the word takes one, or it is no cluster of short options
 * (`-x/tmp/cache`, `--long`).
 */
export function valueOfLetters(valued: string, option: string): 'glued' | 'next' | null {
  if (!option.startsWith('-')) return null;
  for (let k = 1; k < option.length; k += 1) {
    const ch = option.charAt(k);
    if (!/[A-Za-z0-9]/.test(ch)) return null;
    if (valued.includes(ch)) return k + 1 < option.length ? 'glued' : 'next';
  }
  return null;
}

/**
 * What a word of short options gives the option `letter` (or any of several letters) as its value when the value stands in the same word:
 * `su -lc'cmd'` gives `cmd` to `c`. The first letter of the word that takes a value decides, so `tmux -Lcustom`
 * gives `custom` to `L` and no string to `c`. Null where the word ends in the letter (the value is the next word),
 * has none, or is no cluster of short options (`-x/tmp/cache`, `--command`). `command` is the name of the command,
 * whose other options that take a value end the cluster.
 */
export function gluedValue(command: string, option: string, letter: string): string | null {
  const valued = valuedLettersOf(command);
  if (!option.startsWith('-')) return null;
  for (let k = 1; k < option.length; k += 1) {
    const ch = option.charAt(k);
    if (!/[A-Za-z0-9]/.test(ch)) return null;
    if (letter.includes(ch)) return k + 1 < option.length ? option.slice(k + 1) : null;
    if (valued.includes(ch)) return null;
  }
  return null;
}

/** `valueOfLetters` for the options of a command in the table: `su -scsh`, `su -ls csh`, `tmux -2L name`. */
export const clusterValue = (command: string, option: string): 'glued' | 'next' | null =>
  valueOfLetters(valuedLettersOf(command), option);

// Wrappers that consume exactly one plain positional argument (not a flag
// value) before their wrapped command word — e.g. the duration in
// `timeout 5 curl ...`, the file of `flock FILE cmd`.
export const POSITIONAL_ARG_WRAPPERS = new Set([
  'timeout',
  ...Object.entries(LOCAL_WRAPPERS)
    .filter(([, words]) => words === 1)
    .map(([name]) => name),
]);

/** Directories only root writes: a program of a wrapper's name there is that wrapper. */
const SYSTEM_BIN = /^\/(?:usr\/)?s?bin\/[\w.-]+$/;

/**
 * The wrapper a word is, whether written bare (`env`) or by the path of the system copy
 * (`/usr/bin/env`), which is how `which env` spells it and how an agent can write it as
 * easily. A program that merely has a wrapper's name (`./env`, `/tmp/w/time`) is the program
 * the agent put there, and is not one: treating it as a wrapper would skip the file.
 */
const isWrapper = (name: string): boolean =>
  PREFIX_WORDS.has(name) || Object.hasOwn(LOCAL_WRAPPERS, name);

export function wrapperNamed(token: string): string | null {
  // A name is the one it is on a file system that does not tell `SUDO` from `sudo`.
  const name = token.toLowerCase();
  if (isWrapper(name)) return name;
  const base = name.replace(/^.*\//, '');
  return isWrapper(base) && SYSTEM_BIN.test(name) ? base : null;
}

/**
 * Whether `runuser` is given a command to run (`runuser -u user -- cmd`), not a user and a string for that user's
 * shell (`runuser -l user -c 'cmd'`, which is read as `su` is, with the string as the program).
 */
export function runuserRunsCommand(following: readonly string[]): boolean {
  for (const word of following) {
    if (word === '--user' || /^--user=/.test(word)) return true;
    if (word === '--command' || /^--command=/.test(word)) return false;
    if (!/^-[A-Za-z]+$/.test(word)) continue;
    // The first letter of a word of short options that takes a value decides: `-c` is a string for the shell,
    // `-u` names the user whose command follows, and a letter that takes another value (`-g group`) has the
    // rest of the word for it.
    for (const letter of word.slice(1)) {
      if (letter === 'c') return false;
      if (letter === 'u') return true;
      if (valuedLettersOf('su').includes(letter)) break;
    }
  }
  return false;
}

/**
 * Whether `command` is told to describe a name and not to run it (`command -v at`, `command -pV at`): what follows
 * its options is a name to look up, and nothing runs. `--` ends the options, so `command -- at now` runs `at`.
 */
export function commandDescribes(following: readonly string[]): boolean {
  for (const word of following) {
    if (word === '--' || !word.startsWith('-')) return false;
    if (/^-[A-Za-z]*[vV]/.test(word)) return true;
  }
  return false;
}

/** The name of a program that runs another after a verb (`direnv`, `uv`), by its name or the path of the system copy. */
export function verbWrapperNamed(token: string): string | null {
  const name = token.toLowerCase();
  if (Object.hasOwn(VERB_WRAPPERS, name)) return name;
  const base = name.replace(/^.*\//, '');
  return Object.hasOwn(VERB_WRAPPERS, base) && SYSTEM_BIN.test(name) ? base : null;
}
