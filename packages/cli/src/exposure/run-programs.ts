import { OPEN_RUNNERS, RUNNER_WORDS, TEST_RUNNERS } from './run-tables.js';

/**
 * What the programs of a command line tell about how far it reaches: whether what it runs is
 * written on the line at all. Not a shell parser: a command it does not read to the end, a
 * program it does not know, a quote left open, is one that could run anything, and the caller
 * flags more rather than less.
 *
 * Every function here is one pass over its text, so the work is linear in the command's length.
 */

/**
 * Whether a command line holds a shell feature that decides at run time what runs: a variable or
 * a command substitution anywhere but in front of a path (`"$CLAUDE_PROJECT_DIR"/x.sh` is read),
 * a backquote, a here-document, a process substitution, a quote left open, a line continued, or
 * `eval`, `xargs`, `find -exec`, an alias, a trap or a function. With `onlySubstitution`, for the
 * value of a variable, which is not a command: only a command substitution or a backquote.
 */
export function computesWhatRuns(command: string, onlySubstitution = false): boolean {
  let quote = '';
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i] as string;
    if (quote === "'") {
      if (c === "'") quote = '';
      continue;
    }
    if (c === '\\') {
      if (command[i + 1] === '\n') return true;
      i += 1;
      continue;
    }
    if (c === '"') {
      quote = quote === '"' ? '' : '"';
      continue;
    }
    if (quote === '' && c === "'") {
      quote = "'";
      continue;
    }
    if (c === '`') return true;
    if (c === '$') {
      // A variable's value is taken as it is written: only a command in it runs.
      if (onlySubstitution && command[i + 1] !== '(') continue;
      const end = expansionEnd(command, i);
      if (end === -1) return true;
      // Only a path prefix is read: what follows the expansion, past a closing quote, is `/`.
      const after = command[end] === '"' ? command[end + 1] : command[end];
      if (after !== '/') return true;
      i = end - 1;
      continue;
    }
    if (
      quote === '' &&
      (c === '<' || c === '>') &&
      (command[i + 1] === '(' || (c === '<' && command[i + 1] === '<'))
    )
      return true;
  }
  return !onlySubstitution && (quote !== '' || RUNS_WHAT_IT_READS.test(command));
}

/** Words that run what they read, or define what a later word runs. */
const RUNS_WHAT_IT_READS =
  /(?:^|[\s;&|(){}])(?:eval|xargs|alias|trap|parallel|function)(?=[\s;&|(){}]|$)|(?:^|\s)-(?:exec|execdir|ok|okdir)(?=\s|$)|[A-Za-z0-9_]\s*\(\s*\)/;

/**
 * The index just past a `$` expansion that starts at `at`: a name, `{...}` or `(...)`, nested
 * parentheses counted. -1 for one that is not closed, or a kind not read (`$'...'`, `$1`).
 */
function expansionEnd(command: string, at: number): number {
  const next = command[at + 1];
  if (next === undefined || /\s/.test(next)) return at + 1;
  if (next === '{') {
    const close = command.indexOf('}', at + 2);
    return close === -1 ? -1 : close + 1;
  }
  if (next === '(') {
    let depth = 0;
    for (let j = at + 1; j < command.length; j += 1) {
      if (command[j] === '(') depth += 1;
      else if (command[j] === ')') {
        depth -= 1;
        if (depth === 0) return j + 1;
      }
    }
    return -1;
  }
  if (!/[A-Za-z_]/.test(next)) return -1;
  let j = at + 1;
  while (j < command.length && /[A-Za-z0-9_]/.test(command[j] as string)) j += 1;
  return j;
}

/** Characters that end one command of a line and start the next, outside quotes. */
const SEPARATORS = new Set([';', '&', '|', '\n', '(', ')', '`']);

/** The commands of a line, split where a shell would end one, outside quotes. */
export function segments(command: string): string[] {
  const out: string[] = [];
  let quote = '';
  let start = 0;
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i] as string;
    if (quote !== '') {
      if (c === '\\' && quote === '"') i += 1;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '\\') {
      i += 1;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (SEPARATORS.has(c)) {
      out.push(command.slice(start, i));
      start = i + 1;
    }
  }
  out.push(command.slice(start));
  return out;
}

/** The words of one command as a shell would split them, with the quotes taken off. */
export function shellTokens(part: string): string[] {
  const tokens: string[] = [];
  let word = '';
  let has = false;
  let quote = '';
  for (let i = 0; i < part.length; i += 1) {
    const c = part[i] as string;
    if (quote !== '') {
      if (c === quote) quote = '';
      else word += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      has = true;
      continue;
    }
    if (c === '\\' && i + 1 < part.length) {
      word += part[i + 1];
      has = true;
      i += 1;
      continue;
    }
    if (/\s/.test(c)) {
      if (has) tokens.push(word);
      word = '';
      has = false;
      continue;
    }
    word += c;
    has = true;
  }
  if (has) tokens.push(word);
  return tokens;
}

