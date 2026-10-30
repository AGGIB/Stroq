import { posix } from 'node:path';
import { INSTRUCTION_FILE, SELF_CONFIG_FILE } from '@stroq/core';
import { isPlainObject } from '../commands/config-file.js';
import {
  commandText,
  firstEntries,
  isHarmlessEnv,
  tooMany,
  mcpServerHits,
  own,
  ownObject,
  ownString,
  quoted,
  strings,
  type JsonFile,
  type Obj,
} from './agent-json.js';
import {
  boundedJson,
  byLine,
  digestOf,
  hit,
  otherFields,
  shownHit,
  type AgentHit,
} from './agent-kinds.js';
import { lineOf } from './jsonc.js';
import { fragmentsOf } from './run-names.js';
import { autoApproves } from './privilege-surface.js';

/**
 * Readers for the files an editor, a dev container or npm run by themselves: VS Code tasks and
 * settings, `.code-workspace` files, `devcontainer.json` and the install scripts of `package.json`.
 * Like the readers in `agent-json.ts`, every key is read with `Object.hasOwn` and every value is
 * checked for its type first.
 */
// ---------------------------------------------------------------------------------------------
// VS Code: tasks that run on folder open or worktree creation, and their settings.

/** The most tasks a folder-open task's `dependsOn` is followed through. */
const MAX_DEPENDS = 16;
const OS_KEYS = ['windows', 'linux', 'osx'] as const;

const argText = (value: unknown): string | undefined =>
  typeof value === 'string'
    ? value
    : isPlainObject(value) && typeof value['value'] === 'string'
      ? value['value']
      : undefined;

/** A task's command line: its command and its arguments, each a string or `{ value }`. */
function commandLine(task: Obj): string {
  const command = argText(own(task, 'command'));
  const args = Array.isArray(own(task, 'args'))
    ? (own(task, 'args') as unknown[]).map(argText).filter((a): a is string => a !== undefined)
    : [];
  return [command ?? '', ...args].filter((part) => part !== '').join(' ');
}

const labelOf = (task: Obj): string | undefined => argText(own(task, 'label'));

/**
 * Fields of a task that are shown on their own, or change how its output looks or when it is
 * reported done, and not what it runs. `options` (its `cwd`, `env` and `shell`), `type` other
 * than a plain shell or process, an npm task's `script` and anything else are part of what runs.
 */
const TASK_LABELS: ReadonlySet<string> = new Set([
  'label',
  'command',
  'args',
  'dependsOn',
  'dependsOrder',
  'runOptions',
  ...OS_KEYS,
  'presentation',
  'problemMatcher',
  'group',
  'detail',
  'icon',
  'hide',
  'isBackground',
  'promptOnClose',
]);
const isTaskLabel = (key: string, value: unknown): boolean =>
  TASK_LABELS.has(key) || (key === 'type' && (value === 'shell' || value === 'process'));

/** A task's command line and its other fields that decide how it runs. */
const runsOf = (task: Obj): string => `${commandLine(task)}${otherFields(task, isTaskLabel)}`;

/**
 * The most characters the tasks that folder-open tasks depend on add to the values of one file.
 * A task many depend on is written into each of their values, so without a bound 200 tasks on one
 * long one made 180 MB from 400 KB. Real files add a few lines.
 */
const MAX_DEPENDS_TEXT = 1024 * 1024;

/** What one file's folder-open tasks may still add for their dependencies, and whether it ran out. */
interface Spend {
  left: number;
  cut: boolean;
}

/** A task's own lines: its command and the per-system commands that replace it, read once. */
function ownLines(task: Obj, memo: Map<Obj, readonly string[]>): readonly string[] {
  const known = memo.get(task);
  if (known !== undefined) return known;
  const lines = [runsOf(task)];
  for (const os of OS_KEYS) {
    const variant = ownObject(task, os);
    const line = variant === undefined ? '' : runsOf(variant);
    if (line !== '') lines.push(`${os}: ${line}`);
  }
  memo.set(task, lines);
  return lines;
}

interface TaskContext {
  readonly byLabel: ReadonlyMap<string, Obj>;
  readonly memo: Map<Obj, readonly string[]>;
  readonly spend: Spend;
}

