/**
 * Which program one command of a hook's command line starts, and how much of what that program
 * runs the follow in `agent-run-files.ts` can model. Not a shell parser: what this does not
 * understand is said so (`coarse`), and the caller then flags more rather than less.
 *
 * Every function here is one pass over its text, so the work is linear in the command's length.
 */

/** How much of what a command runs is known. */
export type Reach =
  /** Nothing of the repository beyond the paths its words name, which are looked up anyway. */
  | 'paths'
  /**
   * A package or task runner it cannot follow to the end: every change to package scripts,
   * workspace and runner configs, Makefiles, justfiles and Taskfiles counts.
   */
  | 'runner'
  /** Not known at all: every changed file in an agent folder and every script counts too. */
  | 'any';

/** The more cautious of two reaches. */
export const wider = (a: Reach, b: Reach): Reach =>
  a === 'any' || b === 'any' ? 'any' : a === 'runner' || b === 'runner' ? 'runner' : 'paths';

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
  '(',
  'time',
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
  ')',
  'in',
]);
/** Programs that run the command after them, and take no option of their own here. */
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
]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const DURATION = /^\d+(?:\.\d+)?[smhd]?$/;

/**
 * The program a command starts, with its arguments: past keywords, variable assignments and
 * wrappers (`sudo`, `env A=1`, `nohup`, `timeout 10`, `nice -n 5`). `coarse` when a wrapper has
 * an option this does not know, since its value could be taken for the program.
 */
export function programOf(
  tokens: readonly string[],
): { readonly program: string; readonly args: readonly string[] } | 'none' | 'coarse' {
  let i = 0;
  while (i < tokens.length) {
    // A subshell or a group is read for the command inside it: `(cd x && ./y.sh)`.
    const word = (tokens[i] as string).replace(/^[({]+/, '').replace(/[)}]+$/, '');
    const name = baseOf(word);
    if (word === '') {
      i += 1;
      continue;
    }
    if (NO_PROGRAM.has(word)) return 'none';
    // A label in front of a command, as the values of tasks and dev containers have them:
    // `osx: ./mac.sh`, `then fetch: curl ...`, `postCreate: npm ci`.
    if (KEYWORDS.has(word) || ASSIGNMENT.test(word) || /^[^\s:]+:$/.test(word)) {
      i += 1;
      continue;
    }
    if (WRAPPERS.has(name)) {
      i += 1;
      if (tokens[i]?.startsWith('-') === true && tokens[i] !== '--') return 'coarse';
      if (tokens[i] === '--') i += 1;
      continue;
    }
    if (name === 'timeout') {
      if (tokens[i + 1]?.startsWith('-') === true || !DURATION.test(tokens[i + 1] ?? ''))
        return 'coarse';
      i += 2;
      continue;
    }
    if (name === 'nice') {
      if (tokens[i + 1] === '-n') i += 3;
      else if (tokens[i + 1]?.startsWith('-') === true) return 'coarse';
      else i += 1;
      continue;
    }
    return { program: word, args: tokens.slice(i + 1) };
  }
  return 'none';
}

/** The name a shell finds a program by, in lower case, without a Windows extension. */
export const baseOf = (word: string): string =>
  word
    .slice(Math.max(word.lastIndexOf('/'), word.lastIndexOf('\\')) + 1)
    .toLowerCase()
    .replace(/\.(?:exe|cmd|bat|com)$/, '');

/** Shells: what they run is the file they are given, or the command after `-c`. */
export const SHELLS: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);

/**
 * Interpreters: what they run is the file they are given (looked up as a path), unless they are
 * given code on their command line, which is not read.
 */
const INTERPRETERS: ReadonlySet<string> = new Set([
  'node',
  'nodejs',
  'deno',
  'tsx',
  'ts-node',
  'python',
  'python3',
  'py',
  'ruby',
  'perl',
  'php',
  'pwsh',
  'powershell',
  'lua',
  'rscript',
  'osascript',
  'open',
  'source',
  '.',
]);
/** Options that hand an interpreter code on its command line. */
const INLINE_CODE =
  /^(?:-e|-c|-p|-r|--eval|--print|--import|--require|-command|-c[a-z]*|-encodedcommand|-ec|-enc)$/i;

/** Package runners that start a package's program: which one, and its code, is not followed. */
const PACKAGE_EXEC: ReadonlySet<string> = new Set(['npx', 'pnpx', 'bunx', 'uvx', 'pipx']);
/**
 * Task runners whose recipes are not read: what a recipe runs is not known, so a change to their
 * own files and to any script counts.
 */
const TASK_RUNNERS: ReadonlySet<string> = new Set([
  'make',
  'gmake',
  'just',
  'task',
  'rake',
  'invoke',
  'inv',
  'nox',
  'tox',
  'gradle',
  'gradlew',
  'mvn',
  'mvnw',
  'ant',
  'cargo',
  'go',
  'composer',
  'bundle',
  'poetry',
  'uv',
  'pipenv',
  'hatch',
  'pdm',
  'rye',
  'turbo',
  'nx',
  'lerna',
  'pre-commit',
  'lefthook',
  'husky',
  'docker',
  'docker-compose',
  'podman',
  'corepack',
]);
/**
 * Programs that run no file of the repository and load no code from it: they print, notify, move
 * text or files about, or talk to the network. A program not in any list here is not known, and
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
  'test',
  '[',
  '[[',
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
  'tsc',
  'black',
  'isort',
  'ruff',
  'gofmt',
  'goimports',
  'rustfmt',
  'shfmt',
  'shellcheck',
  'clang-format',
  'taplo',
  'yamllint',
]);
/** Git commands that run the repository's hooks (husky, `.githooks`), which are not followed. */
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

