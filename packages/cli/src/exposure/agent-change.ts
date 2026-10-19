import { posix } from 'node:path';
import { envLoadsCode, envNameOf } from './agent-json.js';
import type { AgentHit, AgentKind } from './agent-kinds.js';
import { runsFetchedOrHiddenCode } from './fetch-shapes.js';

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
 * Env variables that honest settings often set: PATH, a shell, an editor or pager, a proxy, a
 * certificate. One that was already there is a warning. One a change adds or changes stays an
 * error, since it decides what every session runs, or where its traffic goes. Read in capitals:
 * Windows reads `Path` as `PATH`.
 */
const COMMON_ENV =
  /^(?:PATH|SHELL|EDITOR|VISUAL|PAGER|HTTPS?_PROXY|ALL_PROXY|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE)$/;

/**
 * Whether an env variable that was already there is only a warning: a common one, or one that is
 * neither harmless nor known to load code (an honest setting names many such). A known one in any
 * letter case stays an error.
 */
const warnsWhenPresent = (name: string): boolean => {
  const variable = envNameOf(name);
  return COMMON_ENV.test(variable.toUpperCase()) || !envLoadsCode(variable);
};

/** Kinds that are ordinary in an honest repository, and an attack in some shapes. */
const FAILS_IN_SHAPE: ReadonlySet<AgentKind> = new Set([
  'package-script',
  'devcontainer-command',
  'mcp-server',
]);
/** Kinds that are listed to review when they were there, and fail when a change brings them. */
const FAILS_WHEN_NEW: ReadonlySet<AgentKind> = new Set([
  'agent-broad-allow',
  'config-link-outside',
]);
/**
 * A folder anyone on the machine can write, where an attacker can put the file a link reads. In
 * any letter case: macOS opens `/TMP` as `/tmp`.
 */
const SHARED_FOLDER = /^(?:\/private)?\/(?:tmp|var\/tmp|dev\/shm)(?:\/|$)/i;

/** Whether an absolute link target, once `//`, `.` and `..` are resolved, is in a shared folder. */
export const inSharedFolder = (target: string): boolean =>
  target.startsWith('/') && SHARED_FOLDER.test(posix.normalize(target));

/**
 * A hit's severity once it is known whether the change brought it. One that was already there
 * keeps its own, but for a common env variable or one nobody knows, which is a warning. One the
 * change brought fails
 * when it is a whole-shell allow rule or a link out of the repository, and when it is an install
 * script, a dev container command or a server that downloads and runs code, or decodes and runs
 * it. A link to a shared temporary folder is an error either way.
 */
export function settle(h: AgentHit, status: ChangeStatus): TaggedHit {
  if (h.kind === 'config-link-outside' && inSharedFolder(h.value))
    return { ...h, severity: 'error', status };
  if (status === 'present')
    return h.kind === 'agent-env' && warnsWhenPresent(h.name)
      ? { ...h, severity: 'warning', status }
      : { ...h, status };
  const fails =
    FAILS_WHEN_NEW.has(h.kind) ||
    (FAILS_IN_SHAPE.has(h.kind) && h.severity !== 'error' && runsFetchedOrHiddenCode(h.value));
  return fails ? { ...h, severity: 'error', status } : { ...h, status };
}

const withStatus = settle;

/**
 * `head` tagged against `base`; with no base at all, everything is `present`. Each base entry
 * accounts for one head entry at most: first the ones with the same value (`present`), then,
 * in order, one with a new value in the same slot (`changed`). What is left over is `new`.
 */
export function tagChanges(
  head: readonly AgentHit[],
  base: readonly AgentHit[] | null,
): TaggedHit[] {
  if (base === null) return head.map((h) => withStatus(h, 'present'));
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