/**
 * Everything a folder-open task runs: its command, the per-system commands that replace it,
 * and the tasks it depends on, which run first and need no `runOn` of their own. What a
 * dependency adds is charged to the file's `spend`; past it the rest is left out and `cut` set.
 */
function taskRuns(task: Obj, ctx: TaskContext, seen: Set<string>, charged: boolean): string {
  const parts: string[] = [];
  const add = (part: string): boolean => {
    if (charged) {
      if (part.length > ctx.spend.left) {
        ctx.spend.cut = true;
        return false;
      }
      ctx.spend.left -= part.length;
    }
    parts.push(part);
    return true;
  };
  const join = (): string => parts.filter((part) => part !== '').join(' | ');
  for (const line of ownLines(task, ctx.memo)) if (!add(line)) return join();
  const depends = own(task, 'dependsOn');
  const labels = typeof depends === 'string' ? [depends] : strings(depends);
  for (const label of labels) {
    if (ctx.spend.cut) break;
    const dependency = ctx.byLabel.get(label);
    if (dependency === undefined || seen.has(label) || seen.size >= MAX_DEPENDS) {
      if (!add(`then ${label}`)) break;
      continue;
    }
    seen.add(label);
    if (!add(`then ${label}:`)) break;
    const inner = taskRuns(dependency, ctx, seen, true);
    parts[parts.length - 1] = `then ${label}: ${inner}`;
  }
  return join();
}

const automaticTrigger = (task: Obj): 'folderOpen' | 'worktreeCreated' | undefined => {
  const options = ownObject(task, 'runOptions');
  const runOn = options === undefined ? undefined : ownString(options, 'runOn');
  if (runOn?.toLowerCase() === 'folderopen') return 'folderOpen';
  if (runOn?.toLowerCase() === 'worktreecreated') return 'worktreeCreated';
  return undefined;
};

/**
 * What a tasks file sets for all of its tasks: `options`, the per-system blocks, `inputs` (a
 * prompt can run a command), as text to follow each folder-open task's value.
 */
function forAllTasks(container: Obj | undefined): string {
  if (container === undefined) return '';
  const rest = otherFields(container, (key) => key === 'version' || key === 'tasks');
  return rest === '' ? '' : ` | for all tasks${rest}`;
}

export function folderOpenTasks(
  f: JsonFile,
  container: Obj | undefined,
  prefix: readonly string[],
): AgentHit[] {
  const list = container === undefined ? undefined : own(container, 'tasks');
  if (!Array.isArray(list)) return [];
  const shared = forAllTasks(container);
  const tasks = list.filter(isPlainObject);
  const byLabel = new Map<string, Obj>();
  for (const task of tasks) {
    const label = labelOf(task);
    if (label !== undefined && !byLabel.has(label)) byLabel.set(label, task);
  }
  const opening = firstEntries(
    f.path,
    'folder-open tasks',
    tasks.flatMap((task, i) => (automaticTrigger(task) ? [[task, i] as const] : [])),
  );
  const ctx: TaskContext = {
    byLabel,
    memo: new Map(),
    spend: { left: MAX_DEPENDS_TEXT, cut: false },
  };
  const found = opening.items.map(([task, i]) => {
    const label = labelOf(task);
    const seen = new Set(label === undefined ? [] : [label]);
    const line = lineOf(f.text, [...prefix, label === undefined ? '' : quoted(label), '"runOn"']);
    return hit(
      'editor-autorun-task',
      f.path,
      line,
      label ?? `task ${i + 1}`,
      `${taskRuns(task, ctx, seen, false)}${shared}${automaticTrigger(task) === 'worktreeCreated' ? ' | runOn: worktreeCreated' : ''}`,
    );
  });
  // What was left out of the values could run: the cut fails, with a digest of every task.
  const cut = ctx.spend.cut
    ? [tooMany(f.path, 'steps of folder-open tasks', MAX_DEPENDS_TEXT, list)]
    : [];
  return [...opening.cut, ...cut, ...found];
}

const AUTO_APPROVE_KEYS = ['chat.tools.autoApprove', 'chat.tools.global.autoApprove'] as const;
const TERMINAL_AUTO_APPROVE = 'chat.tools.terminal.autoApprove';

