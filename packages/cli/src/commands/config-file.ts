import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Seconds Stroq writes on every hook entry it installs for Claude Code, Cursor and
 * Codex. Copilot is the exception and has its own `COPILOT_HOOK_TIMEOUT_SECONDS`:
 * there a timeout is an ALLOW, so a shorter budget is less safe rather than more.
 */
export const HOOK_TIMEOUT_SECONDS = 15;

/** Reads an agent's JSON config. A missing or empty file is an empty object. */
export function readJsonObject<T extends object>(file: string): T {
  if (!existsSync(file)) return {} as T;
  const text = readFileSync(file, 'utf8');
  if (text.trim().length === 0) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new Error(`cannot parse ${file}: ${(err as Error).message}`, { cause: err });
  }
}

/** Writes an agent's JSON config with a trailing newline, creating its directory. */
export function writeJsonObject(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** A plain JSON object — not an array, not `null`. */
export const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * One event's hook groups with Stroq's own handlers removed, so re-installing
 * replaces the entry instead of stacking a second one. Shared by the Claude Code
 * and Codex installers, which differ only in how they recognise their own handler.
 *
 * A "group" that is not an object at all (a `null` left by a hand-edit, a bare
 * string) is dropped: reading `.hooks` off it is how this used to throw and take
 * the whole install down with it, and it is not user content worth preserving. A
 * group whose `hooks` is not an array is kept untouched — malformed, but the
 * user's, and rewriting it would lose a hook Stroq does not own.
 */
export function withoutStroqGroups<T>(
  groups: readonly unknown[],
  isOurs: (handler: unknown) => boolean,
): T[] {
  return groups
    .filter(isPlainObject)
    .map((group) =>
      Array.isArray(group['hooks'])
        ? { ...group, hooks: group['hooks'].filter((handler: unknown) => !isOurs(handler)) }
        : group,
    )
    .filter((group) => !Array.isArray(group['hooks']) || group['hooks'].length > 0) as T[];
}
