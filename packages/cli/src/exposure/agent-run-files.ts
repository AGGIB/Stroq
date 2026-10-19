import { posix } from 'node:path';
import type { ChangeStatus, TaggedHit } from './agent-change.js';
import { hit, type AgentKind, type Severity } from './agent-kinds.js';
import { inAgentFolder } from './agent-surface.js';
import { byPath, under } from './git-tree.js';
import {
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
}

/** How many scripts deep a hook's npm scripts are followed; deeper, the check widens. */
const MAX_SCRIPT_DEPTH = 4;
/** How many commands inside commands (`bash -c "..."`) are read; deeper, the check widens. */
const MAX_INNER_DEPTH = 4;
/** How many ends of one path are looked up; a longer path widens the check. */
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

/**
 * Files that set up a package or task runner, or are its recipes: what a runner the follow cannot
 * follow to the end may run. Workspace configs, Makefiles, justfiles, Taskfiles and the like, and
 * the configs of npm, yarn, pnpm and bun, which can name the shell scripts run in.
 */
const RUNNER_FILE =
  /(?:^|\/)(?:pnpm-workspace\.ya?ml|lerna\.json|nx\.json|turbo\.json|rush\.json|project\.json|workspace\.json|gnumakefile|makefile|[^/]*\.mk|\.?justfile|taskfile(?:\.dist)?\.ya?ml|rakefile(?:\.rb)?|tasks\.py|noxfile\.py|tox\.ini|(?:build|settings)\.gradle(?:\.kts)?|gradlew(?:\.bat)?|pom\.xml|mvnw(?:\.cmd)?|cargo\.toml|build\.rs|deno\.jsonc?|composer\.json|gemfile|pyproject\.toml|pipfile|\.pre-commit-config\.ya?ml|lefthook\.ya?ml|\.npmrc|\.yarnrc(?:\.ya?ml)?|bunfig\.toml|\.?pnpmfile\.[cm]?js|(?:docker-)?compose\.ya?ml|dockerfile)$|(?:^|\/)(?:\.yarn|\.mvn|gradle\/wrapper|\.husky|\.githooks)\//i;
/** A file a shell or an interpreter runs as a script. */
const SCRIPT_FILE =
  /\.(?:sh|bash|zsh|fish|ksh|ps1|psm1|bat|cmd|[cm]?[jt]sx?|py|rb|pl|pm|php|lua|r)$/i;
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
  readonly byName: ReadonlyMap<string, readonly string[]>;
  readonly packages: readonly string[];
}

function indexTouched(files: RunView['touchedFiles']): Index {
  const byTool = new Map<string, string[]>();
  const byName = new Map<string, string[]>();
  const add = (map: Map<string, string[]>, key: string, path: string): void => {
    const list = map.get(key);
    if (list === undefined) map.set(key, [path]);
    else list.push(path);
  };
  const mode = new Map<string, string>();
  for (const [path, , m] of files) {
    const base = baseName(path);
    add(byName, base, path);
    if (m !== undefined) mode.set(path, m);
    for (const [tools, file] of LOADS_CODE)
      if (file.test(base)) for (const tool of tools) add(byTool, tool, path);
  }
  return {
    sorted: files.map(([path]) => path).sort(byPath),
    status: new Map(files.map(([path, status]) => [path, status])),
    mode,
    byTool,
    byName,
    packages: files.map(([path]) => path).filter((p) => baseName(p) === 'package.json'),
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
   * runs in, since that is not always known (a session started in a subfolder, a `popd`).
   */
  private endingIn(path: string, found: Found[]): void {
    const tail = path.replace(/^(?:\.\.\/)+/, '').replace(/^\/+/, '');
    if (tail === '') return;
    const list = this.index.byName.get(baseName(tail)) ?? [];
    this.spent += list.length + tail.length;
    this.all(
      list.filter((file) => file === tail || file.endsWith(`/${tail}`)),
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
      }
    this.endingIn(path, found);
    const tool = baseName(path).toLowerCase();
    const configs = this.index.byTool.get(tool);
    if (configs !== undefined && this.once(`tool\0${tool}`)) this.all(configs, found);
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
        const runsIt =
          isEnv || before === '' || RUNS_WHAT_FOLLOWS.has(baseName(before).toLowerCase());
        if (!word.startsWith('-')) before = word;
        const path = pathOf(word);
        if (path !== undefined) this.word(path, [cwd, home], runsIt, found);
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
      const plan = npmPlan(program, args);
      if (plan.runner) this.widen('runner');
      if (plan.names.length > 0) this.packageScripts(plan, folders, found, scripts);
      return;
    }
    // `python -m a.b` runs a/b.py, or the folder a/b, from where it starts.
    const module = /^py(?:thon[\d.]*)?$/i.test(baseName(program)) ? args.indexOf('-m') : -1;
    const name = module === -1 ? undefined : args[module + 1];
    if (name !== undefined) {
      const path = name.replace(/\./g, '/');
      for (const file of [`${path}.py`, `${path}/__main__.py`, `${path}/__init__.py`])
        this.word(file, folders, true, found);
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
    // listed to review, as the server is. A variable already there is a warning only for what it
    // says itself: a file it names, or one put in a folder it names (PATH), fails when it changes.
    const severity: Severity =
      h.severity === 'error' || h.kind === 'agent-env' ? 'error' : 'warning';
    const add = (f: Found): void => {
      const key = `${f.file}\0${f.value}\0${name}`;
      if (!out.has(key))
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
