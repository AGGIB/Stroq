import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  HOOK_TIMEOUT_SECONDS,
  isPlainObject,
  readJsonObject,
  withoutStroqGroups,
  writeJsonObject,
} from './config-file.js';

/**
 * The `PreToolUse` tools Stroq answers on Codex. Kept in step with
 * `CODEX_HIGH_IMPACT_TOOL` in `adapters/codex-input.ts`: the matcher decides which
 * events reach the hook, the regex decides which of them fail closed, and a Pre
 * event that reaches Stroq but is not fail-closed would be a hole in the same list.
 * Only `Bash`, `apply_patch` and `mcp__…` are documented by OpenAI; the other
 * spellings are defensive aliases, and matching a tool Codex never sends costs
 * nothing while missing one it does send costs the whole decision.
 */
export const CODEX_PRE_MATCHER =
  'Bash|exec_command|shell|local_shell|apply_patch|ApplyPatch|mcp__.*';
/** `PostToolUse` scans what the agent just read; an `apply_patch` result has nothing to scan. */
export const CODEX_POST_MATCHER = 'Bash|exec_command|shell|local_shell|mcp__.*';

/**
 * Every event Codex documents. Some community documentation shows the event map at
 * the root instead of under the official `hooks` wrapper, so these are the keys the
 * merge lifts out of the root and into `hooks`: guessing which shape a file "is"
 * cannot be done safely — a file carrying an event in each place has both, and
 * writing one shape while reading the other is how a hook gets silently dropped.
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

const groupsOf = (events: CodexEventMap, event: string): readonly CodexHookGroup[] => {
  const groups = events[event];
  return Array.isArray(groups) ? groups : [];
};

/** The `hooks` wrapper's own event map; `{}` unless it really is an object. */
function nestedEvents(settings: CodexHooksJson): CodexEventMap {
  // A `hooks` that is a string or an array is not an event map. Spreading an array
  // here would write numeric keys into the file and bury the events it does have.
  return isPlainObject(settings.hooks) ? (settings.hooks as unknown as CodexEventMap) : {};
}

/**
 * One root-level event value as hook groups, or `null` when it is not a shape that
 * can be lifted. An array is the documented root form; a bare group object is a
 * plausible hand-edit and is wrapped rather than lost. Anything else (a string, a
 * number, `null`) is left where it was found — Stroq cannot read it, and a key it
 * cannot read is not a key it may delete.
 */
function liftableGroups(value: unknown): readonly CodexHookGroup[] | null {
  if (Array.isArray(value)) return value as readonly CodexHookGroup[];
  if (isPlainObject(value)) return [value as unknown as CodexHookGroup];
  return null;
}

interface RootMerge {
  /** Every group the file declares per event, `hooks` first then the root. */
  readonly events: CodexEventMap;
  /** The root keys actually lifted — the only ones the root may lose. */
  readonly lifted: ReadonlySet<string>;
}

/**
 * The file is user-supplied JSON, so the casts here are a naming convenience only:
 * `groupsOf` and `withoutStroqGroups` re-check every value they read.
 */
function eventMapOf(settings: CodexHooksJson): RootMerge {
  const merged: Record<string, readonly CodexHookGroup[]> = { ...nestedEvents(settings) };
  const lifted = new Set<string>();
  for (const name of CODEX_EVENT_NAMES) {
    const groups = liftableGroups(settings[name]);
    if (groups === null) continue;
    merged[name] = [...groupsOf(merged, name), ...groups];
    lifted.add(name);
  }
  return { events: merged, lifted };
}

/** Everything the merge does not rewrite itself, preserved untouched. */
const otherKeys = (
  settings: CodexHooksJson,
  lifted: ReadonlySet<string>,
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(settings).filter(([key]) => key !== 'hooks' && !lifted.has(key)),
  );

const mergeGroups = (
  groups: readonly CodexHookGroup[],
  matcher: string,
  command: string,
): CodexHookGroup[] => [
  ...withoutStroqGroups<CodexHookGroup>(groups, (handler) =>
    isStroqCodexHook(handler as CodexHookHandler),
  ),
  { matcher, hooks: [codexHandler(command)] },
];

/**
 * Adds Stroq's group to `PreToolUse` and `PostToolUse`, dropping any older Stroq
 * group first, so re-running `init` is idempotent and an upgrade replaces the
 * command rather than stacking a second one. Foreign groups, foreign events and any
 * other key of the file are preserved untouched.
 *
 * The result is always the official nested shape: an event the file kept at the
 * root is moved under `hooks` with its groups intact rather than left where a
 * `hooks`-reading Codex might not look for it. Nothing is dropped — an event
 * declared in both places keeps both (`hooks` first), and a root value that is
 * neither an array nor a group object is left at the root exactly as it was.
 */
export function mergeCodexHooks(settings: CodexHooksJson, command: string): CodexHooksJson {
  const { events, lifted } = eventMapOf(settings);
  return {
    ...otherKeys(settings, lifted),
    hooks: {
      ...events,
      PreToolUse: mergeGroups(groupsOf(events, 'PreToolUse'), CODEX_PRE_MATCHER, command),
      PostToolUse: mergeGroups(groupsOf(events, 'PostToolUse'), CODEX_POST_MATCHER, command),
    },
  };
}

/**
 * True when Stroq's handler is registered under the official `hooks` wrapper —
 * the only place `init` writes it, and so the only place `doctor` may call it
 * installed. An entry the file still keeps at the root reports as not installed:
 * re-running `init` migrates it, and reporting it as installed would leave a user
 * whose Codex build only reads `hooks` believing they were protected.
 */
export function hasStroqCodexHook(settings: CodexHooksJson): boolean {
  return Object.values(nestedEvents(settings))
    .flatMap((groups): readonly unknown[] => (Array.isArray(groups) ? groups : []))
    .some(
      (group) =>
        isPlainObject(group) &&
        Array.isArray(group['hooks']) &&
        group['hooks'].some((handler: unknown) => isStroqCodexHook(handler as CodexHookHandler)),
    );
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
