import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { splitCommand } from '../actions/shell-segments.js';
import { commandSegments } from '../actions/shell-top-level.js';
import { resolve } from '../actions/shell-words.js';

/**
 * Whether what a command printed is the developer's own text: every program the command runs,
 * the ones in its substitutions, `sh -c` bodies and compound arms included, is one whose output
 * comes from this machine and this project (`LOCAL_PROGRAMS`, a local subcommand of git or of a
 * package manager, a project script that is itself local, a test or build tool, a program the
 * project has installed in `node_modules/.bin`, a Python program that imports only modules that
 * read and compute). A program this does not know is somebody else's, as is one that is not
 * read: what `npm view`, `kubectl logs`, `node -e` or a `python fetch.py` prints was written
 * elsewhere, and a list of the programs that do that would never be whole. An allowlist, so the
 * doubt keeps the taint a flag always had.
 */

/** Longer than this, a command is not read for its programs: what it runs is not known. */
const MAX_COMMAND_CHARS = 64 * 1024;
/** How deep a project script that runs another (`"test": "npm run lint && vitest"`) is followed. */
const MAX_SCRIPT_DEPTH = 2;
/** The largest package.json read for its scripts. */
const MAX_MANIFEST_BYTES = 1024 * 1024;

/** Words of the shell's grammar that a segment can be cut down to: they run nothing. */
const GRAMMAR: ReadonlySet<string> = new Set([
  'for',
  'do',
  'done',
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'while',
  'until',
  'case',
  'esac',
  'in',
  'select',
  'function',
  '{',
  '}',
  '!',
  '[[',
  ']]',
  '((',
  '))',
]);

/** Wrappers that run the program they are given here, as it is: what it prints is what it would. */
const SAFE_WRAPPERS: ReadonlySet<string> = new Set([
  'sudo',
  'doas',
  'env',
  'time',
  'timeout',
  'gtimeout',
  'nohup',
  'nice',
  'ionice',
  'command',
  'builtin',
  'exec',
  'stdbuf',
  'caffeinate',
  'setsid',
  'unbuffer',
  'flock',
  'chrt',
  'taskset',
  'noglob',
  'nocorrect',
  'coproc',
  'strace',
  'ltrace',
  'fakeroot',
  'direnv',
  'mise',
  'asdf',
  'volta',
  'fnm',
  'runuser',
  'repeat',
  'watch',
  '-',
]);

/** Programs that print what is on this machine: files, the shell's state, the system. */
const LOCAL_PROGRAMS: ReadonlySet<string> = new Set([
  // Reading and comparing files.
  'cat',
  'bat',
  'batcat',
  'head',
  'tail',
  'less',
  'more',
  'sed',
  'awk',
  'gawk',
  'mawk',
  'cut',
  'tr',
  'sort',
  'uniq',
  'wc',
  'nl',
  'tac',
  'column',
  'fold',
  'fmt',
  'expand',
  'unexpand',
  'paste',
  'join',
  'comm',
  'diff',
  'cmp',
  'colordiff',
  'sdiff',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'ag',
  'ack',
  'jq',
  'yq',
  'xxd',
  'od',
  'hexdump',
  'strings',
  'md5',
  'md5sum',
  'shasum',
  'sha1sum',
  'sha256sum',
  'sha512sum',
  'cksum',
  'base64',
  'file',
  'stat',
  // Listing and moving about.
  'ls',
  'exa',
  'eza',
  'tree',
  'fd',
  'du',
  'df',
  'pwd',
  'cd',
  'pushd',
  'popd',
  'dirs',
  'basename',
  'dirname',
  'realpath',
  'readlink',
  'which',
  'type',
  'whereis',
  'whence',
  'command',
  // Changing files of the project.
  'mkdir',
  'touch',
  'rm',
  'rmdir',
  'cp',
  'mv',
  'ln',
  'chmod',
  'chown',
  'chgrp',
  'tee',
  'truncate',
  // The shell itself, and the system it runs on.
  'echo',
  'printf',
  'true',
  'false',
  'test',
  '[',
  ':',
  'export',
  'set',
  'unset',
  'shopt',
  'declare',
  'local',
  'readonly',
  'let',
  'read',
  'return',
  'exit',
  'break',
  'continue',
  'shift',
  'wait',
  'sleep',
  'date',
  'cal',
  'env',
  'printenv',
  'id',
  'whoami',
  'groups',
  'uname',
  'sw_vers',
  'arch',
  'hostname',
  'ps',
  'pgrep',
  'kill',
  'pkill',
  'lsof',
  'uptime',
  'vm_stat',
  'free',
  'top',
  'jobs',
  'umask',
  'ulimit',
  'times',
  'clear',
  'tput',
  // Checks and builds of the project: what they print is about its own code.
  'tsc',
  'eslint',
  'prettier',
  'biome',
  'vitest',
  'jest',
  'mocha',
  'ava',
  'playwright',
  'pytest',
  'ruff',
  'black',
  'isort',
  'mypy',
  'pyright',
  'flake8',
  'pylint',
  'coverage',
  'rustc',
  'rustfmt',
  'gofmt',
  'cmake',
  'ninja',
  'meson',
  'xcodebuild',

  'swiftc',
  'javac',
  'kotlinc',
  'gcc',
  'g++',
  'clang',
  'clang++',
  'cc',
  'ld',
  'nm',
  'objdump',
  'otool',
  'lipo',
  'shellcheck',
  // PowerShell's own reading of the machine.
  'get-content',
  'gc',
  'get-childitem',
  'gci',
  'dir',
  'select-string',
  'sls',
  'get-location',
  'set-location',
  'write-output',
  'write-host',
  'test-path',
  'get-item',
  'get-itemproperty',
  'measure-object',
  'sort-object',
  'select-object',
  'where-object',
  'foreach-object',
  'format-table',
  'format-list',
  'out-string',
  'get-date',
  'get-process',
  'get-command',
  'new-item',
  'remove-item',
  'copy-item',
  'move-item',
  'rename-item',
  'set-content',
  'add-content',
  'out-file',
  'compare-object',
  'convertto-json',
  'convertfrom-json',
  'get-filehash',
  'resolve-path',
  'split-path',
  'join-path',
]);

