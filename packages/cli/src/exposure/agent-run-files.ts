import { posix } from 'node:path';
import type { ChangeStatus, TaggedHit } from './agent-change.js';
import { hit, type AgentKind, type Severity } from './agent-kinds.js';
import { inAgentFolder } from './agent-surface.js';
import { byPath, under } from './git-tree.js';
import {
  MAX_PATH_CHARS,
  baseName,
  commandWords,
  globFolder,
  isGlob,
  pathEnds,
  pathOf,
} from './run-words.js';

/**
 * A hook that was already there can start a file of the repository, and a change can edit that
 * file without touching the hook. The hook's value stays the same, so the comparison of values
 * calls it present, while what it runs is new. This finds the files of the repository that the
 * command line of an entry already there runs, and reports each one the change touched:
 *
 * - a path the command names, however it is spelled in front: `$(git rev-parse --show-toplevel)/`,
 *   `${DIR:-.}/`, a quote, a folder it changes into first;
 * - a file under a folder it names or a pattern it expands, in an agent folder, or where a shell
 *   or an interpreter is given it;
 * - the npm scripts it runs through npm, pnpm, yarn or bun, and what they run in turn;
 * - the Makefile it runs make on, and the config a tool loads as code (eslint, prettier, pytest).
 *
 * The author of the change writes both the commands and the paths, so the work is bounded, and a
 * check that stops at the bound fails rather than passes.
 */

/** The kinds whose value is a command line, and what to call one in a sentence. */
const RUNS: Readonly<Partial<Record<AgentKind, string>>> = {
  'agent-hook': 'hook',
  'agent-helper-command': 'command',
  'agent-env': 'variable',
  'mcp-server': 'MCP server',
  'mcp-server-runs-code': 'MCP server',
  'editor-autorun-task': 'task',
  'agent-definition-hook': 'hook',
  'devcontainer-host-command': 'command',
  'devcontainer-command': 'command',
  'package-script': 'script',
  'package-script-agent-path': 'script',
};

/** How a path of the repository changed, by the path a host opens it at: A, M, T, or nothing. */
export type Touched = (path: string) => 'new' | 'changed' | undefined;

/** The `scripts` of one package.json at the head and at the base of the change. */
export interface PackageScripts {
  readonly head: Readonly<Record<string, unknown>> | undefined;
  readonly base: Readonly<Record<string, unknown>> | undefined;
}

export interface RunView {
  readonly touched: Touched;
  /** Each file of the tree the change added or edited, and how. */
  readonly touchedFiles: readonly (readonly [path: string, status: 'new' | 'changed'])[];
  /** A package.json's scripts; undefined when there is none, `unread` when it could not be read. */
  readonly scripts: (path: string) => PackageScripts | 'unread' | undefined;
}

/** How many scripts deep a hook's npm scripts are followed. */
const MAX_SCRIPT_DEPTH = 4;
/** How many ends of one path are looked up: a path in the tree is not deeper than this. */
const MAX_ENDS = 64;
/** The most work, in characters looked up, that one check spends on following commands. */
export const RUN_LOOKUP_BUDGET = 64 * 1024 * 1024;

/** Words after which a pattern or a folder is what runs: a shell, an interpreter, a loop. */
const RUNS_WHAT_FOLLOWS: ReadonlySet<string> = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'fish',
  'source',
  '.',
  'exec',
  'node',
  'deno',
  'bun',
  'tsx',
  'ts-node',
  'python',
  'python3',
  'ruby',
  'perl',
  'php',
  'pwsh',
  'powershell',
  'run-parts',
  'in',
]);
/** Words after which the next word is the folder the rest runs in. */
const CHANGES_FOLDER: ReadonlySet<string> = new Set([
  'cd',
  'pushd',
  '--prefix',
  '-C',
  '--dir',
  '--cwd',
  '--cd',
]);