/**
 * `chat.tools.terminal.autoApprove` maps a command, or a `/regex/`, to `true`, `false` or
 * `{ approve }`. A list that only refuses (`"rm": false`) approves nothing.
 */
const approvesTerminal = (value: unknown): boolean =>
  value === true ||
  (isPlainObject(value) &&
    Object.values(value).some(
      (rule) => rule === true || (isPlainObject(rule) && own(rule, 'approve') === true),
    ));

export function vscodeSettings(
  f: JsonFile,
  settings: Obj | undefined,
  prefix: string[] = [],
): AgentHit[] {
  if (settings === undefined) return [];
  const hits: AgentHit[] = [];
  const nested = ownObject(settings, 'task');
  const automatic =
    own(settings, 'task.allowAutomaticTasks') ??
    (nested === undefined ? undefined : own(nested, 'allowAutomaticTasks'));
  if (automatic === 'on')
    hits.push(
      hit(
        'editor-autorun-task',
        f.path,
        lineOf(f.text, [...prefix, 'allowAutomaticTasks"']),
        'task.allowAutomaticTasks',
        'on',
      ),
    );
  // Each of these, whatever it holds: one that approves something approves tool calls without
  // asking; one that approves nothing is listed, and fails when a change sets it.
  for (const key of [...AUTO_APPROVE_KEYS, TERMINAL_AUTO_APPROVE]) {
    const value = own(settings, key);
    if (value === undefined) continue;
    const approves = key === TERMINAL_AUTO_APPROVE ? approvesTerminal(value) : autoApproves(value);
    hits.push(
      hit(
        approves ? 'agent-permission-bypass' : 'agent-broad-allow',
        f.path,
        lineOf(f.text, [...prefix, quoted(key)]),
        key,
        boundedJson(value),
      ),
    );
  }
  return [
    ...hits,
    ...mcpServerHits(f, ownObject(settings, 'mcp'), 'servers', [...prefix, '"mcp"']),
  ];
}

export const vscodeTasks = (f: JsonFile): AgentHit[] => folderOpenTasks(f, f.value, ['"tasks"']);

export const codeWorkspace = (f: JsonFile): AgentHit[] => [
  ...vscodeSettings(f, ownObject(f.value, 'settings'), ['"settings"']),
  ...folderOpenTasks(f, ownObject(f.value, 'tasks'), ['"tasks"', '"tasks"']),
];

export const vscodeSettingsFile = (f: JsonFile): AgentHit[] => vscodeSettings(f, f.value);

// ---------------------------------------------------------------------------------------------
// Dev containers.

export const DEVCONTAINER_HOST_KEY = 'initializeCommand';
export const DEVCONTAINER_KEYS = [
  'onCreateCommand',
  'updateContentCommand',
  'postCreateCommand',
  'postStartCommand',
  'postAttachCommand',
] as const;

/** A lifecycle command: a string for a shell, an array for a program, an object run in parallel. */
function lifecycleText(value: unknown): string | undefined {
  const direct = commandText(value);
  if (direct !== undefined) return direct;
  if (!isPlainObject(value)) return undefined;
  const parts = Object.entries(value).map(([name, command]) => {
    const text = commandText(command);
    return text === undefined ? undefined : `${name}: ${text}`;
  });
  const read = parts.filter((p): p is string => p !== undefined);
  return read.length === 0 ? undefined : read.join('; ');
}

/**
 * The keys of a dev container that give it this machine's files, devices or powers: what its
 * commands then reach. Each is an error wherever it is, whatever it holds: a mount or a `docker
 * run` option is not parsed to prove it stays inside.
 */
export const DEVCONTAINER_ACCESS_KEYS = [
  'mounts',
  'workspaceMount',
  'runArgs',
  'privileged',
  'capAdd',
  'securityOpt',
] as const;
/** What a dev container builds in from elsewhere: listed, like a build step. */
export const DEVCONTAINER_FEATURES = 'features';

/** The one top-level key that only names the container: nothing else of a dev container is. */
const COSMETIC_KEY = 'name';

