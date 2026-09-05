import { homedir } from 'node:os';
import { join } from 'node:path';
import { HOOK_TIMEOUT_SECONDS, readJsonObject, writeJsonObject } from './config-file.js';

/**
 * The `PreToolUse` tools Stroq answers on Codex. Kept in step with
 * `CODEX_HIGH_IMPACT_TOOL` in `adapters/codex.ts`: the matcher decides which events
 * reach the hook, the regex decides which of them fail closed, and a Pre event that
 * reaches Stroq but is not fail-closed would be a hole in the same list.
 */
export const CODEX_PRE_MATCHER = 'Bash|apply_patch|mcp__.*';
/** `PostToolUse` scans what the agent just read; an `apply_patch` result has nothing to scan. */
export const CODEX_POST_MATCHER = 'Bash|mcp__.*';

/**
 * Every event Codex documents. Used only to recognise a file that keeps the event
 * map at the root instead of under the official `hooks` wrapper — a file whose only
 * hook is on `SessionStart` is still a flat file, and rewriting it into the nested
 * shape would silently drop that hook.
 */
export const CODEX_EVENT_NAMES: readonly string[] = [
  'SessionStart',
  'SessionEnd',
  'SubagentStart',
  'SubagentStop',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'PreCompact',
  'PostCompact',
  'UserPromptSubmit',
  'Stop',
  'Interrupt',
];

export interface CodexHookHandler {
  readonly type: 'command';
  readonly command: string;
  /** Seconds. Codex's default is 600; Stroq keeps the same 15 s both other agents use. */
  readonly timeout: number;
  readonly statusMessage: string;
}

export interface CodexHookGroup {
  readonly matcher: string;
  readonly hooks: readonly CodexHookHandler[];
}

export type CodexEventMap = Readonly<Record<string, readonly CodexHookGroup[]>>;

export type CodexHooksJson = {
  readonly hooks?: CodexEventMap;
} & Record<string, unknown>;

export const codexHandler = (command: string): CodexHookHandler => ({
  type: 'command',
  command,
  timeout: HOOK_TIMEOUT_SECONDS,
  statusMessage: 'Stroq',
});

/** Stroq's own entries, identified by the command suffix `init` writes. */
export const isStroqCodexHook = (handler: CodexHookHandler): boolean =>
  typeof handler?.command === 'string' && / hook codex$/.test(handler.command);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * True when the file keeps the event map at the root. A `hooks` object always wins:
 * that is the official shape, and a file carrying both is nested with extra keys.
 */
function isFlatShape(settings: CodexHooksJson): boolean {
  if (isRecord(settings['hooks'])) return false;
  return CODEX_EVENT_NAMES.some((name) => Array.isArray(settings[name]));
}

/**
 * The event map, whichever shape the file uses. The file is user-supplied JSON, so
 * the cast is a naming convenience only: `groupsOf` re-checks every array it reads.
 */
const eventMapOf = (settings: CodexHooksJson, flat: boolean): CodexEventMap =>
  (flat ? settings : (settings.hooks ?? {})) as unknown as CodexEventMap;

const groupsOf = (events: CodexEventMap, event: string): readonly CodexHookGroup[] => {
  const groups = events[event];
  return Array.isArray(groups) ? groups : [];
};

function withoutStroq(groups: readonly CodexHookGroup[]): CodexHookGroup[] {
  return groups
    .map((g) =>
      Array.isArray(g.hooks) ? { ...g, hooks: g.hooks.filter((h) => !isStroqCodexHook(h)) } : g,
    )
    .filter((g) => !Array.isArray(g.hooks) || g.hooks.length > 0);
}

const mergeGroups = (
  groups: readonly CodexHookGroup[],
  matcher: string,
  command: string,
): CodexHookGroup[] => [...withoutStroq(groups), { matcher, hooks: [codexHandler(command)] }];

/**
 * Adds Stroq's group to `PreToolUse` and `PostToolUse`, dropping any older Stroq
 * group first, so re-running `init` is idempotent and an upgrade replaces the
 * command rather than stacking a second one. Foreign groups, foreign events and any
 * other key of the file are preserved untouched, and the file keeps whichever shape
 * it already used — a new file gets the official nested one.
 */
export function mergeCodexHooks(settings: CodexHooksJson, command: string): CodexHooksJson {
  const flat = isFlatShape(settings);
  const events = eventMapOf(settings, flat);
  const merged: CodexEventMap = {
    ...events,
    PreToolUse: mergeGroups(groupsOf(events, 'PreToolUse'), CODEX_PRE_MATCHER, command),
    PostToolUse: mergeGroups(groupsOf(events, 'PostToolUse'), CODEX_POST_MATCHER, command),
  };
  if (!flat) return { ...settings, hooks: merged };
  // The flat shape puts the event arrays at the top level, where `CodexHooksJson`'s
  // index signature already allows them; the cast only tells TypeScript that the
  // spread did not replace the optional `hooks` key with a bare array of groups.
  return { ...settings, ...merged } as unknown as CodexHooksJson;
}

/** True when Stroq's handler is registered anywhere in the file, in either shape. */
export function hasStroqCodexHook(settings: CodexHooksJson): boolean {
  const events = eventMapOf(settings, isFlatShape(settings));
  return Object.values(events)
    .flatMap((groups) => (Array.isArray(groups) ? groups : []))
    .some((group) => Array.isArray(group?.hooks) && group.hooks.some(isStroqCodexHook));
}

export function codexHooksPath(scope: 'project' | 'user', cwd: string = process.cwd()): string {
  return scope === 'user'
    ? join(homedir(), '.codex', 'hooks.json')
    : join(cwd, '.codex', 'hooks.json');
}

export const readCodexHooks = (file: string): CodexHooksJson =>
  readJsonObject<CodexHooksJson>(file);

export function installCodexHooks(file: string, command: string): CodexHooksJson {
  const merged = mergeCodexHooks(readCodexHooks(file), command);
  writeJsonObject(file, merged);
  return merged;
}
