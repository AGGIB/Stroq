import { posix } from 'node:path';
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

/** The one top-level key that only names the container. */
const COSMETIC_KEY = 'name';
/** What a hit for a file the container builds from is named, and one for a change to that file. */
export const BUILD_FILE = 'build file';
export const BUILD_FILE_CHANGED = 'build file changed';

/**
 * `customizations` without what only dresses the editor: the VS Code extensions and the JetBrains
 * settings. Anything else in it (VS Code's `settings`, another tool's block) is a setting of what
 * runs in the container. Undefined when nothing is left.
 */
function customizationsThatMatter(value: unknown): unknown {
  if (!isPlainObject(value)) return value;
  const rest: Obj = {};
  for (const [tool, block] of Object.entries(value)) {
    if (tool === 'jetbrains') continue;
    if (tool === 'vscode' && isPlainObject(block)) {
      const { extensions: _extensions, ...other } = block;
      if (Object.keys(other).length > 0) rest[tool] = other;
      continue;
    }
    rest[tool] = block;
  }
  return Object.keys(rest).length === 0 ? undefined : rest;
}

/** The repository path of a file a dev container at `path` names, or undefined out of it. */
function besideFile(path: string, name: string): string | undefined {
  const folder = posix.dirname(path);
  const joined = posix.normalize(posix.join(folder === '.' ? '' : folder, name));
  return joined === '..' || joined.startsWith('../') || posix.isAbsolute(name) ? undefined : joined;
}

/** The Dockerfile and the compose files a dev container builds from, as repository paths. */
function buildFiles(f: JsonFile): string[] {
  const build = ownObject(f.value, 'build');
  const named = [
    ...strings([own(f.value, 'dockerFile'), own(f.value, 'dockerfile')]),
    ...(build === undefined ? [] : strings([own(build, 'dockerfile'), own(build, 'dockerFile')])),
    ...(typeof own(f.value, 'dockerComposeFile') === 'string'
      ? [own(f.value, 'dockerComposeFile') as string]
      : strings(own(f.value, 'dockerComposeFile'))),
  ];
  return [...new Set(named.flatMap((name) => besideFile(f.path, name) ?? []))];
}

/**
 * Every other key of a dev container, but its name: each decides what is built or what runs, so
 * one a change adds or edits fails. The keys that give it this machine are errors wherever they
 * are. `features` stays a command, since what it installs runs as one.
 */
function devcontainerSettings(f: JsonFile): AgentHit[] {
  const hits: AgentHit[] = [];
  const commands: ReadonlySet<string> = new Set([
    DEVCONTAINER_HOST_KEY,
    ...DEVCONTAINER_KEYS,
    DEVCONTAINER_FEATURES,
    COSMETIC_KEY,
  ]);
  for (const [key, raw] of Object.entries(f.value)) {
    if (commands.has(key)) continue;
    const value = key === 'customizations' ? customizationsThatMatter(raw) : raw;
    if (value === undefined) continue;
    const found = hit(
      'devcontainer-setting',
      f.path,
      lineOf(f.text, [quoted(key)]),
      key,
      boundedJson(value, undefined, true),
    );
    const access = (DEVCONTAINER_ACCESS_KEYS as readonly string[]).includes(key);
    hits.push(access ? { ...found, severity: 'error' } : found);
  }
  for (const file of buildFiles(f))
    hits.push(hit('devcontainer-setting', f.path, 1, BUILD_FILE, file));
  return hits;
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

export function packageScripts(f: JsonFile): AgentHit[] {
  const scripts = ownObject(f.value, 'scripts');
  return Object.entries(scripts ?? {}).flatMap(([name, script]) => {
    if (!INSTALL_SCRIPTS.has(name) || typeof script !== 'string') return [];
    const kind = namesAgentPath(script) ? 'package-script-agent-path' : 'package-script';
    return [hit(kind, f.path, lineOf(f.text, ['"scripts"', quoted(name)]), name, script)];
  });
}