/** Subcommands of git that read or change the local repository and reach no other. */
const LOCAL_GIT: ReadonlySet<string> = new Set([
  'status',
  'diff',
  'log',
  'show',
  'blame',
  'branch',
  'tag',
  'rev-parse',
  'rev-list',
  'ls-files',
  'ls-tree',
  'grep',
  'stash',
  'describe',
  'config',
  'worktree',
  'add',
  'commit',
  'restore',
  'checkout',
  'switch',
  'merge',
  'rebase',
  'reset',
  'cherry-pick',
  'revert',
  'apply',
  'mv',
  'rm',
  'clean',
  'shortlog',
  'reflog',
  'cat-file',
  'show-ref',
  'symbolic-ref',
  'for-each-ref',
  'name-rev',
  'merge-base',
  'count-objects',
  'fsck',
  'gc',
  'init',
  'notes',
  'bisect',
  'check-ignore',
  'check-attr',
  'var',
  'version',
  'help',
  'format-patch',
  'whatchanged',
]);
/** Options of git that take the next word as their value. */
const GIT_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--config-env',
]);

/** Package managers whose `run <script>` and script shorthands run what the project's package.json says. */
const SCRIPT_RUNNERS: ReadonlySet<string> = new Set(['npm', 'pnpm', 'yarn', 'bun']);
/** Their subcommands that print what the project holds and run nothing of it. */
const MANAGER_LOCAL: Readonly<Record<string, ReadonlySet<string>>> = {
  npm: new Set(['ls', 'list', 'll', 'la', 'why', 'explain', 'version', 'help']),
  pnpm: new Set(['ls', 'list', 'why', 'help']),
  yarn: new Set(['why', 'help']),
  bun: new Set([]),
};
/** Subcommands of other build tools that build and check the project's own code. */
const BUILD_LOCAL: Readonly<Record<string, ReadonlySet<string>>> = {
  cargo: new Set(['build', 'check', 'test', 'clippy', 'fmt', 'doc', 'bench', 'metadata']),
  go: new Set(['build', 'test', 'vet', 'fmt', 'env', 'version', 'doc']),
  swift: new Set(['build', 'test', 'format']),
  flutter: new Set(['test', 'analyze', 'build', 'format', 'devices', 'doctor']),
  dart: new Set(['analyze', 'test', 'format', 'fix']),
  dotnet: new Set(['build', 'test', 'format']),
};
/** Options of a package manager or a build tool that take the next word as their value. */
const MANAGER_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '--prefix',
  '-w',
  '--workspace',
  '-C',
  '--dir',
  '--filter',
  '-F',
  '--cwd',
  '--manifest-path',
  '-p',
  '--package',
]);

/** Modules a `python -m` runs that check the project's own code. */
const PYTHON_MODULES: ReadonlySet<string> = new Set([
  'pytest',
  'unittest',
  'mypy',
  'ruff',
  'black',
  'isort',
  'flake8',
  'pylint',
  'coverage',
  'compileall',
  'py_compile',
  'json.tool',
  'doctest',
  'timeit',
  'pyright',
]);
/**
 * The modules an inline Python program may import for what it prints to be local: they read and
 * compute and reach nothing (`subprocess` and `os` start processes, which the classifier reads out
 * of the program as commands of their own, and those are held to this same list).
 */
