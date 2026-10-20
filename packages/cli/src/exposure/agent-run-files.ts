import { posix } from 'node:path';
import { startsWithoutAsking, type ChangeStatus, type TaggedHit } from './agent-change.js';
import { hit, type AgentKind, type Severity } from './agent-kinds.js';
import { inAgentFolder } from './agent-surface.js';
import { byPath, under } from './git-tree.js';
import {
  JS_RUNNERS,
  PY_RUNNERS,
  jsCandidates,
  langOf,
  pyCandidates,
  referencesOf,
  type Lang,
  type References,
} from './run-imports.js';
import {
  baseOf,
  computesWhatRuns,
  npmPlan,
  programOf,
  reachOf,
  shellTokens,
  wider,
  type NpmPlan,
  type Reach,
} from './run-programs.js';
import {
  MAX_PATH_CHARS,
  baseName,
  commandWords,
  globFolder,
  isGlob,
  pathEnds,
  pathOf,
} from './run-words.js';
import {
  CHANGES_FOLDER,
  LOADS_CODE,
  RUNNER_FILE,
  RUNS_WHAT_FOLLOWS,
  SCRIPT_FILE,
  TOOL_CONFIGS,
} from './run-tables.js';

/**
 * A hook that was already there can start a file of the repository, and a change can edit that
 * file without touching the hook. The hook's value stays the same, so the comparison of values
 * calls it present, while what it runs is new. This finds the files of the repository that the
 * command line of an entry already there runs, and reports each one the change touched:
 *
 * - a path the command names, however it is spelled in front (`$(git rev-parse --show-toplevel)/`,
 *   `${DIR:-.}/`, a quote, a folder it changes into first), and from any folder it may run in;
 * - a file under a folder it names or a pattern it expands, in an agent folder, or where a shell
 *   or an interpreter is given it, or where the program itself is a pattern;
 * - the npm scripts it runs through npm, pnpm, yarn or bun, and what they run in turn;
 * - the config a tool loads as code (eslint, prettier, pytest).
 *
 * That is a model of what runs, and where the model stops, the check widens instead of passing
 * (see `Reach`): a runner it cannot follow to the end (an install, a workspace, an option it does
 * not know, a package's program, a script past the depth it follows) adds every change to package
 * scripts, workspace and runner configs, Makefiles, justfiles and Taskfiles. A command it cannot
 * read (a variable, `xargs`, `eval`, inline code, a program it does not know, a task runner whose
 * recipes it does not read, a link on the way it did not read) adds every changed file in an agent
 * folder and every script as well.
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

/**
 * How a path of the repository changed, by the path a host opens it at: A, M, T, nothing, or
 * `unknown` when a link on the way to it was not read.
 */
export type Touched = (path: string) => 'new' | 'changed' | 'unknown' | undefined;

/** The `scripts` of one package.json at the head and at the base of the change. */
export interface PackageScripts {
  readonly head: Readonly<Record<string, unknown>> | undefined;
  readonly base: Readonly<Record<string, unknown>> | undefined;
  /**
   * The fields that set up the runner (`workspaces`, `packageManager`, `pnpm`, `config`, `bin`),
   * as text, at the head and at the base; undefined when not read.
   */
  readonly setup?: { readonly head: string; readonly base: string | undefined };
}

export interface RunView {
  readonly touched: Touched;
  /** Each entry of the tree the change added or edited (a file, a link, a submodule), and how. */
  readonly touchedFiles: readonly (readonly [
    path: string,
    status: 'new' | 'changed',
    mode?: string,
  ])[];
  /** A package.json's scripts; undefined when there is none, `unread` when it could not be read. */
  readonly scripts: (path: string) => PackageScripts | 'unread' | undefined;
  /**
   * The path a host ends up at for `path`, through the links on the way: itself when there are
   * none, `unknown` when one of them was not read, undefined when there is nothing there.
   */
  readonly real?: (path: string) => string | 'unknown' | undefined;
  /** What is at `path` through the links on the way: a file, a folder, `unknown`, or nothing. */
  readonly kind?: (path: string) => 'file' | 'folder' | 'unknown' | undefined;
  /** The text of the file at `path`; `unread` when it could not be read, undefined when none. */
  readonly text?: (path: string) => string | 'unread' | undefined;
}