/** Words of the shell's own grammar before a command. */
const KEYWORDS: ReadonlySet<string> = new Set([
  'if',
  'then',
  'else',
  'elif',
  'while',
  'until',
  'do',
  '!',
  '{',
]);
/** Words of the shell's own grammar that end a command or start one that runs nothing. */
const NO_PROGRAM: ReadonlySet<string> = new Set([
  'for',
  'case',
  'select',
  'done',
  'fi',
  'esac',
  '}',
  'in',
]);
/** Programs that run the command after them: their options are skipped to find it. */
const WRAPPERS: ReadonlySet<string> = new Set([
  'sudo',
  'doas',
  'env',
  'nohup',
  'command',
  'builtin',
  'exec',
  'setsid',
  'caffeinate',
  'unbuffer',
  'time',
  'timeout',
  'nice',
  'ionice',
  'stdbuf',
  'chrt',
  'taskset',
]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** A label in front of a command, as the values of tasks and dev containers have them. */
const LABEL = /^[^\s:]+:$/;

/**
 * The program a command starts and its arguments: past keywords, assignments, labels and
 * wrappers with whatever options or numbers follow them (`sudo -E`, `timeout 10`, `nice -n 5`). A
 * word taken for the program that is an option's value is a program not known, which errs toward
 * more. `then <label>: ` in front, as a task's value names a task it depends on, is skipped too.
 */
export function programOf(tokens: readonly string[]): { program: string; args: string[] } | null {
  let i = 0;
  if (tokens[0] === 'then') {
    const label = tokens.findIndex((t, at) => at > 0 && t.endsWith(':'));
    if (label !== -1) i = label + 1;
  }
  let wrapped = false;
  for (; i < tokens.length; i += 1) {
    const word = tokens[i] as string;
    if (word === '') continue;
    if (NO_PROGRAM.has(word)) return null;
    if (KEYWORDS.has(word) || ASSIGNMENT.test(word) || LABEL.test(word)) continue;
    if (wrapped && (word.startsWith('-') || /^\d/.test(word))) continue;
    if (WRAPPERS.has(baseOf(word))) {
      wrapped = true;
      continue;
    }
    return { program: word, args: tokens.slice(i + 1) as string[] };
  }
  return null;
}

/** The name a shell finds a program by, in lower case, without a Windows extension. */
export const baseOf = (word: string): string =>
  word
    .slice(Math.max(word.lastIndexOf('/'), word.lastIndexOf('\\')) + 1)
    .toLowerCase()
    .replace(/\.(?:exe|cmd|bat|com)$/, '');

/** Shells: what they run is the file they are given, or the command after `-c`, or what they read. */
export const SHELLS: ReadonlySet<string> = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'mksh',
  'fish',
  'csh',
  'tcsh',
  'source',
  '.',
]);

/**
 * Interpreters: what they run is the file they are given, unless they are given code on their
 * command line or read it, which is not on the line to see.
 */
const INTERPRETERS: ReadonlySet<string> = new Set([
  'node',
  'nodejs',
  'deno',
  'tsx',
  'ts-node',
  'python',
  'python2',
  'python3',
  'py',
  'pypy',
  'pypy3',
  'ruby',
  'perl',
  'php',
  'pwsh',
  'powershell',
  'lua',
  'luajit',
  'rscript',
  'osascript',
]);
/** Options that hand an interpreter code on its command line, or a module to load first. */
const INLINE_CODE =
  /^(?:-[lnpaw]{0,3}e|-c[a-z]*|-p|-r|-ec|-enc|-encodedcommand|--(?:eval|print|import|require|loader|experimental-loader)(?:=.*)?)$/i;
/** Interpreters whose first word is their program, written on the line, unless `-f` names a file. */
const AWKS: ReadonlySet<string> = new Set(['awk', 'gawk', 'mawk']);
/** Options that hand a shell its command on its command line, or have it read one. */
const SHELL_INLINE = /^-[a-z]*[cs][a-z]*$/i;
/** Subcommands of an interpreter that run no file it is given, or code from elsewhere. */
const INTERPRETER_OPEN: ReadonlySet<string> = new Set(['task', 'test', 'bench', 'eval', 'repl']);

/**
 * Programs that run no file of the repository and load no code from it: they print, notify, move
 * text or files about, or talk to the network. A program on no list here is not known, and
 * counts as one that could run anything.
 */