const LOCAL_PYTHON_IMPORTS: ReadonlySet<string> = new Set([
  'json',
  'sys',
  'os',
  're',
  'pathlib',
  'collections',
  'itertools',
  'functools',
  'operator',
  'math',
  'statistics',
  'datetime',
  'time',
  'calendar',
  'csv',
  'hashlib',
  'base64',
  'binascii',
  'textwrap',
  'string',
  'random',
  'uuid',
  'glob',
  'fnmatch',
  'shutil',
  'io',
  'typing',
  'dataclasses',
  'enum',
  'decimal',
  'fractions',
  'pprint',
  'difflib',
  'unicodedata',
  'struct',
  'zlib',
  'ast',
  'tokenize',
  'inspect',
  'subprocess',
  'shlex',
  'tempfile',
  'copy',
  'heapq',
  'bisect',
  'array',
  'sqlite3',
  'tomllib',
  'configparser',
  'argparse',
  'locale',
  'platform',
  'traceback',
  'warnings',
  'contextlib',
  'abc',
  'numbers',
  'secrets',
  'html',
  'xml',

  'gzip',
  'bz2',
  'lzma',
]);
const PYTHONS = /^(?:python(?:3(?:\.\d+)?)?|py)$/;
/** An import of an inline program: `import a, b.c` and `from a.b import c`, by its top module. */
const PYTHON_IMPORT =
  /(?:^|[\n;])[ \t]*(?:import[ \t]+([\w., \t]+)|from[ \t]+([\w.]+)[ \t]+import)/g;
/** Ways an inline program runs or loads code that is not written in it. */
const PYTHON_DYNAMIC =
  /\b(?:exec|eval|compile|__import__|importlib|runpy|ctypes|getattr|globals|vars|__builtins__|__dict__|__class__|__subclasses__)\b/;

const words = (args: readonly { readonly value: string }[]): string[] => args.map((a) => a.value);

/** The first word after the options, passing over the values of those that take one. */
function subcommand(args: readonly string[], valued: ReadonlySet<string>): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const word = args[i] as string;
    if (valued.has(word)) {
      i += 1;
      continue;
    }
    if (word.startsWith('-')) continue;
    return word;
  }
  return undefined;
}

/** Letters of a Python option cluster that take a value: the rest of the cluster, or the next word. */
const PYTHON_VALUE_LETTERS: ReadonlySet<string> = new Set(['c', 'm', 'W', 'X']);

/**
 * What a Python interpreter is told to run, read as it reads its options: the first `-c` or `-m`
 * (also glued, `-cPROGRAM`, `-mpytest`) before any script path ends them. A script, `-` or nothing
 * runs code this does not read.
 */
function localPythonRun(args: readonly string[]): boolean {
  for (let i = 0; i < args.length; i += 1) {
    const word = args[i] as string;
    if (word === '--version' || word === '-V') return true;
    if (word === '--check-hash-based-pycs') i += 1;
    else if (word === '--' || word === '-' || !word.startsWith('-')) return false;
    else if (!word.startsWith('--'))
      // A cluster (`-IBc …`, `-Wignore`): its first letter that takes a value takes the rest of it,
      // or the next word, so `-Wcx` is a warning filter and not a program.
      for (let k = 1; k < word.length; k += 1) {
        const letter = word.charAt(k);
        if (!PYTHON_VALUE_LETTERS.has(letter)) continue;
        const glued = word.slice(k + 1);
        const value = glued !== '' ? glued : args[++i];
        if (letter === 'c') return localPython(value ?? '');
        if (letter === 'm') return PYTHON_MODULES.has(value ?? '');
        break;
      }
  }
  return false;
}

/** Whether an inline Python program imports only modules that read and compute. */
function localPython(program: string): boolean {
  if (PYTHON_DYNAMIC.test(program)) return false;
  for (const match of program.matchAll(PYTHON_IMPORT)) {
    const modules = match[1] !== undefined ? match[1].split(',') : [match[2] ?? ''];
    for (const module of modules) {
      const top = module.trim().split(/[.\s]/)[0] ?? '';
      if (!LOCAL_PYTHON_IMPORTS.has(top)) return false;
    }
  }
  return true;
}

