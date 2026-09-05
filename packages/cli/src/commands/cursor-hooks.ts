import { homedir } from 'node:os';
import { join } from 'node:path';
import { CURSOR_BLOCKING_EVENTS, CURSOR_EVENTS, type CursorEvent } from '../adapters/cursor.js';
import { HOOK_TIMEOUT_SECONDS, readJsonObject, writeJsonObject } from './config-file.js';

/** The `hooks.json` format version Stroq writes. */
export const CURSOR_HOOKS_VERSION = 1;

export interface CursorHookEntry {
  readonly command: string;
  readonly timeout?: number;
  /** Cursor treats a non-zero exit as "allow" unless this is set. */
  readonly failClosed?: boolean;
}

export type CursorHooksJson = {
  readonly version?: number;
  readonly hooks?: Readonly<Record<string, readonly CursorHookEntry[]>>;
} & Record<string, unknown>;

/** Stroq's own entries, identified by the command suffix `init` writes. */
export const isStroqCursorHook = (entry: CursorHookEntry): boolean =>
  typeof entry?.command === 'string' && / hook cursor$/.test(entry.command);

/**
 * `failClosed` only on the two events where a deny stops something: on the other
 * four a hook crash must not stall the agent, since there is nothing to block.
 */
export function cursorEntry(event: CursorEvent, command: string): CursorHookEntry {
  return CURSOR_BLOCKING_EVENTS.includes(event)
    ? { command, failClosed: true, timeout: HOOK_TIMEOUT_SECONDS }
    : { command, timeout: HOOK_TIMEOUT_SECONDS };
}

function existingEntries(
  hooks: Readonly<Record<string, readonly CursorHookEntry[]>>,
  event: CursorEvent,
): readonly CursorHookEntry[] {
  const entries = hooks[event];
  return Array.isArray(entries) ? entries : [];
}

/**
 * Adds Stroq's entry to each of the six events, dropping any older Stroq entry
 * first, so re-running `init` is idempotent and an upgrade replaces the command
 * rather than stacking a second one. Foreign entries and foreign events (and any
 * other key of the file) are preserved untouched.
 */
export function mergeCursorHooks(settings: CursorHooksJson, command: string): CursorHooksJson {
  const hooks = settings.hooks ?? {};
  const ours = Object.fromEntries(
    CURSOR_EVENTS.map((event): [CursorEvent, CursorHookEntry[]] => [
      event,
      [
        ...existingEntries(hooks, event).filter((entry) => !isStroqCursorHook(entry)),
        cursorEntry(event, command),
      ],
    ]),
  );
  return { ...settings, version: CURSOR_HOOKS_VERSION, hooks: { ...hooks, ...ours } };
}

export function cursorHooksPath(scope: 'project' | 'user', cwd: string = process.cwd()): string {
  return scope === 'user'
    ? join(homedir(), '.cursor', 'hooks.json')
    : join(cwd, '.cursor', 'hooks.json');
}

export const readCursorHooks = (file: string): CursorHooksJson =>
  readJsonObject<CursorHooksJson>(file);

export function installCursorHooks(file: string, command: string): CursorHooksJson {
  const merged = mergeCursorHooks(readCursorHooks(file), command);
  writeJsonObject(file, merged);
  return merged;
}