/**
 * Keys whose value describes the container and holds no command, variable or code: an image to
 * start from, ports, users, a folder inside it, switches of the tool. Listed where no change
 * brought them, and not read as a command. Any other key is an error wherever it is, unless it is
 * a table of variables whose every name is on the benign list.
 */
const DATA_KEYS: ReadonlySet<string> = new Set([
  '$schema',
  'image',
  'forwardPorts',
  'portsAttributes',
  'otherPortsAttributes',
  'appPort',
  'remoteUser',
  'containerUser',
  'updateRemoteUserUID',
  'workspaceFolder',
  'shutdownAction',
  'overrideCommand',
  'hostRequirements',
  'waitFor',
  'service',
  'runServices',
]);
/** The keys that set variables in the container: read as variables, not as commands. */
export const DEVCONTAINER_ENV_KEYS: ReadonlySet<string> = new Set(['remoteEnv', 'containerEnv']);

/** What the hits for what a dev container is built from are named, and what is found of them. */
export const BUILD_CONTEXT = 'build context';
export const BUILD_FILE = 'build file';
export const COMPOSE_FILE = 'compose file';
export const BUILD_OUTSIDE = 'build input outside';
export const BUILD_INPUT_CHANGED = 'build input changed';
export const BUILD_UNRESOLVED = 'build input not resolved';
/** Every file named like a compose file or a Dockerfile, wherever it is: what compose may build. */
export const COMPOSE_ANYWHERE = 'compose files and Dockerfiles anywhere';
const BUILD_INPUTS: ReadonlySet<string> = new Set([
  BUILD_CONTEXT,
  BUILD_FILE,
  COMPOSE_FILE,
  COMPOSE_ANYWHERE,
]);

/** How the hit for every compose file and Dockerfile names them. */
const COMPOSE_NAMES = 'compose*.y*ml, docker-compose*.y*ml, Dockerfile*, *.dockerfile';

/** Whether a dev container hit names something it is built from, to be followed in a change. */
export const isBuildInput = (name: string): boolean => BUILD_INPUTS.has(name);

/**
 * Whether a dev container setting already there is read as a command (or as variables) for the
 * files a change edits: every key but the ones that hold no command, and the build inputs, which
 * are followed on their own.
 */
export const settingRuns = (name: string): boolean =>
  !DATA_KEYS.has(name) && !BUILD_INPUTS.has(name) && name !== BUILD_OUTSIDE;

/** The repository path of what a file at `path` names, `.` for the top; undefined out of it. */
export function besideFile(path: string, name: string): string | undefined {
  if (posix.isAbsolute(name) || /^[A-Za-z]:[\\/]/.test(name) || name.includes('://'))
    return undefined;
  const folder = posix.dirname(path);
  const joined = posix.normalize(posix.join(folder === '.' ? '' : folder, name));
  const clean = joined.endsWith('/') ? joined.slice(0, -1) : joined;
  return clean === '..' || clean.startsWith('../') ? undefined : clean === '' ? '.' : clean;
}

/** A string, or each string of a list: what a key names files by. */
const names = (value: unknown): string[] =>
  typeof value === 'string' ? [value] : Array.isArray(value) ? strings(value) : [];

/**
 * What a dev container is built from: the build context (its own folder when none is named), the
 * Dockerfile, each compose file and the folder it is in. Each as a hit, at the line of its key; one
 * that leads out of the repository is an error, since nothing of it is in a change to review.
 */