/** Tools that load a file of the repository as code, and the names of those files. */
const LOADS_CODE: readonly (readonly [tools: readonly string[], file: RegExp])[] = [
  [['make', 'gmake'], /^(?:gnumakefile|makefile)$|\.mk$/i],
  [['just'], /^\.?justfile$/i],
  [['task'], /^taskfile(?:\.dist)?\.ya?ml$/i],
  [['rake'], /^rakefile(?:\.rb)?$/i],
  [['gradle', 'gradlew'], /^(?:build|settings)\.gradle(?:\.kts)?$/i],
  [['cargo'], /^build\.rs$/i],
  [['nox'], /^noxfile\.py$/i],
  [['invoke', 'inv'], /^tasks\.py$/i],
  [['pre-commit'], /^\.pre-commit-config\.ya?ml$/i],
  [['eslint'], /^(?:eslint\.config|\.eslintrc)\.[cm]?[jt]s$/i],
  [['prettier'], /^(?:prettier\.config|\.prettierrc)\.[cm]?[jt]s$/i],
  [['stylelint'], /^(?:stylelint\.config|\.stylelintrc)\.[cm]?[jt]s$/i],
  [['lint-staged'], /^(?:lint-staged\.config|\.lintstagedrc)\.[cm]?[jt]s$/i],
  [['jest'], /^jest\.config\.[cm]?[jt]s$/i],
  [['vitest', 'vite'], /^(?:vitest|vite)\.(?:config|workspace)\.[cm]?[jt]s$/i],
  [['mocha'], /^\.mocharc\.[cm]?js$/i],
  [['pytest', 'py.test'], /^conftest\.py$/i],
];

const RUNNERS: ReadonlySet<string> = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const RUN_SCRIPT: ReadonlySet<string> = new Set(['run', 'run-script', 'rs', 'urn']);
const LIFECYCLE: Readonly<Record<string, string>> = {
  test: 'test',
  t: 'test',
  tst: 'test',
  start: 'start',
  stop: 'stop',
  restart: 'restart',
};
const INSTALLS: ReadonlySet<string> = new Set(['install', 'i', 'ci', 'add', 'rebuild']);
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish'];
/** Subcommands of the runners that run no script of the package. */
const NO_SCRIPT: ReadonlySet<string> = new Set([
  'exec',
  'x',
  'dlx',
  'create',
  'init',
  'publish',
  'pack',
  'version',
  'why',
  'ls',
  'list',
  'outdated',
  'remove',
  'rm',
  'uninstall',
  'link',
  'unlink',
  'config',
  'help',
  'audit',
  'info',
  'view',
  'cache',
  'store',
  'login',
  'whoami',
]);
/** Options of the runners that take the next word as their value. */
const TAKES_VALUE: ReadonlySet<string> = new Set([
  '--prefix',
  '-C',
  '--dir',
  '--cwd',
  '--filter',
  '-F',
  '--workspace',
  '-w',
]);
/** Where one command of a line ends and the next begins. */
const COMMAND_SEPARATOR = /&&|\|\||[;|&\n]/;

/** The npm scripts one command runs through a runner, or none. */
function scriptNames(words: readonly string[]): string[] {
  const at = words.findIndex((w) => RUNNERS.has(baseName(w).toLowerCase()));
  if (at === -1) return [];
  const runner = baseName(words[at] as string).toLowerCase();
  const rest: string[] = [];
  for (let i = at + 1; i < words.length; i += 1) {
    const word = words[i] as string;
    if (TAKES_VALUE.has(word)) i += 1;
    else if (!word.startsWith('-')) rest.push(word);
  }
  const [first, second] = rest;
  if (first === undefined) return runner === 'yarn' ? INSTALL_SCRIPTS : [];
  if (RUN_SCRIPT.has(first)) return second === undefined ? [] : [second];
  if (Object.hasOwn(LIFECYCLE, first)) return [LIFECYCLE[first] as string];
  if (INSTALLS.has(first)) return INSTALL_SCRIPTS;
  if (NO_SCRIPT.has(first) || runner === 'npm') return [];
  return [first];
}

interface Found {
  readonly file: string;
  /** The path, or `scripts.<name>` for an npm script. */
  readonly value: string;
  readonly status: ChangeStatus;
  readonly kind: 'agent-run-file-changed' | 'unreadable-config';
}