/** The scripts of the project's package.json, or none. */
function projectScripts(cwd: string): Readonly<Record<string, unknown>> {
  try {
    const file = join(cwd, 'package.json');
    if (statSync(file).size > MAX_MANIFEST_BYTES) return {};
    const scripts = (JSON.parse(readFileSync(file, 'utf8')) as { scripts?: unknown }).scripts;
    return typeof scripts === 'object' && scripts !== null
      ? (scripts as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** What `npm run <name>` and its kin run: local when the script is; one there is none of is not known. */
function localScript(name: string | undefined, cwd: string, depth: number): boolean {
  if (name === undefined) return false;
  const script = projectScripts(cwd)[name];
  return (
    typeof script === 'string' && depth < MAX_SCRIPT_DEPTH && printsOwnText(script, cwd, depth + 1)
  );
}

/** Whether one program and its words print only local text. */
function localProgram(name: string, args: readonly string[], cwd: string, depth: number): boolean {
  // `find` runs a program on what it finds with these, and that program is not read here.
  if (name === 'find') return !args.some((a) => /^-(?:exec|execdir|ok|okdir|delete)$/.test(a));
  if (LOCAL_PROGRAMS.has(name)) return true;
  // A shell given a body: the body's programs are segments of their own and are read there. One given
  // a script, or its standard input, runs programs this does not see.
  if (name === 'sh' || name === 'bash' || name === 'zsh' || name === 'dash')
    return args.includes('-c');
  if (name === 'git') return LOCAL_GIT.has(subcommand(args, GIT_VALUE_OPTIONS) ?? '');
  if (SCRIPT_RUNNERS.has(name)) {
    const verb = subcommand(args, MANAGER_VALUE_OPTIONS);
    if (verb !== undefined && MANAGER_LOCAL[name]?.has(verb)) return true;
    // In another folder or package (`--prefix`, `-C`, `--filter`), the scripts are not these.
    if (
      args.some(
        (a) => MANAGER_VALUE_OPTIONS.has(a) || /^--(?:prefix|dir|cwd|filter|workspace)=/.test(a),
      )
    )
      return false;
    if (verb === 'run' || verb === 'run-script') {
      const at = args.indexOf(verb);
      return localScript(
        args.slice(at + 1).find((a) => !a.startsWith('-')),
        cwd,
        depth,
      );
    }
    if (verb === 'test' || verb === 't' || verb === 'tst') return localScript('test', cwd, depth);
    // `pnpm build`, `yarn lint`: a script by its name, run by the manager.
    if (verb !== undefined && Object.hasOwn(projectScripts(cwd), verb))
      return localScript(verb, cwd, depth);
    return false;
  }
  const build = BUILD_LOCAL[name];
  if (build !== undefined) return build.has(subcommand(args, MANAGER_VALUE_OPTIONS) ?? '');
  // A program already in the project: its output is about the project. One npx would fetch is not.
  if (name === 'npx' || name === 'pnpx' || name === 'bunx') {
    const bin = subcommand(args, MANAGER_VALUE_OPTIONS);
    return (
      bin !== undefined &&
      LOCAL_PROGRAMS.has(bin) &&
      /^[\w.-]+$/.test(bin) &&
      existsSync(join(cwd, 'node_modules', '.bin', bin))
    );
  }
  if (PYTHONS.test(name)) return localPythonRun(args);
  return args.length === 1 && (args[0] === '--version' || args[0] === '-v');
}

/**
 * Whether every word of a segment is an assignment (`A=1 B=x`). Read word by word: as one pattern of
 * repeated `NAME=value` it went back over `A=A=A=…` in time that doubled with each, a hook that hung.
 */
function onlyAssignments(segment: string): boolean {
  const words = segment.trim().split(/\s+/);
  return words[0] !== '' && words.every((word) => /^[A-Za-z_]\w*=/.test(word));
}

export function printsOwnText(command: string, cwd: string, depth = 0): boolean {
  if (command.length > MAX_COMMAND_CHARS) return false;
  const split = splitCommand(command);
  if (split.truncated || split.functionsUnread) return false;
  const functions = new Set(split.functions.map((f) => f.name));
  for (const segment of commandSegments(command, split)) {
    if (segment.trim() === '') continue;
    const found = resolve(segment);
    if (found === null) {
      // Only assignments, or nothing a shell runs.
      if (onlyAssignments(segment) || /^[\s(){};&|!]*$/.test(segment)) continue;
      return false;
    }
    if (found.deep || found.searchChanged === true || found.evalProgram !== null) return false;
    if (found.wrappers.some((wrapper) => !SAFE_WRAPPERS.has(wrapper))) return false;
    // `[` is read as a pattern by the word reader; as a command word it is `test`.
    const name = found.word === '[' || found.word === '[[' ? 'test' : found.name.toLowerCase();
    if (GRAMMAR.has(name) || functions.has(found.name)) continue;
    if (name === '$' || !localProgram(name, words(found.args), cwd, depth)) return false;
  }
  return true;
}
