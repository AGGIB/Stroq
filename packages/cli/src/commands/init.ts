import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { CURSOR_EVENTS } from '../adapters/cursor.js';
import { HOOK_TIMEOUT_SECONDS, readJsonObject, writeJsonObject } from './config-file.js';
import {
  cursorHooksPath,
  installCursorHooks,
  mergeCursorHooks,
  readCursorHooks,
} from './cursor-hooks.js';

export const PRE_MATCHER = 'Bash|Write|Edit|MultiEdit|NotebookEdit|Read|WebFetch|mcp__.*';
export const POST_MATCHER = 'Read|WebFetch|WebSearch|Bash|Grep|mcp__.*';

/** Agents `stroq init --agent <name>` can install hooks for. */
export type HookAgent = 'claude-code' | 'cursor';
export const HOOK_AGENTS: readonly HookAgent[] = ['claude-code', 'cursor'];

export interface HookHandler {
  readonly type: 'command';
  readonly command: string;
  readonly timeout: number;
}
export interface HookGroup {
  readonly matcher: string;
  readonly hooks: readonly HookHandler[];
}
export type SettingsJson = {
  readonly hooks?: Readonly<Record<string, readonly HookGroup[]>>;
} & Record<string, unknown>;

/**
 * The command an agent runs for every hook event. The trailing agent name is
 * also how `init` recognises its own entries when re-installing, so it must stay
 * at the end of the string (see `isStroqHandler` / `isStroqCursorHook`).
 */
export function hookCommand(node: string, entry: string, agent: HookAgent = 'claude-code'): string {
  const loader = entry.endsWith('.ts') ? ' --import tsx' : '';
  return `"${node}"${loader} "${entry}" hook ${agent}`;
}

export const stroqHandler = (command: string): HookHandler => ({
  type: 'command',
  command,
  timeout: HOOK_TIMEOUT_SECONDS,
});
export const isStroqHandler = (handler: HookHandler): boolean =>
  / hook claude-code$/.test(handler.command);

function withoutStroq(groups: readonly HookGroup[]): HookGroup[] {
  return groups
    .map((g) =>
      Array.isArray(g.hooks) ? { ...g, hooks: g.hooks.filter((h) => !isStroqHandler(h)) } : g,
    )
    .filter((g) => !Array.isArray(g.hooks) || g.hooks.length > 0);
}

export function mergeHooks(settings: SettingsJson, command: string): SettingsJson {
  const hooks = settings.hooks ?? {};
  return {
    ...settings,
    hooks: {
      ...hooks,
      PreToolUse: [
        ...withoutStroq(hooks['PreToolUse'] ?? []),
        { matcher: PRE_MATCHER, hooks: [stroqHandler(command)] },
      ],
      PostToolUse: [
        ...withoutStroq(hooks['PostToolUse'] ?? []),
        { matcher: POST_MATCHER, hooks: [stroqHandler(command)] },
      ],
    },
  };
}

export function settingsPath(scope: 'project' | 'user', cwd: string = process.cwd()): string {
  return scope === 'user'
    ? join(homedir(), '.claude', 'settings.json')
    : join(cwd, '.claude', 'settings.json');
}

export const readSettings = (file: string): SettingsJson => readJsonObject<SettingsJson>(file);

export function installHooks(file: string, command: string): SettingsJson {
  const merged = mergeHooks(readSettings(file), command);
  writeJsonObject(file, merged);
  return merged;
}

function initClaudeCode(scope: 'project' | 'user', command: string, dryRun: boolean): number {
  const file = settingsPath(scope);
  if (dryRun) {
    process.stdout.write(`${JSON.stringify(mergeHooks(readSettings(file), command), null, 2)}\n`);
    return 0;
  }
  installHooks(file, command);
  process.stdout.write(
    `Stroq hooks installed in ${file}\n  PreToolUse  → ${PRE_MATCHER}\n  PostToolUse → ${POST_MATCHER}\nRun "stroq doctor" to verify.\n`,
  );
  return 0;
}

function initCursor(scope: 'project' | 'user', command: string, dryRun: boolean): number {
  const file = cursorHooksPath(scope);
  if (dryRun) {
    process.stdout.write(
      `${JSON.stringify(mergeCursorHooks(readCursorHooks(file), command), null, 2)}\n`,
    );
    return 0;
  }
  installCursorHooks(file, command);
  process.stdout.write(
    `Stroq hooks installed in ${file}\n  ${CURSOR_EVENTS.join('\n  ')}\nRestart Cursor, then run "stroq doctor" to verify.\n`,
  );
  return 0;
}

export async function runInit(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    options: {
      user: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      agent: { type: 'string', default: 'claude-code' },
    },
  });
  const agent = values.agent ?? 'claude-code';
  if (!HOOK_AGENTS.includes(agent as HookAgent)) {
    process.stdout.write(`unknown agent "${agent}" (supported: ${HOOK_AGENTS.join(', ')})\n`);
    return 1;
  }
  const scope = values.user ? 'user' : 'project';
  const dryRun = values['dry-run'] === true;
  const command = hookCommand(process.execPath, resolve(process.argv[1] ?? ''), agent as HookAgent);
  return agent === 'cursor'
    ? initCursor(scope, command, dryRun)
    : initClaudeCode(scope, command, dryRun);
}