/** The touched files in order, to find those under a folder, and by tool; built once for a check. */
interface Index {
  readonly sorted: readonly string[];
  readonly status: ReadonlyMap<string, 'new' | 'changed'>;
  readonly byTool: ReadonlyMap<string, readonly string[]>;
  readonly packages: readonly string[];
}

function indexTouched(files: RunView['touchedFiles']): Index {
  const byTool = new Map<string, string[]>();
  const add = (map: Map<string, string[]>, key: string, path: string): void => {
    const list = map.get(key);
    if (list === undefined) map.set(key, [path]);
    else list.push(path);
  };
  for (const [path] of files) {
    const base = baseName(path);
    for (const [tools, file] of LOADS_CODE)
      if (file.test(base)) for (const tool of tools) add(byTool, tool, path);
  }
  return {
    sorted: files.map(([path]) => path).sort(byPath),
    status: new Map(files),
    byTool,
    packages: files.map(([path]) => path).filter((p) => baseName(p) === 'package.json'),
  };
}

/** Follows the commands of the entries already there to the files they run. */
class Follower {
  private spent = 0;
  private readonly looked = new Map<string, 'new' | 'changed' | undefined>();
  /** What one entry's commands were already followed to: a word said many times counts once. */
  private done = new Set<string>();
  constructor(
    private readonly view: RunView,
    private readonly index: Index,
  ) {}

  get over(): boolean {
    return this.spent > RUN_LOOKUP_BUDGET;
  }

  /** Starts on the commands of another entry. */
  begin(): void {
    this.done = new Set();
  }

  /** True the first time `key` comes for this entry; each time is charged to the budget. */
  private once(key: string): boolean {
    this.spent += key.length + 1;
    if (this.done.has(key)) return false;
    this.done.add(key);
    return true;
  }

  /** How `path` changed, each path looked up once and charged to the budget. */
  private lookup(path: string): 'new' | 'changed' | undefined {
    if (this.looked.has(path)) return this.looked.get(path);
    this.spent += path.length * (1 + path.split('/').length);
    const status = this.over ? undefined : this.view.touched(path);
    this.looked.set(path, status);
    return status;
  }

  /** The touched files under `folder`, once for this entry. */
  private underFolder(folder: string, found: Found[]): void {
    if (!this.once(`folder\0${folder}`)) return;
    const files: string[] = [];
    for (const file of under(this.index.sorted, folder)) files.push(file);
    this.all(files, found);
  }

  private all(files: readonly string[], found: Found[]): void {
    this.spent += files.length;
    for (const file of files)
      found.push({
        file,
        value: file,
        status: this.index.status.get(file) ?? 'changed',
        kind: 'agent-run-file-changed',
      });
  }

  /** One word of a command: the file it names, the folder or pattern it runs, the tool it is. */
  private word(path: string, cwd: string, runsIt: boolean, found: Found[]): void {
    if (isGlob(path)) {
      const folder = globFolder(path);
      for (const end of folder === '' ? [] : pathEnds(folder, MAX_ENDS))
        if (runsIt || inAgentFolder(end)) this.underFolder(end, found);
      return;
    }
    const inCwd = cwd === '' || path.startsWith('/') ? '' : posix.join(cwd, path);
    const joined = inCwd === '' || inCwd.length > MAX_PATH_CHARS ? [] : [inCwd];
    for (const whole of [path, ...joined])
      for (const end of pathEnds(whole, MAX_ENDS)) {
        const status = this.lookup(end);
        if (status !== undefined)
          found.push({ file: end, value: end, status, kind: 'agent-run-file-changed' });
        else if (runsIt || inAgentFolder(end)) this.underFolder(end, found);
      }
    const tool = baseName(path).toLowerCase();
    const configs = this.index.byTool.get(tool);
    if (configs !== undefined && this.once(`tool\0${tool}`)) this.all(configs, found);
  }

