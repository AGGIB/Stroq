import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Seconds Stroq writes on every hook entry it installs for Claude Code, Cursor and
 * Codex. Copilot is the exception and has its own `COPILOT_HOOK_TIMEOUT_SECONDS`:
 * there a timeout is an ALLOW, so a shorter budget is less safe rather than more.
 */
export const HOOK_TIMEOUT_SECONDS = 15;

/**
 * How much of the host agent's timeout Stroq allows itself before answering with a
 * fail-closed verdict of its own.
 *
 * Every agent that times a hook out treats the timeout as an allow — Claude Code
 * cancels the hook and lets the tool call continue through the normal permission
 * flow, Codex reports a hook failure and proceeds, Copilot discards the late deny —
 * so a hook that runs long does not merely lose its explanation, it loses its
 * verdict. Stroq answers first: 60% leaves room for process teardown and for a
 * machine slower than the one that measured this.
 *
 * The margin over real work: the only wall-clock budget in the decision path is the
 * scanner's `DEFAULT_BUDGET_MS`, and a cold Node start is around 100 ms. That budget
 * is 4,000 ms, so the worst case answers at about 4.1 s against this deadline's
 * 9,000 ms. It was 500 ms when this paragraph was first written, and the number is
 * repeated here rather than imported because the two are a RELATIONSHIP — if the
 * scanner's budget ever approaches this deadline, a slow scan stops being answered
 * by Stroq and starts being answered by the agent's timeout, which every agent
 * treats as an allow.
 */
export const HOOK_DEADLINE_FRACTION = 0.6;

export const hookDeadlineMs = (agentTimeoutSeconds: number): number =>
  Math.round(agentTimeoutSeconds * 1000 * HOOK_DEADLINE_FRACTION);

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