function buildInputs(f: JsonFile): AgentHit[] {
  const wanted: [name: string, key: string, path: string][] = [];
  const build = ownObject(f.value, 'build');
  const legacy = own(f.value, 'dockerFile') ?? own(f.value, 'dockerfile');
  if (build !== undefined || legacy !== undefined) {
    const context = build === undefined ? own(f.value, 'context') : own(build, 'context');
    const key = build === undefined ? 'dockerFile' : 'build';
    wanted.push([BUILD_CONTEXT, key, typeof context === 'string' ? context : '.']);
    const dockerfile =
      build === undefined ? legacy : (own(build, 'dockerfile') ?? own(build, 'dockerFile'));
    for (const name of names(dockerfile)) wanted.push([BUILD_FILE, key, name]);
  }
  // A compose file is not read for what its services build: everything near it, the dev
  // container's own folder, and every file named like a compose file or a Dockerfile count.
  if (Object.hasOwn(f.value, 'dockerComposeFile')) {
    for (const name of names(own(f.value, 'dockerComposeFile'))) {
      wanted.push([COMPOSE_FILE, 'dockerComposeFile', name]);
      wanted.push([BUILD_CONTEXT, 'dockerComposeFile', posix.dirname(name)]);
    }
    wanted.push([BUILD_CONTEXT, 'dockerComposeFile', '.']);
    wanted.push([COMPOSE_ANYWHERE, 'dockerComposeFile', '.']);
  }
  const seen = new Set<string>();
  const hits: AgentHit[] = [];
  for (const [name, key, written] of wanted) {
    const path = name === COMPOSE_ANYWHERE ? COMPOSE_NAMES : besideFile(f.path, written);
    const found =
      path === undefined
        ? {
            ...hit('devcontainer-setting', f.path, 1, BUILD_OUTSIDE, written),
            severity: 'error' as const,
          }
        : hit('devcontainer-setting', f.path, 1, name, path);
    const id = `${found.name}\u0000${found.value}`;
    if (seen.has(id)) continue;
    seen.add(id);
    hits.push({ ...found, line: lineOf(f.text, [quoted(key)]) });
  }
  return hits;
}

/** Whether what a key holds is a table of variables whose every name is on the benign list. */
const benignVariables = (value: unknown): boolean =>
  isPlainObject(value) && Object.keys(value).every((name) => isHarmlessEnv(name));

/**
 * Every other key of a dev container, but its name: each decides what is built or what runs, so
 * one a change adds or edits fails. One that holds no command (see `DATA_KEYS`), or only benign
 * variables, is listed where no change brought it; any other is an error wherever it is, since
 * what it runs is not proven inert, and so is each key that gives the container this machine.
 * `features` stays a command, since what it installs runs as one.
 */
function devcontainerSettings(f: JsonFile): AgentHit[] {
  const hits: AgentHit[] = [];
  const commands: ReadonlySet<string> = new Set([
    DEVCONTAINER_HOST_KEY,
    ...DEVCONTAINER_KEYS,
    DEVCONTAINER_FEATURES,
    COSMETIC_KEY,
  ]);
  for (const [key, value] of Object.entries(f.value)) {
    if (commands.has(key)) continue;
    const raw = boundedJson(value, undefined, true);
    const line = lineOf(f.text, [quoted(key)]);
    // Variables in the container: their names, never their values.
    const found = DEVCONTAINER_ENV_KEYS.has(key)
      ? shownHit('devcontainer-setting', f.path, line, key, raw, `{"env":${raw}}`)
      : hit('devcontainer-setting', f.path, line, key, raw);
    const inert = DATA_KEYS.has(key) || (DEVCONTAINER_ENV_KEYS.has(key) && benignVariables(value));
    hits.push(inert ? found : { ...found, severity: 'error' });
  }
  return [...hits, ...buildInputs(f)];
}

export function devcontainer(f: JsonFile): AgentHit[] {
  const hits: AgentHit[] = devcontainerSettings(f);
  const features = own(f.value, DEVCONTAINER_FEATURES);
  if (features !== undefined && !(isPlainObject(features) && Object.keys(features).length === 0))
    hits.push(
      hit(
        'devcontainer-command',
        f.path,
        lineOf(f.text, [quoted(DEVCONTAINER_FEATURES)]),
        DEVCONTAINER_FEATURES,
        boundedJson(features, undefined, true),
      ),
    );
  for (const key of [DEVCONTAINER_HOST_KEY, ...DEVCONTAINER_KEYS]) {
    const raw = own(f.value, key);
    if (raw === undefined) continue;
    // A value that is not a command this reads is reported as it is: the host may run it.
    const value = lifecycleText(raw) ?? boundedJson(raw);
    const kind =
      key === DEVCONTAINER_HOST_KEY ? 'devcontainer-host-command' : 'devcontainer-command';
    hits.push(hit(kind, f.path, lineOf(f.text, [quoted(key)]), key, value));
  }
  return byLine(hits);
}

// ---------------------------------------------------------------------------------------------
// package.json.

