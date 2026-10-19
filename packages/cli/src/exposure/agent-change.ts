import type { AgentHit } from './agent-kinds.js';

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
 * error, since it decides what every session runs, or where its traffic goes.
 */
const COMMON_ENV =
  /^(?:PATH|SHELL|EDITOR|VISUAL|PAGER|HTTPS?_PROXY|ALL_PROXY|https?_proxy|all_proxy|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE)$/;

const withStatus = (h: AgentHit, status: ChangeStatus): TaggedHit =>
  status === 'present' && h.kind === 'agent-env' && COMMON_ENV.test(h.name)
    ? { ...h, severity: 'warning', status }
    : { ...h, status };

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