  /**
   * The files one command line runs that the change touched, and the npm scripts it runs. Read
   * one command at a time, with the folder the earlier ones changed into.
   */
  follow(command: string, anyFolder: boolean): { found: Found[]; scripts: string[] } {
    const found: Found[] = [];
    const scripts: string[] = [];
    let cwd = '';
    for (const part of command.split(COMMAND_SEPARATOR)) {
      if (this.over) break;
      this.spent += part.length + 1;
      const words = commandWords(part);
      let before = '';
      for (let i = 0; i < words.length && !this.over; i += 1) {
        const word = words[i] as string;
        if (CHANGES_FOLDER.has(word)) {
          const to = pathOf(words[i + 1] ?? '');
          if (to !== undefined && !isGlob(to))
            cwd = cwd === '' || to.startsWith('/') || to.startsWith('$') ? to : posix.join(cwd, to);
        }
        const runsIt = anyFolder || RUNS_WHAT_FOLLOWS.has(baseName(before).toLowerCase());
        if (!word.startsWith('-')) before = word;
        const path = pathOf(word);
        if (path !== undefined) this.word(path, cwd, runsIt, found);
      }
      const names = scriptNames(words);
      if (names.length > 0) this.packageScripts(names, cwd, found, scripts);
    }
    return { found, scripts };
  }

  /** The named scripts, with their `pre` and `post` scripts, of each package.json they may be in. */
  private packageScripts(names: string[], cwd: string, found: Found[], scripts: string[]) {
    const wanted = names.flatMap((n) => [`pre${n}`, n, `post${n}`]);
    const files = new Set([
      'package.json',
      ...(cwd === '' ? [] : [posix.join(cwd, 'package.json')]),
      ...this.index.packages,
    ]);
    for (const file of files) {
      if (this.over) return;
      const fresh = wanted.filter((name) => this.once(`script\0${file}\0${name}`));
      if (fresh.length === 0) continue;
      const read = this.view.scripts(file);
      if (read === undefined) continue;
      if (read === 'unread') {
        found.push({
          file,
          value: 'the npm scripts that a command already there runs could not be read',
          status: 'new',
          kind: 'unreadable-config',
        });
        continue;
      }
      for (const name of fresh) {
        const now = read.head === undefined ? undefined : read.head[name];
        if (typeof now !== 'string') continue;
        scripts.push(now);
        const then = read.base === undefined ? undefined : read.base[name];
        if (now !== then)
          found.push({
            file,
            value: `scripts.${name}`,
            status: typeof then === 'string' ? 'changed' : 'new',
            kind: 'agent-run-file-changed',
          });
      }
    }
  }
}

/**
 * One entry per repository file, or npm script, that a present entry runs and the change touched,
 * as severe as the entry that runs it.
 */
export function runFileChanges(hits: readonly TaggedHit[], view: RunView): TaggedHit[] {
  const follower = new Follower(view, indexTouched(view.touchedFiles));
  const out = new Map<string, TaggedHit>();
  for (const h of hits) {
    const noun = RUNS[h.kind];
    if (noun === undefined || h.status !== 'present') continue;
    const name = `${h.name} ${noun} in ${h.file}`;
    follower.begin();
    // As much as the entry that runs it: a hook's script fails, an ordinary server's code is
    // listed to review, as the server is. A variable already there is a warning only for what it
    // says itself: a file it names, or one put in a folder it names (PATH), fails when it changes.
    const severity: Severity =
      h.severity === 'error' || h.kind === 'agent-env' ? 'error' : 'warning';
    const queue: (readonly [command: string, depth: number])[] = [[h.value, 0]];
    const seen = new Set<string>();
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      const [command, depth] = next;
      if (seen.has(command)) continue;
      seen.add(command);
      // A variable's value is a list of folders as often as a command: PATH, PYTHONPATH.
      const { found, scripts } = follower.follow(command, h.kind === 'agent-env');
      for (const f of found) {
        const key = `${f.file}\0${f.value}\0${name}`;
        if (!out.has(key))
          out.set(key, { ...hit(f.kind, f.file, 1, name, f.value), severity, status: f.status });
      }
      if (depth < MAX_SCRIPT_DEPTH) for (const s of scripts) queue.push([s, depth + 1]);
      if (follower.over) break;
    }
    if (follower.over) {
      const why = `the commands of the entries already there were too long to follow, past ${RUN_LOOKUP_BUDGET} characters`;
      out.set('\0over', {
        ...hit('unreadable-config', h.file, 1, 'run files', why),
        status: 'new',
      });
      break;
    }
  }
  return [...out.values()];
}