/** How many scripts deep a hook's npm scripts are followed; deeper, the check widens. */
const MAX_SCRIPT_DEPTH = 4;
/** How many files deep what a hook's file imports or sources is read; deeper, the check widens. */
const MAX_IMPORT_DEPTH = 6;
/** The most files one entry is reported for; past it, one more finding says how many more. */
export const MAX_FILES_PER_ENTRY = 20;
/** The most findings the follow makes in one check; past it, one failing finding says so. */
export const MAX_RUN_HITS = 2_000;
/** How many commands inside commands (`bash -c "..."`) are read; deeper, the check widens. */
const MAX_INNER_DEPTH = 4;
/** How many ends of one path are looked up; a longer path widens the check. */
const MAX_ENDS = 64;
/** The most work, in characters looked up, that one check spends on following commands. */
export const RUN_LOOKUP_BUDGET = 64 * 1024 * 1024;

const EXECUTABLE = '100755';

/** Where one command of a line ends and the next begins. */
const COMMAND_SEPARATOR = /&&|\|\||[;|&\n]/;

interface Found {
  readonly file: string;
  /** The path, or `scripts.<name>` for an npm script. */
  readonly value: string;
  readonly status: ChangeStatus;
  readonly kind: 'agent-run-file-changed' | 'unreadable-config';
}

/** The touched files in order, to find those under a folder, by name and by tool; built once. */
interface Index {
  readonly sorted: readonly string[];
  readonly status: ReadonlyMap<string, 'new' | 'changed'>;
  readonly mode: ReadonlyMap<string, string>;
  readonly byTool: ReadonlyMap<string, readonly string[]>;
  /** By the last part of the path, in lower case: a disk may open `Guard.sh` as `guard.sh`. */
  readonly byName: ReadonlyMap<string, readonly string[]>;
  /** By the whole path in lower case, for the same reason. */
  readonly byLower: ReadonlyMap<string, readonly string[]>;
  readonly packages: readonly string[];
  /** Whether the change touched a file in a `node_modules` folder, which a package name finds. */
  readonly nodeModules: boolean;
}

