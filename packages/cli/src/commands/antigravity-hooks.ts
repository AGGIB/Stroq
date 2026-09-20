import { homedir } from 'node:os';
import { join } from 'node:path';
import { isPlainObject, readJsonObject, writeJsonObject } from './config-file.js';

/**
 * Antigravity's hooks file is keyed by a hook NAME at the top level, which no other
 * supported format is:
 *
 * ```json
 * { "my-linter-hook": { "PostToolUse": [ { "matcher": "run_command", "hooks": [ … ] } ] } }
 * ```
 *
 * That makes merging simpler and safer than for Cursor or Windsurf, where Stroq's
 * entries share an array with the user's. Here Stroq owns ONE key — `stroq` — and
 * rewrites it whole, so re-running `init` is idempotent by construction and every
 * other hook name in the file, and every other key of it, is left untouched. A hook
 * of your own belongs under a name of your own, not inside this one.
 */

/** The top-level key Stroq owns. Everything beside it is somebody else's hook. */
export const ANTIGRAVITY_HOOK_NAME = 'stroq';

/**
 * The three events Stroq installs on, in the order `init` writes them.
 *
 * `PostInvocation` and `Stop` are deliberately absent: neither carries a tool call or
 * any untrusted content, and `Stop`'s only output is whether to keep going, which is
 * not a firewall's decision to make.
 */
export const ANTIGRAVITY_HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'PreInvocation'] as const;
export type AntigravityHookEvent = (typeof ANTIGRAVITY_HOOK_EVENTS)[number];

/**
 * Seconds. Antigravity's own default for a handler, and deliberately not the
 * `HOOK_TIMEOUT_SECONDS` three of the other agents get.
 *
 * What a timed-out or failed Antigravity hook does is UNDOCUMENTED. If it fails open
 * a longer budget is strictly safer; if it fails closed a longer budget only delays
 * an answer Stroq produces in well under a second either way. There is no reading
 * under which a shorter one is safer, so the larger default stands — the same
 * conclusion the Copilot adapter reached from a documented fail-open rather than from
 * a silence.
 */
export const ANTIGRAVITY_HOOK_TIMEOUT_SECONDS = 30;

export interface AntigravityHandler {
  readonly type: 'command';
  readonly command: string;
  /** Seconds; Antigravity's own default, which is not the other agents' value. */
  readonly timeout: number;
}

/** A `PreToolUse`/`PostToolUse` entry: a tool-name regex and the handlers it fires. */
export interface AntigravityMatcherGroup {
  readonly matcher: string;
  readonly hooks: readonly AntigravityHandler[];
}

export interface AntigravityHook {
  /** Written explicitly although `true` is the default; see `buildAntigravityHook`. */
  readonly enabled: true;
  readonly PreToolUse: readonly AntigravityMatcherGroup[];
  readonly PostToolUse: readonly AntigravityMatcherGroup[];
  /** Handlers sit directly under the key: the matcher is ignored for this event. */
  readonly PreInvocation: readonly AntigravityHandler[];
}

/** What might actually be on disk: any JSON object, hook names Stroq did not write included. */
export type AntigravityHooksJson = Record<string, unknown>;

/** Stroq's own handlers, identified by the command suffix `init` writes. */
const STROQ_ANTIGRAVITY_COMMAND = / hook antigravity (pre|post|preinvocation)$/;

const handler = (command: string): AntigravityHandler => ({
  type: 'command',
  command,
  timeout: ANTIGRAVITY_HOOK_TIMEOUT_SECONDS,
});

/**
 * Stroq's whole entry.
 *
 * `enabled: true` is written although it is the default, because it is the one field
 * that switches Stroq off while the handlers still look installed — so writing it
 * means re-running `init` repairs an `enabled: false` rather than leaving it in
 * place, and `stroq doctor` can call an entry carrying it "not installed".
 *
 * The matcher on both tool events is `""`, which means every tool. A matcher is a
 * regex over the tool NAME and Antigravity's hooks never reveal an MCP server, so any
 * list Stroq could write would be a list of the tools it already knows about — and
 * the MCP call it has never heard of would be the one that skipped the hook. Every
 * tool goes through Stroq instead; one it does not care about returns in a few
 * milliseconds.
 *
 * Each event gets its own phase argument, because none of the three payloads names
 * the event it came from.
 */
export function buildAntigravityHook(command: string): AntigravityHook {
  return {
    enabled: true,
    PreToolUse: [{ matcher: '', hooks: [handler(`${command} pre`)] }],
    PostToolUse: [{ matcher: '', hooks: [handler(`${command} post`)] }],
    // Not a matcher group: for `PreInvocation` the matcher is ignored and the
    // handlers sit directly under the event key. A group here is a hook that never
    // runs.
    PreInvocation: [handler(`${command} preinvocation`)],
  };
}

/** Stroq owns one key and rewrites it whole; everything else in the file is preserved. */
export const mergeAntigravityHooks = (
  settings: AntigravityHooksJson,
  command: string,
): AntigravityHooksJson => ({
  ...settings,
  [ANTIGRAVITY_HOOK_NAME]: buildAntigravityHook(command),
});

const isStroqHandler = (value: unknown): boolean =>
  isPlainObject(value) &&
  typeof value['command'] === 'string' &&
  STROQ_ANTIGRAVITY_COMMAND.test(value['command']);

/**
 * Whether one event of Stroq's entry carries a Stroq handler, under either shape:
 * matcher groups for the two tool events, bare handlers for `PreInvocation`.
 */
function eventHasStroqHandler(entry: Readonly<Record<string, unknown>>, event: string): boolean {
  const value = entry[event];
  if (!Array.isArray(value)) return false;
  return value.some((item) => {
    if (isStroqHandler(item)) return true;
    if (!isPlainObject(item)) return false;
    const hooks = item['hooks'];
    return Array.isArray(hooks) && hooks.some(isStroqHandler);
  });
}

/**
 * True only when Stroq's entry is present, not switched off, and carries a handler on
 * ALL THREE events. `init` always writes all three, so a file with fewer is a
 * half-install and reporting it as installed would leave a user believing in
 * protection they do not have: a `pre` without its `post` never taints, a `post`
 * without its `pre` never blocks, and without `PreInvocation` a taint reaches the
 * model through nothing at all — `PostToolUse` on this agent cannot carry a warning.
 */
export function isStroqAntigravityHooks(json: unknown): boolean {
  if (!isPlainObject(json)) return false;
  const entry = json[ANTIGRAVITY_HOOK_NAME];
  if (!isPlainObject(entry) || entry['enabled'] === false) return false;
  return ANTIGRAVITY_HOOK_EVENTS.every((event) => eventHasStroqHandler(entry, event));
}

/**
 * The workspace file by default. `--user` writes the global hooks file,
 * `~/.gemini/config/hooks.json`; the same handlers can also be declared inside
 * `~/.gemini/antigravity-cli/settings.json`, which `init` deliberately does not write
 * — one global location is enough, and two would both have to be kept in step — but
 * which is protected from tampering all the same.
 */
export function antigravityHooksPath(
  scope: 'project' | 'user',
  cwd: string = process.cwd(),
): string {
  return scope === 'user'
    ? join(homedir(), '.gemini', 'config', 'hooks.json')
    : join(cwd, '.agents', 'hooks.json');
}

export const readAntigravityHooks = (file: string): AntigravityHooksJson =>
  readJsonObject<AntigravityHooksJson>(file);

export function installAntigravityHooks(file: string, command: string): AntigravityHooksJson {
  const merged = mergeAntigravityHooks(readAntigravityHooks(file), command);
  writeJsonObject(file, merged);
  return merged;
}