/** How much of what one program, given these arguments, runs is known (npm and the like apart). */
export function reachOf(program: string, args: readonly string[]): Reach | 'npm' | 'shell' {
  const name = baseOf(program);
  if (/[\\/]/.test(program) && !program.startsWith('/')) return 'paths';
  if (SHELLS.has(name)) return 'shell';
  if (name === 'npm' || name === 'pnpm' || name === 'yarn' || name === 'bun') return 'npm';
  const first = args.find((a) => !a.startsWith('-'));
  if (name === 'deno' && (first === 'task' || first === 'test' || first === 'bench')) return 'any';
  // A test runner runs every test file it finds, and what they import.
  if (TEST_RUNNERS.has(name) || (name === 'node' && args.includes('--test'))) return 'any';
  if (INTERPRETERS.has(name)) return args.some((a) => INLINE_CODE.test(a)) ? 'any' : 'paths';
  if (PACKAGE_EXEC.has(name)) return 'runner';
  if (TASK_RUNNERS.has(name)) return 'any';
  if (name === 'git') {
    const sub = args.find((a) => !a.startsWith('-'));
    return sub !== undefined && GIT_RUNS_HOOKS.has(sub) ? 'any' : 'paths';
  }
  if (RUNS_NOTHING.has(name) || LOADS_CODE_TOOLS.has(name)) return 'paths';
  return 'any';
}

/** Test runners: what they run is every test file they find, which is not followed. */
const TEST_RUNNERS: ReadonlySet<string> = new Set([
  'jest',
  'vitest',
  'mocha',
  'pytest',
  'py.test',
  'ava',
  'tap',
  'jasmine',
  'karma',
  'playwright',
  'cypress',
  'rspec',
  'phpunit',
  'pest',
  'nyc',
  'c8',
]);

/** Tools whose config is code, followed to that config (see `LOADS_CODE` in agent-run-files.ts). */
export const LOADS_CODE_TOOLS: ReadonlySet<string> = new Set([
  'eslint',
  'prettier',
  'stylelint',
  'lint-staged',
  'jest',
  'vitest',
  'vite',
  'mocha',
  'pytest',
  'py.test',
]);

/** The npm scripts one call of npm, pnpm, yarn or bun runs, as far as it is known. */
export interface NpmPlan {
  /** The scripts it runs; `orBin` when a name that is not a script runs a package's program. */
  readonly names: readonly string[];
  readonly orBin: boolean;
  /** Something past what is followed: an install, a workspace, an option not known. */
  readonly runner: boolean;
}

const RUN_SCRIPT: ReadonlySet<string> = new Set(['run', 'run-script', 'rs', 'urn']);
const LIFECYCLE: Readonly<Record<string, readonly string[]>> = {
  test: ['test'],
  t: ['test'],
  tst: ['test'],
  start: ['start'],
  stop: ['stop'],
  restart: ['restart', 'stop', 'start'],
};
export const INSTALL_SCRIPTS: readonly string[] = [
  'preinstall',
  'install',
  'postinstall',
  'prepublish',
  'preprepare',
  'prepare',
  'postprepare',
];
const INSTALLS: ReadonlySet<string> = new Set([
  'install',
  'i',
  'ci',
  'add',
  'rebuild',
  'rb',
  'link',
  'ln',
  'update',
  'up',
  'upgrade',
  'dedupe',
]);
/** Subcommands that run no script and no program of a package. */
const NO_SCRIPT: ReadonlySet<string> = new Set([
  'help',
  'ls',
  'list',
  'why',
  'outdated',
  'info',
  'view',
  'whoami',
  'login',
  'logout',
  'ping',
  'search',
  'docs',
  'bugs',
  'repo',
  'prefix',
  'root',
  'bin',
]);
/** Options of the runners that change nothing but what they print. */
const QUIET: RegExp =
  /^(?:--silent|-s|--quiet|-q|--if-present|--loglevel=[a-z]+|--color(?:=\w+)?|--no-color|--reporter=\w+)$/;
/** Options that name the folder whose package.json is read, as `cd` would. */
export const FOLDER_OPTIONS: ReadonlySet<string> = new Set(['--prefix', '-C', '--dir', '--cwd']);

/** What one call of npm, pnpm, yarn or bun runs, by its arguments. */
export function npmPlan(runner: string, args: readonly string[]): NpmPlan {
  const name = baseOf(runner);
  const positional: string[] = [];
  let runnerOnly = false;
  for (let i = 0; i < args.length; i += 1) {
    const word = args[i] as string;
    if (word === '--') break;
    if (FOLDER_OPTIONS.has(word)) {
      i += 1;
      continue;
    }
    if ([...FOLDER_OPTIONS].some((o) => word.startsWith(`${o}=`)) || QUIET.test(word)) continue;
    if (word.startsWith('-')) runnerOnly = true;
    else positional.push(word);
  }
  const plan = (names: readonly string[], orBin = false, runner = runnerOnly): NpmPlan => ({
    names,
    orBin,
    runner,
  });
  const [first, second] = positional;
  if (first === undefined) return name === 'yarn' ? plan(INSTALL_SCRIPTS, false, true) : plan([]);
  if (RUN_SCRIPT.has(first)) return second === undefined ? plan([]) : plan([second]);
  const lifecycle = LIFECYCLE[first];
  if (lifecycle !== undefined) return plan(lifecycle);
  if (INSTALLS.has(first)) return plan(INSTALL_SCRIPTS, false, true);
  if (NO_SCRIPT.has(first)) return plan([]);
  if (name === 'npm') return plan([], false, true);
  if (name === 'bun' && /[\\/.]/.test(first)) return plan([]);
  return plan([first], true);
}