function indexTouched(files: RunView['touchedFiles']): Index {
  const byTool = new Map<string, string[]>();
  const byName = new Map<string, string[]>();
  const byLower = new Map<string, string[]>();
  const add = (map: Map<string, string[]>, key: string, path: string): void => {
    const list = map.get(key);
    if (list === undefined) map.set(key, [path]);
    else list.push(path);
  };
  const mode = new Map<string, string>();
  for (const [path, , m] of files) {
    const base = baseName(path);
    add(byName, base.toLowerCase(), path);
    add(byLower, path.toLowerCase(), path);
    if (m !== undefined) mode.set(path, m);
    for (const [tools, file] of LOADS_CODE)
      if (file.test(base)) for (const tool of tools) add(byTool, tool, path);
  }
  const paths = files.map(([path]) => path);
  return {
    sorted: [...paths].sort(byPath),
    status: new Map(files.map(([path, status]) => [path, status])),
    mode,
    byTool,
    byName,
    byLower,
    packages: paths.filter((p) => baseName(p) === 'package.json'),
    nodeModules: paths.some((p) => /(?:^|\/)node_modules\//i.test(p)),
  };
}

/** The folder an entry's host runs in: the one that holds its agent folder, or its file. */
function homeOf(file: string): string {
  const parts = file.split('/');
  const at = parts.findIndex((part) => inAgentFolder(part));
  return parts.slice(0, at === -1 ? -1 : at).join('/');
}

/** `folder` and each folder above it, the nearest first, ending with the top (`''`). */
function foldersUp(folder: string): string[] {
  const up: string[] = [];
  for (let at = folder; ; at = posix.dirname(at)) {
    up.push(at === '.' ? '' : at);
    if (at === '' || at === '.' || at === '/') return up;
  }
}

/** Follows the commands of the entries already there to the files they run. */
class Follower {
  private spent = 0;
  private readonly looked = new Map<string, ReturnType<Touched>>();
  /** What one entry's commands were already followed to: a word said many times counts once. */
  private done = new Set<string>();
  /** How far the commands of the entry being followed reach past what is followed. */
  private reach: Reach = 'paths';
  private wide: { readonly runner: Found[]; readonly any: Found[] } | undefined;
  /** What each file read names, by its language and path: read once a check. */
  private readonly refs = new Map<string, References | 'unread' | undefined>();
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
    this.reach = 'paths';
  }

  widen(reach: Reach): void {
    this.reach = wider(this.reach, reach);
  }

  /** How far the commands of the entry being followed reach. */
  get reachNow(): Reach {
    return this.reach;
  }

  /** True the first time `key` comes for this entry; each time is charged to the budget. */
  private once(key: string): boolean {
    this.spent += key.length + 1;
    if (this.done.has(key)) return false;
    this.done.add(key);
    return true;
  }

  /** How `path` changed, each path looked up once and charged to the budget. */
  private lookup(path: string): ReturnType<Touched> {
    if (this.looked.has(path)) return this.looked.get(path);
    this.spent += path.length * (1 + path.split('/').length);
    const status = this.over ? undefined : this.view.touched(path);
    this.looked.set(path, status);
    return status;
  }

  /** The touched files under `folder`, and under where its links lead, once for this entry. */
  private underFolder(folder: string, found: Found[]): void {
    if (!this.once(`folder\0${folder}`)) return;
    // The folder itself, when it is a submodule the change moved or is in one, or a link on the
    // way to it changed: what is under it is not in the tree to list.
    const itself = folder === '' ? undefined : this.lookup(folder);
    if (itself === 'unknown') this.widen('any');
    else if (itself !== undefined)
      found.push({ file: folder, value: folder, status: itself, kind: 'agent-run-file-changed' });
    const files = [...under(this.index.sorted, folder)];
    const real = folder === '' ? folder : this.view.real?.(folder);
    if (real === 'unknown') this.widen('any');
    else if (real !== undefined && real !== folder && this.once(`folder\0${real}`))
      files.push(...under(this.index.sorted, real));
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

  /**
   * The touched files whose path ends with `path`: the file it names whatever folder the command
   * runs in, since that is not always known (a session started in a subfolder, a `popd`). In any
   * letter case, as macOS and Windows open a name.
   */
  private endingIn(path: string, found: Found[]): void {
    const tail = path
      .replace(/^(?:\.\.\/)+/, '')
      .replace(/^\/+/, '')
      .toLowerCase();
    if (tail === '') return;
    const list = this.index.byName.get(baseName(tail)) ?? [];
    this.spent += list.length + tail.length;
    this.all(
      list.filter((file) => {
        const lower = file.toLowerCase();
        return lower === tail || lower.endsWith(`/${tail}`);
      }),
      found,
    );
  }

  /** `path` when the change touched it, in its own letter case or in another. */
  private touchedAt(path: string, found: Found[]): void {
    const status = this.lookup(path);
    if (status === 'unknown') this.widen('any');
    else if (status !== undefined)
      found.push({ file: path, value: path, status, kind: 'agent-run-file-changed' });
    this.otherCase(path, found);
  }

  /** The touched files whose path is `path` in another letter case. */
  private otherCase(path: string, found: Found[]): void {
    const same = this.index.byLower.get(path.toLowerCase());
    if (same !== undefined)
      this.all(
        same.filter((file) => file !== path),
        found,
      );
  }

  /** One word of a command: the file it names, the folder or pattern it runs, the tool it is. */
  private word(path: string, folders: readonly string[], runsIt: boolean, found: Found[]): void {
    const joined = path.startsWith('/')
      ? []
      : folders.flatMap((f) => (f === '' ? [] : [posix.join(f, path)]));
    const wholes = [...new Set([path, ...joined])].filter((p) => p.length <= MAX_PATH_CHARS);
    if (isGlob(path)) {
      for (const whole of wholes) {
        const folder = globFolder(whole);
        for (const end of folder === '' ? [''] : pathEnds(folder, MAX_ENDS))
          if (runsIt || (end !== '' && inAgentFolder(end))) this.underFolder(end, found);
      }
      return;
    }
    // Past the ends looked up below, a path could be any of them: widen rather than guess.
    if (path.split('/').length > MAX_ENDS) this.widen('any');
    for (const whole of wholes)
      for (const end of pathEnds(whole, MAX_ENDS)) {
        const status = this.lookup(end);
        if (status === 'unknown') this.widen('any');
        else if (status !== undefined)
          found.push({ file: end, value: end, status, kind: 'agent-run-file-changed' });
        else if (runsIt || inAgentFolder(end)) this.underFolder(end, found);
        this.otherCase(end, found);
      }
    this.endingIn(path, found);
    const tool = baseName(path).toLowerCase();
    const configs = this.index.byTool.get(tool);
    if (configs !== undefined && this.once(`tool\0${tool}`)) this.all(configs, found);
  }

  /** The paths of the tree a word may name, from each folder the command may run in. */
  private wholesOf(path: string, folders: readonly string[]): string[] {
    if (path.startsWith('/')) return pathEnds(path, MAX_ENDS);
    const joined = folders.map((f) => (f === '' ? path : posix.join(f, path)));
    return [...new Set([path, ...joined])].filter(
      (p) => p.length <= MAX_PATH_CHARS && p !== '..' && !p.startsWith('../'),
    );
  }

  /**
   * What a program that runs the word `path` finds for it: a JavaScript runtime tries extensions,
   * an index and a package.json, Python a folder's `__main__.py`. Each is looked up, and each file
   * there is read for what it imports in turn.
   */
  private runs(path: string, runner: string, folders: readonly string[], found: Found[]): void {
    const js = JS_RUNNERS.has(runner);
    const tried = js
      ? jsCandidates(path)
      : PY_RUNNERS.has(runner) || /^python[\d.]*$/.test(runner)
        ? [path, `${path}/__main__.py`]
        : [path];
    for (const candidate of tried) {
      const wholes = this.wholesOf(candidate, folders);
      // The word itself was looked up by every end; what the program tries for it is looked up
      // where it is, or wherever the command runs.
      if (candidate !== path) {
        for (const whole of wholes) this.touchedAt(whole, found);
        this.endingIn(candidate, found);
      }
      for (const whole of wholes) {
        const kind = this.view.kind?.(whole);
        if (kind === 'unknown') this.widen('any');
        else if (kind !== 'file') continue;
        // Its `main` can name any file: not followed.
        else if (baseName(whole) === 'package.json') this.widen('any');
        else this.read(whole, langOf(whole, runner), folders, found, 0);
      }
    }
  }

  /** What `file` imports, requires, sources or names, read once a check, or why it was not. */
  private referencesIn(file: string, lang: Lang): References | 'unread' | undefined {
    const key = `${lang}\0${file}`;
    if (this.refs.has(key)) return this.refs.get(key);
    const text = this.view.text?.(file);
    const refs = typeof text === 'string' ? referencesOf(text, lang) : text;
    if (typeof text === 'string') this.spent += text.length;
    this.refs.set(key, refs);
    return refs;
  }

  /**
   * The files a file of the repository loads in turn, as far as `referencesIn` names them: each
   * one the change touched is found, and each one that is there is read the same way, to a depth.
   */
  private read(
    file: string,
    lang: Lang,
    folders: readonly string[],
    found: Found[],
    depth: number,
  ): void {
    if (this.view.text === undefined || this.over || !this.once(`read\0${file}`)) return;
    if (depth > MAX_IMPORT_DEPTH) return this.widen('any');
    const refs = this.referencesIn(file, lang);
    if (refs === undefined) return;
    if (refs === 'unread' || refs.cut) this.widen('any');
    if (refs === 'unread') return;
    const dir = posix.dirname(file) === '.' ? '' : posix.dirname(file);
    const from = [dir, ...folders];
    const next = (path: string): void => {
      this.touchedAt(path, found);
      const kind = this.view.kind?.(path);
      if (kind === 'unknown') this.widen('any');
      if (kind === 'file')
        this.read(path, langOf(path, lang === 'sh' ? 'sh' : ''), folders, found, depth + 1);
    };
    for (const ref of refs.paths) {
      if (this.over) return;
      // A shell script's words are paths from the folder it runs in as well as its own, and one
      // with a folder in it may follow a prefix the check cannot read (`$ROOT/x.sh`): it is
      // looked up by its ends as a command's word is. A bare word (`package.json`) is looked up
      // where the script is and where it runs only.
      const shellPath = lang === 'sh' && ref.includes('/');
      if (shellPath) this.word(ref, from, false, found);
      const bases = ref.startsWith('./') || ref.startsWith('../') ? [dir] : from;
      const paths = bases.map((base) => posix.normalize(base === '' ? ref : posix.join(base, ref)));
      if (shellPath) paths.push(...pathEnds(ref, MAX_ENDS));
      for (const path of new Set(paths)) {
        if (path.startsWith('../') || path.startsWith('/') || path === '..') continue;
        for (const candidate of lang === 'js' ? jsCandidates(path) : [path]) next(candidate);
      }
    }
    for (const module of refs.modules) {
      const dots = module.length - module.replace(/^\.+/, '').length;
      let base = dir;
      for (let up = 1; up < dots; up += 1)
        base = posix.dirname(base) === '.' ? '' : posix.dirname(base);
      const name = module.slice(dots);
      if (name === '') continue;
      for (const folder of dots > 0 ? [base] : from)
        for (const candidate of pyCandidates(name, folder)) next(candidate);
    }
    if (this.index.nodeModules)
      for (const pkg of refs.packages)
        for (const up of new Set(from.flatMap(foldersUp)))
          this.underFolder(posix.join(up, 'node_modules', pkg), found);
  }

  /** The configs of a tool a command runs, from each folder up, read for the plugins they name. */
  private toolConfigs(tool: string, folders: readonly string[], found: Found[]): void {
    const names = TOOL_CONFIGS.get(tool);
    if (names === undefined || this.view.kind === undefined) return;
    for (const up of new Set(folders.flatMap(foldersUp)))
      for (const name of names) {
        const path = up === '' ? name : `${up}/${name}`;
        const kind = this.view.kind(path);
        if (kind === 'unknown') this.widen('any');
        if (kind === 'file') this.read(path, 'js', folders, found, 1);
      }
  }

  /**
   * The files one command line runs that the change touched, and the npm scripts it runs. Read
   * one command at a time, with the folder the earlier ones changed into, starting in `home`.
   */
  follow(command: string, isEnv: boolean, home: string): { found: Found[]; scripts: string[] } {
    const found: Found[] = [];
    const scripts: string[] = [];
    if (computesWhatRuns(command, isEnv)) this.widen('any');
    let cwd = home;
    for (const part of command.split(COMMAND_SEPARATOR)) {
      if (this.over) break;
      this.spent += part.length + 1;
      const words = commandWords(part);
      let before = '';
      for (let i = 0; i < words.length && !this.over; i += 1) {
        const word = words[i] as string;
        if (CHANGES_FOLDER.has(word) || word === 'popd') {
          const to = word === 'popd' ? undefined : pathOf(words[i + 1] ?? '');
          // A folder this cannot name (`cd -`, `cd ~`, `popd`) leaves the rest anywhere.
          if (to === undefined || isGlob(to) || /^[~$-]/.test(to)) this.widen('any');
          else cwd = to.startsWith('/') ? to : posix.join(cwd, to);
        }
        // The first word runs, and so does what follows a shell, an interpreter or a loop.
        const runner = baseOf(before);
        const runsIt = isEnv || before === '' || RUNS_WHAT_FOLLOWS.has(runner);
        if (!word.startsWith('-')) before = word;
        // `node .` runs the folder's index or what its package.json names.
        const path = word === '.' && JS_RUNNERS.has(runner) ? '' : pathOf(word);
        if (path === undefined) continue;
        if (path !== '') this.word(path, [cwd, home], runsIt, found);
        if (runsIt && !isEnv) this.runs(path, runner, [cwd, home], found);
      }
      if (!isEnv) this.program(part, [cwd, home], found, scripts, 0);
    }
    return { found, scripts };
  }

  /** What the program of one command reaches, and the npm scripts it runs. */
  private program(
    part: string,
    folders: readonly string[],
    found: Found[],
    scripts: string[],
    depth: number,
  ): void {
    const started = programOf(shellTokens(part));
    if (started === 'none') return;
    if (started === 'coarse') return this.widen('any');
    const { program, args } = started;
    const reach = reachOf(program, args);
    if (reach === 'shell') {
      const flag = args.findIndex((a) => /^-[a-z]*c[a-z]*$/i.test(a));
      if (flag === -1) return;
      const inner = args[flag + 1];
      if (inner === undefined || depth >= MAX_INNER_DEPTH) return this.widen('any');
      for (const command of inner.split(COMMAND_SEPARATOR))
        this.program(command, folders, found, scripts, depth + 1);
      return;
    }
    if (reach === 'npm') {
      // `bun test` is bun's own test runner, which runs every test file it finds.
      if (baseOf(program) === 'bun' && args.find((a) => !a.startsWith('-')) === 'test')
        this.widen('any');
      const plan = npmPlan(program, args);
      if (plan.runner) this.widen('runner');
      if (plan.names.length > 0) this.packageScripts(plan, folders, found, scripts);
      return;
    }
    this.toolConfigs(baseOf(program), folders, found);
    // `python -m a.b` runs a/__init__.py and a/b.py, or the folder a/b, from where it starts.
    // The folder it starts in comes first on its path, so a module there named like any module
    // the program imports (`json.py`) runs instead: what that is, is not followed.
    const module = /^py(?:thon[\d.]*)?$/i.test(baseName(program)) ? args.indexOf('-m') : -1;
    const name = module === -1 ? undefined : args[module + 1];
    if (name !== undefined) {
      for (const folder of folders)
        for (const file of pyCandidates(name, folder)) this.word(file, [], true, found);
      this.widen('any');
    }
    this.widen(reach);
  }

  /**
   * The named scripts, with their `pre` and `post` scripts, of each package.json they may be in:
   * the one in the folder the command runs in and each one above it, and each the change touched.
   */
  private packageScripts(
    plan: NpmPlan,
    folders: readonly string[],
    found: Found[],
    scripts: string[],
  ): void {
    const wanted = plan.names.flatMap((n) => [`pre${n}`, n, `post${n}`]);
    const files = new Set([
      ...folders.flatMap((f) => foldersUp(f).map((up) => posix.join(up, 'package.json'))),
      ...this.index.packages,
    ]);
    const defined = new Set<string>();
    for (const file of files) {
      if (this.over) return;
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
      for (const name of plan.names)
        if (read.head !== undefined && typeof read.head[name] === 'string') defined.add(name);
      const fresh = wanted.filter((name) => this.once(`script\0${file}\0${name}`));
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
    // A name no package.json has a script for runs a package's program, which is not followed.
    if (plan.orBin && plan.names.some((name) => !defined.has(name))) this.widen('runner');
    // npm starts `node server.js` when there is no start script.
    if (plan.names.includes('start') && !defined.has('start')) scripts.push('node server.js');
  }

  /**
   * What a runner past the follow can run, or a command not read at all, among what the change
   * touched. Worked out once for a check, and charged to the budget at each use.
   */
  wideFound(reach: Reach): readonly Found[] {
    if (reach === 'paths') return [];
    this.wide ??= this.computeWide();
    const list = reach === 'runner' ? this.wide.runner : this.wide.any;
    this.spent += list.length;
    return list;
  }

  private computeWide(): { readonly runner: Found[]; readonly any: Found[] } {
    const runner: Found[] = [];
    for (const file of this.index.packages) runner.push(...this.packageChanges(file));
    for (const file of this.index.sorted)
      if (RUNNER_FILE.test(file) && baseName(file) !== 'package.json') this.all([file], runner);
    const any: Found[] = [...runner];
    for (const file of this.index.sorted) {
      const script = SCRIPT_FILE.test(baseName(file)) || this.index.mode.get(file) === EXECUTABLE;
      if ((script || inAgentFolder(file)) && !RUNNER_FILE.test(file)) this.all([file], any);
    }
    return { runner, any };
  }

  /** Each script and runner setting a touched package.json changes, or why it was not read. */
  private packageChanges(file: string): Found[] {
    const read = this.view.scripts(file);
    if (read === undefined) return [];
    if (read === 'unread')
      return [
        {
          file,
          value: 'the npm scripts that a runner already there may run could not be read',
          status: 'new',
          kind: 'unreadable-config',
        },
      ];
    const out: Found[] = [];
    const names = new Set([...Object.keys(read.head ?? {}), ...Object.keys(read.base ?? {})]);
    for (const name of names) {
      const now = read.head?.[name];
      const then = read.base?.[name];
      if (now === then || typeof now !== 'string') continue;
      out.push({
        file,
        value: `scripts.${name}`,
        status: typeof then === 'string' ? 'changed' : 'new',
        kind: 'agent-run-file-changed',
      });
    }
    if (read.setup !== undefined && read.setup.head !== read.setup.base)
      out.push({
        file,
        value: 'its workspaces, package manager or runner settings',
        status: read.setup.base === undefined ? 'new' : 'changed',
        kind: 'agent-run-file-changed',
      });
    return out;
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
    // listed to review, as the server is, unless its host starts it without asking. A variable
    // already there is a warning only for what it says itself: a file it names, or one put in a
    // folder it names (PATH), fails when it changes.
    const severity: Severity =
      h.severity === 'error' || h.kind === 'agent-env' || startsWithoutAsking(h)
        ? 'error'
        : 'warning';
    // At most `MAX_FILES_PER_ENTRY` files an entry runs are listed; the rest are counted.
    const extra = new Set<string>();
    let listed = 0;
    const add = (f: Found): void => {
      const key = `${f.file}\0${f.value}\0${name}`;
      if (out.has(key) || extra.has(key)) return;
      if (listed >= MAX_FILES_PER_ENTRY && f.kind === 'agent-run-file-changed') {
        extra.add(key);
        return;
      }
      listed += 1;
      out.set(key, { ...hit(f.kind, f.file, 1, name, f.value), severity, status: f.status });
    };
    const home = homeOf(h.file);
    const queue: (readonly [command: string, depth: number])[] = [[h.value, 0]];
    const seen = new Set<string>();
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      const [command, depth] = next;
      if (seen.has(command)) continue;
      seen.add(command);
      // A variable's value is a list of folders as often as a command: PATH, PYTHONPATH.
      const { found, scripts } = follower.follow(command, h.kind === 'agent-env', home);
      for (const f of found) add(f);
      // Scripts deeper than this are not followed: what they run is not known.
      if (depth < MAX_SCRIPT_DEPTH) for (const s of scripts) queue.push([s, depth + 1]);
      else if (scripts.length > 0) follower.widen('any');
      if (follower.over) break;
    }
    // Past the follow, an entry that fails widens to what it could run. One that is only listed
    // to review (an ordinary server, an install script) is not widened: that list would name every
    // script a change touches, and would fail nothing.
    if (!follower.over && severity === 'error')
      for (const f of follower.wideFound(follower.reachNow)) add(f);
    if (extra.size > 0)
      out.set(`\0more\0${name}`, {
        ...hit(
          'agent-run-file-changed',
          h.file,
          1,
          name,
          `${extra.size} more files the change touched`,
        ),
        severity,
        status: 'new',
      });
    if (out.size > MAX_RUN_HITS) {
      const why = `the entries already there run more than ${MAX_RUN_HITS} files the change touched, so not all are listed`;
      out.set('\0many', {
        ...hit('unreadable-config', h.file, 1, 'run files', why),
        status: 'new',
      });
      break;
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
