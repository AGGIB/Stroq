import { INSTRUCTION_FILE, SELF_CONFIG_FILE } from '@stroq/core';
import { isPlainObject } from '../commands/config-file.js';
import {
  commandText,
  firstEntries,
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
import { boundedJson, byLine, hit, otherFields, type AgentHit } from './agent-kinds.js';
import { lineOf } from './jsonc.js';
import { autoApproves } from './privilege-surface.js';

/**
 * Readers for the files an editor, a dev container or npm run by themselves: VS Code tasks and
 * settings, `.code-workspace` files, `devcontainer.json` and the install scripts of `package.json`.
 * Like the readers in `agent-json.ts`, every key is read with `Object.hasOwn` and every value is
 * checked for its type first.
 */
// ---------------------------------------------------------------------------------------------
// VS Code: tasks that run on folder open, and the settings that let them.

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

const runsOnFolderOpen = (task: Obj): boolean => {
  const options = ownObject(task, 'runOptions');
  const runOn = options === undefined ? undefined : ownString(options, 'runOn');
  return runOn !== undefined && runOn.toLowerCase() === 'folderopen';
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
    tasks.flatMap((task, i) => (runsOnFolderOpen(task) ? [[task, i] as const] : [])),
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
      `${taskRuns(task, ctx, seen, false)}${shared}`,
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
  for (const key of [...AUTO_APPROVE_KEYS, TERMINAL_AUTO_APPROVE]) {
    const value = own(settings, key);
    const approves = key === TERMINAL_AUTO_APPROVE ? approvesTerminal(value) : autoApproves(value);
    if (approves)
      hits.push(
        hit(
          'agent-permission-bypass',
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
 * commands then reach. Each fails unless what it holds is proven to stay inside.
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

/** `docker run` options that give a container nothing of this machine, with and without a value. */
const PLAIN_RUN_FLAGS: ReadonlySet<string> = new Set([
  '--init',
  '--rm',
  '-i',
  '-t',
  '-it',
  '--tty',
]);
const PLAIN_RUN_OPTIONS: ReadonlySet<string> = new Set([
  '--name',
  '--hostname',
  '--shm-size',
  '--label',
  '--memory',
  '--cpus',
]);

/** Whether every `runArgs` word is a plain flag, or a plain option with its value. */
function runArgsStayInside(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  for (let i = 0; i < value.length; i += 1) {
    const arg = value[i];
    if (typeof arg !== 'string') return false;
    if (PLAIN_RUN_FLAGS.has(arg)) continue;
    const eq = arg.indexOf('=');
    if (PLAIN_RUN_OPTIONS.has(eq === -1 ? arg : arg.slice(0, eq))) {
      if (eq === -1) i += 1;
      continue;
    }
    return false;
  }
  return true;
}

/** The fields of a mount, from `source=...,target=...,type=...` or an object. */
function mountFields(mount: unknown): { source: string; type: string } | undefined {
  if (typeof mount === 'string') {
    const fields = new Map<string, string>();
    for (const part of mount.split(',')) {
      const eq = part.indexOf('=');
      if (eq !== -1) fields.set(part.slice(0, eq).trim().toLowerCase(), part.slice(eq + 1).trim());
    }
    return {
      source: fields.get('source') ?? fields.get('src') ?? '',
      type: fields.get('type') ?? '',
    };
  }
  if (!isPlainObject(mount)) return undefined;
  const source = argText(own(mount, 'source')) ?? argText(own(mount, 'src')) ?? '';
  return { source, type: argText(own(mount, 'type')) ?? '' };
}

const WORKSPACE = '${localWorkspaceFolder}';

/**
 * Whether a mount is proven to give the container nothing of this machine but the workspace: a
 * named volume or a tmpfs, or a bind of the workspace or a folder in it.
 */
function mountStaysInside(mount: unknown): boolean {
  const fields = mountFields(mount);
  if (fields === undefined) return false;
  const { source, type } = fields;
  if (type === 'volume' || type === 'tmpfs') return !/[\\/$~.%]/.test(source);
  if (source !== WORKSPACE && !source.startsWith(`${WORKSPACE}/`)) return false;
  const rest = source.slice(WORKSPACE.length);
  return !rest.includes('$') && !rest.split('/').includes('..');
}

/** Whether what an access key holds is proven to give the container nothing of this machine. */
function staysInside(key: (typeof DEVCONTAINER_ACCESS_KEYS)[number], value: unknown): boolean {
  if (key === 'mounts') return Array.isArray(value) && value.every(mountStaysInside);
  if (key === 'workspaceMount') return mountStaysInside(value);
  if (key === 'runArgs') return runArgsStayInside(value);
  if (key === 'privileged') return value === false;
  return Array.isArray(value) && value.length === 0;
}

function devcontainerAccess(f: JsonFile): AgentHit[] {
  const hits: AgentHit[] = [];
  for (const key of DEVCONTAINER_ACCESS_KEYS) {
    if (!Object.hasOwn(f.value, key)) continue;
    const value = f.value[key];
    if (staysInside(key, value)) continue;
    const found = hit(
      'devcontainer-command',
      f.path,
      lineOf(f.text, [quoted(key)]),
      key,
      boundedJson(value),
    );
    hits.push({ ...found, severity: 'error' });
  }
  const features = ownObject(f.value, DEVCONTAINER_FEATURES);
  if (features !== undefined && Object.keys(features).length > 0)
    hits.push(
      hit(
        'devcontainer-command',
        f.path,
        lineOf(f.text, [quoted(DEVCONTAINER_FEATURES)]),
        DEVCONTAINER_FEATURES,
        boundedJson(features, undefined, true),
      ),
    );
  return hits;
}

export function devcontainer(f: JsonFile): AgentHit[] {
  const hits: AgentHit[] = devcontainerAccess(f);
  for (const key of [DEVCONTAINER_HOST_KEY, ...DEVCONTAINER_KEYS]) {
    const value = lifecycleText(own(f.value, key));
    if (value === undefined) continue;
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

export function packageScripts(f: JsonFile): AgentHit[] {
  const scripts = ownObject(f.value, 'scripts');
  return Object.entries(scripts ?? {}).flatMap(([name, script]) => {
    if (!INSTALL_SCRIPTS.has(name) || typeof script !== 'string') return [];
    const kind = namesAgentPath(script) ? 'package-script-agent-path' : 'package-script';
    return [hit(kind, f.path, lineOf(f.text, ['"scripts"', quoted(name)]), name, script)];
  });
}
