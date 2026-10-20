import { posix } from 'node:path';
import { envNameOf } from './agent-json.js';
import type { AgentHit, AgentKind } from './agent-kinds.js';
import { runsFetchedOrHiddenCode, sendsSecrets } from './fetch-shapes.js';

/**
 * Whether a hit came with the change being checked. Values are compared, not files: a hook
 * whose command is the same as at the base is `present` however the file around it was
 * reformatted. One whose command takes the place of a command that is gone, under the same
 * event, is `changed`. A command added next to the ones that stay is `new`.
 */
export type ChangeStatus = 'new' | 'changed' | 'present';

export interface TaggedHit extends AgentHit {
  readonly status: ChangeStatus;
}

/** Which findings fail the command: those that came with the change, all of them, or none. */
export type FailOn = 'new' | 'any' | 'none';
export const FAIL_ON: readonly FailOn[] = ['new', 'any', 'none'];

const slot = (h: AgentHit): string => `${h.kind}\u0000${h.file}\u0000${h.name}`;
const entry = (h: AgentHit): string => `${slot(h)}\u0000${h.value}`;

const countUp = (counts: Map<string, number>, key: string): void => {
  counts.set(key, (counts.get(key) ?? 0) + 1);
};

/** Takes one from `key`'s count; false when there was none left. */
const takeOne = (counts: Map<string, number>, key: string): boolean => {
  const left = counts.get(key) ?? 0;
  if (left === 0) return false;
  counts.set(key, left - 1);
  return true;
};

/**
 * The few env variables that are only a warning when a base proves they were already there:
 * common in honest settings, and they change no program a session starts, what it loads, or where
 * it sends anything. Matched in any letter case, so `node_env`, which the harmless list does not
 * pass, is one. Every other name an env sets stays an error, there before or not, and so does each
 * of these in plain `stroq inspect`, which has no base: it sees a clone for the first time, and
 * that is the moment it matters most. What a name is known to do only words the report.
 */
const BENIGN_ENV: ReadonlySet<string> = new Set([
  'NODE_ENV',
  'TZ',
  'LANG',
  'LC_ALL',
  'DISABLE_TELEMETRY',
  'DO_NOT_TRACK',
  'CLAUDE_CODE_ENABLE_TELEMETRY',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'FORCE_COLOR',
  'NO_COLOR',
  'CI',
]);

/** Whether an env variable that was already there is only a warning: one of the few benign names. */
const warnsWhenPresent = (name: string): boolean => BENIGN_ENV.has(envNameOf(name).toUpperCase());

/**
 * Kinds that are ordinary in an honest repository, and an attack in some shapes: where no base
 * proves one was there before (plain `stroq inspect`), one in such a shape fails. The shape only
 * ever makes an entry fail; nothing here makes one milder.
 */
const FAILS_IN_SHAPE: ReadonlySet<AgentKind> = new Set([
  'package-script',
  'devcontainer-command',
  'mcp-server',
]);
/** Kinds that fail where no base proves they were there before. */
const FAILS_WITHOUT_BASE: ReadonlySet<AgentKind> = new Set(['agent-broad-allow']);
/**
 * A folder anyone on the machine can write, where an attacker can put the file a link reads: the
 * temporary folders, the lock and crash folders, and macOS's shared and cache folders. In any
 * letter case: macOS opens `/TMP` as `/tmp`. Only how a link is shown depends on it: every link
 * out of the repository is an error.
 */
const SHARED_FOLDER =
  /^(?:\/private)?\/(?:tmp|var\/tmp|dev\/shm|run\/lock|var\/lock|var\/crash|var\/spool|users\/shared|library\/caches|library\/logs)(?:\/|$)/i;

/**
 * Server lists whose host asks before it starts each server: Claude Code's `.mcp.json` (unless
 * settings approve it, see `escalateApproved`) and VS Code's workspace servers. The other hosts
 * (Codex, Gemini, Qwen, opencode, Zed, Cursor, Roo, Kiro and the like) start every server of the
 * project's list once the folder is trusted, the moment a hook would run.
 */