/**
 * The scripts a package manager runs by itself on an install with no arguments, in the order npm
 * runs them: the install trio, `prepublish`, `prepare` with its own pre and post scripts, npm's
 * `dependencies` after node_modules changes, and pnpm's `pnpm:devPreinstall`.
 */
export const INSTALL_SCRIPT_NAMES = [
  'pnpm:devPreinstall',
  'preinstall',
  'install',
  'postinstall',
  'prepublish',
  'preprepare',
  'prepare',
  'postprepare',
  'dependencies',
] as const;
const INSTALL_SCRIPTS: ReadonlySet<string> = new Set(INSTALL_SCRIPT_NAMES);
const EDITOR_CONFIG_PATH = /\.vscode[/\\]+(?:tasks|settings|mcp)\.json/i;

/** Whether a script's text names a file an agent or an editor loads by itself. */
const namesAgentPath = (script: string): boolean =>
  SELF_CONFIG_FILE.test(script) || INSTRUCTION_FILE.test(script) || EDITOR_CONFIG_PATH.test(script);

/** Keys of package.json a known git hook manager reads its hooks from, at the top or under `config`. */
export const HOOK_MANAGER_KEYS = [
  'simple-git-hooks',
  'husky',
  'lint-staged',
  'pre-commit',
  'precommit',
  'pre-push',
  'prepush',
  'gitHooks',
  'ghooks',
  'git-hooks',
  'yorkie',
  'lefthook',
  'overcommit',
] as const;
/** What a key of package.json that may set git hooks, though it is on no list, is named. */
export const POSSIBLE_HOOKS = 'possible git hook manager key';
/** A key whose name says it may set git hooks: it holds `hook`, `commit` or `push`. */
const HOOKISH_KEY = /hook|commit|push/i;
/** The most characters of what a hook manager runs that are read; a longer one is not read. */
const MAX_HOOK_VALUE = 64 * 1024;

/**
 * A hit for what a hook manager key holds, read whole or not at all: a value cut at its bound is
 * a failing entry that it was not read, never part of a command followed as if it were whole.
 */
function hookManagerHit(
  f: JsonFile,
  keys: readonly string[],
  name: string,
  value: unknown,
  known: boolean,
): AgentHit {
  const line = lineOf(f.text, keys.map(quoted));
  const text = boundedJson(value, MAX_HOOK_VALUE, true);
  if (text.length > MAX_HOOK_VALUE)
    return hit(
      'unreadable-config',
      f.path,
      line,
      name,
      `too long to read whole (${digestOf(text)})`,
    );
  const found = { ...hit('git-hook-file', f.path, line, name, text), severity: 'warning' as const };
  if (!known) return found;
  // A known manager runs the strings it holds; its keys (lint-staged's patterns) are not commands.
  return {
    ...found,
    runs: name.endsWith('lint-staged') ? lintStagedRuns(value) : stringsOf(value).join('\n'),
  };
}

/**
 * What a lint-staged config runs, as the reading of run files takes it: the strings it holds, and,
 * for a command that runs the files it is given, its pattern, which names what runs. A pattern
 * this does not read (a brace list, a class, a negation) could match any file: the command is then
 * one that cannot be read, which any change at all fails. For the `lint-staged` key of
 * package.json and for a `.lintstagedrc` alike.
 */
export function lintStagedRuns(value: unknown): string {
  const patterns = filesRunBy(value);
  // A pattern with no literal piece left once its wildcards, dots and slashes are off (`**`,
  // `**/*`, `*.*`) names no file the reading could follow, and matches any.
  if (patterns.some((p) => /[{}[\]!()\\]/.test(p) || fragmentsOf(p.toLowerCase()).length === 0))
    return UNREAD_PATTERN;
  return [...stringsOf(value), ...patterns].join('\n');
}

/** What a lint-staged entry runs when one of its patterns is not read: no command at all. */
export const UNREAD_PATTERN = '\u0000a pattern that is not read';

/**
 * Tools a lint-staged command may start that are followed by their own words, as any other entry
 * is. Every other program, one this does not know, a test runner, a shell, an interpreter, `.`,
 * `xargs` or a word that cannot be read, is taken to run the files it is given.
 */