const RUNS_NOTHING: ReadonlySet<string> = new Set([
  'echo',
  'printf',
  'cat',
  'head',
  'tail',
  'wc',
  'sort',
  'uniq',
  'cut',
  'tr',
  'tee',
  'ls',
  'pwd',
  'cd',
  'pushd',
  'popd',
  'mkdir',
  'touch',
  'rm',
  'rmdir',
  'cp',
  'mv',
  'ln',
  'chmod',
  'date',
  'sleep',
  'basename',
  'dirname',
  'realpath',
  'readlink',
  'stat',
  'du',
  'df',
  'find',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'jq',
  'yq',
  'diff',
  'cmp',
  'true',
  'false',
  ':',
  'test',
  '[',
  '[[',
  ']',
  ']]',
  'read',
  'exit',
  'return',
  'export',
  'unset',
  'set',
  'shift',
  'wait',
  'kill',
  'which',
  'type',
  'whoami',
  'id',
  'hostname',
  'uname',
  'printenv',
  'tput',
  'clear',
  'say',
  'afplay',
  'notify-send',
  'terminal-notifier',
  'pbcopy',
  'pbpaste',
  'curl',
  'wget',
  'md5sum',
  'shasum',
  'sha256sum',
  'base64',
  'gofmt',
  'goimports',
  'rustfmt',
  'shfmt',
  'shellcheck',
  'clang-format',
  'taplo',
  'yamllint',
  'gh',
]);
/** Git commands that run the repository's hooks, which can run anything. */
const GIT_RUNS_HOOKS: ReadonlySet<string> = new Set([
  'commit',
  'merge',
  'rebase',
  'push',
  'checkout',
  'switch',
  'am',
  'pull',
  'cherry-pick',
  'revert',
  'clone',
  'worktree',
  'submodule',
  'gc',
]);
/** Package managers that run the scripts of package.json by name. */
const PACKAGE_MANAGERS: ReadonlySet<string> = new Set(['npm', 'pnpm', 'yarn', 'bun']);
/**
 * Their subcommands that run no script of package.json: they list, show or ask, or run a package's
 * own program, which comes from `node_modules` or the registry, whose files count as a runner's.
 */
const NO_SCRIPT: ReadonlySet<string> = new Set([
  'exec',
  'x',
  'dlx',
  'help',
  'ls',
  'list',
  'why',
  'outdated',
  'audit',
  'info',
  'view',
  'show',
  'whoami',
  'ping',
  'search',
  'docs',
  'bugs',
  'repo',
  'prefix',
  'root',
  'bin',
  'licenses',
]);
/** A word that asks a runner for its tests: `test`, `tests`, `test:unit`, `--test`. */
const TEST_WORD = /^(?:--)?(?:tests?|t|tst)(?:[:._-]|$)/;

/** How far one command of a line reaches, by the program it starts. */
export type Reach =
  /** A file of the repository, or a shell or an interpreter given one: what it names is read. */
  | 'runs'
  /** A runner or a tool that loads the repository's config: its configs count too. */
  | 'runner'
  /** Nothing of the repository: it prints, moves files, talks to the network. */
  | 'nothing'
  /** Not written on the line: inline code, a recipe, a test runner, a program not known. */
  | 'open';

const firstPlain = (args: readonly string[]): string | undefined =>
  args.find((a) => !a.startsWith('-'));

/** How far one program, given these arguments, reaches. */
function reachOf(program: string, args: readonly string[]): Reach {
  if (program.includes('://')) return 'nothing';
  const absolute = program.startsWith('/') || /^[A-Za-z]:[\\/]/.test(program);
  // A file of the repository, named relative to a folder or behind a variable that is a prefix.
  if (/[\\/]/.test(program) && !absolute && !program.startsWith('~')) return 'runs';
  const name = baseOf(program);
  if (args.some((a) => TEST_RUNNERS.has(baseOf(a)))) return 'open';
  if (TEST_RUNNERS.has(name)) return 'open';
  if (SHELLS.has(name))
    return args.some((a) => SHELL_INLINE.test(a)) || firstPlain(args) === undefined
      ? 'open'
      : 'runs';
  if (AWKS.has(name)) return args.includes('-f') ? 'runs' : 'open';
  if (INTERPRETERS.has(name)) {
    const first = firstPlain(args);
    if (args.some((a) => INLINE_CODE.test(a) || a === '--test')) return 'open';
    if (first === undefined || first === '.' || first === './') return 'open';
    if (INTERPRETER_OPEN.has(first.toLowerCase())) return 'open';
    return RUNNER_WORDS.has(name) ? 'runner' : 'runs';
  }
  if (name === 'git')
    return args.some((a) => GIT_RUNS_HOOKS.has(a.toLowerCase())) ? 'open' : 'runner';
  if (OPEN_RUNNERS.has(name)) return 'open';
  if (PACKAGE_MANAGERS.has(name)) {
    // A script of package.json is not read: what it runs is not on this line.
    const first = firstPlain(args)?.toLowerCase();
    if (first === undefined) return name === 'yarn' ? 'open' : 'runner';
    // `bun x.ts` runs the file it is given, which is read by its name; `bun -e` runs inline code.
    if (name === 'bun' && args.some((a) => INLINE_CODE.test(a))) return 'open';
    if (name === 'bun' && /[\\/.]/.test(first)) return 'runner';
    return NO_SCRIPT.has(first) ? 'runner' : 'open';
  }
  if (RUNNER_WORDS.has(name))
    return args.some((a) => TEST_WORD.test(a.toLowerCase())) ? 'open' : 'runner';
  if (RUNS_NOTHING.has(name)) return 'nothing';
  return 'open';
}

/** What the commands of a line reach, each one by the program it starts. */
export function reachesOf(command: string): Reach[] {
  const reaches: Reach[] = [];
  for (const part of segments(command)) {
    const started = programOf(shellTokens(part));
    if (started !== null) reaches.push(reachOf(started.program, started.args));
  }
  return reaches;
}