function asksPerServer(file: string): boolean {
  const lower = file.toLowerCase();
  const base = lower.slice(lower.lastIndexOf('/') + 1);
  return (
    base === '.mcp.json' ||
    lower === '.vscode/mcp.json' ||
    lower.endsWith('/.vscode/mcp.json') ||
    lower === '.vscode/settings.json' ||
    lower.endsWith('/.vscode/settings.json') ||
    lower.endsWith('.code-workspace')
  );
}

/** An ordinary server in a list whose host starts it without asking. */
export const startsWithoutAsking = (h: AgentHit): boolean =>
  h.kind === 'mcp-server' && !asksPerServer(h.file);

/** Whether an absolute link target, once `//`, `.` and `..` are resolved, is in a shared folder. */
export const inSharedFolder = (target: string): boolean =>
  target.startsWith('/') && SHARED_FOLDER.test(posix.normalize(target));

/**
 * Whether a hit's status was worked out against a base revision (`compared`), or there was none to
 * compare with (`none`, plain `stroq inspect`), so that `present` proves nothing.
 */
export type Against = 'compared' | 'none';

/** Whether an entry is in the shape of an attack: it downloads and runs code, or sends a secret. */
export const inAttackShape = (h: AgentHit): boolean =>
  FAILS_IN_SHAPE.has(h.kind) && (runsFetchedOrHiddenCode(h.value) || sendsSecrets(h.value));

/**
 * A hit's severity once it is known whether the change brought it. A link out of the repository
 * is an error either way.
 *
 * With a base, whatever a change adds or changes fails, whatever it is or looks like: a hook, a
 * server, an install script, a dev container key, an allow rule. Only an instruction file, which
 * runs nothing, stays a notice. One a base proves was already there keeps its own severity, but
 * for one of the few benign env variables, which is a warning.
 *
 * With no base (plain `stroq inspect`), nothing is proven there before, and nothing is proven
 * new either: each keeps its own severity, and fails when it is an allow rule that grants too
 * much, a server whose host starts it without asking, or an install script, a dev container
 * command or a server in the shape of an attack.
 */
export function settle(
  h: AgentHit,
  status: ChangeStatus,
  against: Against = 'compared',
): TaggedHit {
  // What a link out of the repository reads is in no change to review, there before it or not.
  if (h.kind === 'config-link-outside') return { ...h, severity: 'error', status };
  if (against === 'none') {
    const fails = FAILS_WITHOUT_BASE.has(h.kind) || startsWithoutAsking(h) || inAttackShape(h);
    return fails ? { ...h, severity: 'error', status } : { ...h, status };
  }
  if (status === 'present')
    return h.kind === 'agent-env' && warnsWhenPresent(h.name)
      ? { ...h, severity: 'warning', status }
      : { ...h, status };
  return h.severity === 'notice' ? { ...h, status } : { ...h, severity: 'error', status };
}

const withStatus = settle;

/**
 * `head` tagged against `base`; with no base at all, everything is `present`, and settled as if a
 * change brought it, since nothing proves it was there before. Each base entry
 * accounts for one head entry at most: first the ones with the same value (`present`), then,
 * in order, one with a new value in the same slot (`changed`). What is left over is `new`.
 */
export function tagChanges(
  head: readonly AgentHit[],
  base: readonly AgentHit[] | null,
): TaggedHit[] {
  if (base === null) return head.map((h) => withStatus(h, 'present', 'none'));
  const sameValue = new Map<string, number>();
  const sameSlot = new Map<string, number>();
  for (const h of base) {
    countUp(sameValue, entry(h));
    countUp(sameSlot, slot(h));
  }
  const kept = head.map((h) => takeOne(sameValue, entry(h)) && takeOne(sameSlot, slot(h)));
  return head.map((h, i) =>
    withStatus(h, kept[i] ? 'present' : takeOne(sameSlot, slot(h)) ? 'changed' : 'new'),
  );
}

/** Only an error fails, and only when `failOn` counts its status. */
export const isFailing = (h: TaggedHit, failOn: FailOn): boolean =>
  h.severity === 'error' && (failOn === 'any' || (failOn === 'new' && h.status !== 'present'));