const FOLLOWED_TOOLS: ReadonlySet<string> = new Set([
  'eslint',
  'prettier',
  'stylelint',
  'biome',
  'oxlint',
  'dprint',
  'tsc',
  'markdownlint',
  'markdownlint-cli2',
  'rustfmt',
  'gofmt',
  'black',
  'ruff',
  'isort',
]);
/** Words in front of the program of a command: a package runner, `run`, `--`, an assignment. */
const WRAPPER = /^(?:npx|pnpx|bunx|env|exec|dlx|pnpm|yarn|npm|run|--|[A-Za-z_][A-Za-z0-9_]*=.*)$/;
/**
 * Options in front of the program that take no value. Any other option there may take the next
 * word, or name the program itself (`npx -p eslint node`, `npm exec --call=x`): the command is
 * then not read.
 */
const FLAGS: ReadonlySet<string> = new Set([
  '-y',
  '--yes',
  '--no-install',
  '-q',
  '--quiet',
  '-s',
  '--silent',
]);
/** What makes a command more than one program with its words: a shell may run more. */
const SHELL_TEXT = /[;&|$`<>()\n\r]/;

/**
 * The program a command starts, past the words in front of it, by its base name, in lower case
 * and without `.exe`, `.cmd` or `.bat`; empty when that cannot be read.
 */
function programWord(command: string): string {
  if (SHELL_TEXT.test(command)) return '';
  for (const w of command.trim().split(/\s+/)) {
    if (WRAPPER.test(w) || FLAGS.has(w)) continue;
    if (w.startsWith('-')) return '';
    return posix
      .basename(w)
      .toLowerCase()
      .replace(/\.(?:exe|cmd|bat)$/, '');
  }
  return '';
}

/**
 * The patterns of a lint-staged config whose command is not one of the tools followed by their
 * own words: such a command runs the files the pattern matches. A value this does not read as
 * patterns and commands gives one pattern that matches anything, so every file counts.
 */
function filesRunBy(value: unknown): string[] {
  if (!isPlainObject(value)) return ['*'];
  return Object.entries(value).flatMap(([pattern, commands]) => {
    const list = typeof commands === 'string' ? [commands] : commands;
    if (!Array.isArray(list)) return ['*'];
    return list.some((c) => typeof c !== 'string' || !FOLLOWED_TOOLS.has(programWord(c)))
      ? [pattern]
      : [];
  });
}

/** Every string at or under `value`, in order. */
function stringsOf(value: unknown): string[] {
  const out: string[] = [];
  const stack = [value];
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    if (typeof next === 'string') out.push(next);
    else if (typeof next === 'object' && next !== null)
      stack.push(...Object.values(next).reverse());
  }
  return out;
}

export function packageScripts(f: JsonFile): AgentHit[] {
  const scripts = ownObject(f.value, 'scripts');
  const installs = Object.entries(scripts ?? {}).flatMap(([name, script]) => {
    if (!INSTALL_SCRIPTS.has(name) || typeof script !== 'string') return [];
    const kind = namesAgentPath(script) ? 'package-script-agent-path' : 'package-script';
    return [hit(kind, f.path, lineOf(f.text, ['"scripts"', quoted(name)]), name, script)];
  });
  // What a hook manager runs on a commit: listed, and a change that adds or edits it fails.
  const known: ReadonlySet<string> = new Set(HOOK_MANAGER_KEYS);
  const hooks: AgentHit[] = [];
  for (const [key, value] of Object.entries(f.value))
    if (known.has(key)) hooks.push(hookManagerHit(f, [key], key, value, true));
    else if (HOOKISH_KEY.test(key))
      hooks.push(hookManagerHit(f, [key], `${POSSIBLE_HOOKS} ${key}`, value, false));
  const config = ownObject(f.value, 'config');
  for (const [key, value] of Object.entries(config ?? {}))
    if (known.has(key))
      hooks.push(hookManagerHit(f, ['config', key], `config.${key}`, value, true));
    else if (HOOKISH_KEY.test(key))
      hooks.push(
        hookManagerHit(f, ['config', key], `${POSSIBLE_HOOKS} config.${key}`, value, false),
      );
  return byLine([...installs, ...hooks]);
}
