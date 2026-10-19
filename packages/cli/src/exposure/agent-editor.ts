import { INSTRUCTION_FILE, SELF_CONFIG_FILE } from '@stroq/core';
import { isPlainObject } from '../commands/config-file.js';
import {
  commandText,
  firstEntries,
  mcpServerHits,
  own,
  ownObject,
  ownString,
  quoted,
  strings,
  type JsonFile,
  type Obj,
} from './agent-json.js';
import { boundedJson, hit, type AgentHit } from './agent-kinds.js';
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
 * Everything a folder-open task runs: its command, the per-system commands that replace it,
 * and the tasks it depends on, which run first and need no `runOn` of their own.
 */
function taskRuns(task: Obj, byLabel: ReadonlyMap<string, Obj>, seen: Set<string>): string {
  const parts = [commandLine(task)];
  for (const os of OS_KEYS) {
    const variant = ownObject(task, os);
    const line = variant === undefined ? '' : commandLine(variant);
    if (line !== '') parts.push(`${os}: ${line}`);
  }
  const depends = own(task, 'dependsOn');
  const labels = typeof depends === 'string' ? [depends] : strings(depends);
  for (const label of labels) {
    const dependency = byLabel.get(label);
    if (dependency === undefined || seen.has(label) || seen.size >= MAX_DEPENDS) {
      parts.push(`then ${label}`);
      continue;
    }
    seen.add(label);
    parts.push(`then ${label}: ${taskRuns(dependency, byLabel, seen)}`);
  }
  return parts.filter((part) => part !== '').join(' | ');
}

const runsOnFolderOpen = (task: Obj): boolean => {
  const options = ownObject(task, 'runOptions');
  const runOn = options === undefined ? undefined : ownString(options, 'runOn');
  return runOn !== undefined && runOn.toLowerCase() === 'folderopen';
};

export function folderOpenTasks(f: JsonFile, list: unknown, prefix: readonly string[]): AgentHit[] {
  if (!Array.isArray(list)) return [];
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
  return [
    ...opening.cut,
    ...opening.items.flatMap(([task, i]) => {
      const label = labelOf(task);
      const seen = new Set(label === undefined ? [] : [label]);
      const line = lineOf(f.text, [...prefix, label === undefined ? '' : quoted(label), '"runOn"']);
      return [
        hit(
          'editor-autorun-task',
          f.path,
          line,
          label ?? `task ${i + 1}`,
          taskRuns(task, byLabel, seen),
        ),
      ];
    }),
  ];
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

export const vscodeTasks = (f: JsonFile): AgentHit[] =>
  folderOpenTasks(f, own(f.value, 'tasks'), ['"tasks"']);

export const codeWorkspace = (f: JsonFile): AgentHit[] => {
  const tasks = ownObject(f.value, 'tasks');
  return [
    ...vscodeSettings(f, ownObject(f.value, 'settings'), ['"settings"']),
    ...folderOpenTasks(f, tasks === undefined ? undefined : own(tasks, 'tasks'), [
      '"tasks"',
      '"tasks"',
    ]),
  ];
};

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

export function devcontainer(f: JsonFile): AgentHit[] {
  const hits: AgentHit[] = [];
  for (const key of [DEVCONTAINER_HOST_KEY, ...DEVCONTAINER_KEYS]) {
    const value = lifecycleText(own(f.value, key));
    if (value === undefined) continue;
    const kind =
      key === DEVCONTAINER_HOST_KEY ? 'devcontainer-host-command' : 'devcontainer-command';
    hits.push(hit(kind, f.path, lineOf(f.text, [quoted(key)]), key, value));
  }
  return hits;
}

// ---------------------------------------------------------------------------------------------
// package.json.

const INSTALL_SCRIPTS: ReadonlySet<string> = new Set([
  'preinstall',
  'install',
  'postinstall',
  'prepare',
  'prepublish',
]);
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
