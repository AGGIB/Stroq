import type { AgentHit } from './agent-kinds.js';

/**
 * Whether a hit came with the change being checked. Values are compared, not files: a hook
 * whose command is the same as at the base is `present` however the file around it was
 * reformatted, and one whose command differs under the same event is `changed`.
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

/** `head` tagged against `base`; with no base at all, everything is `present`. */
export function tagChanges(
  head: readonly AgentHit[],
  base: readonly AgentHit[] | null,
): TaggedHit[] {
  if (base === null) return head.map((h) => ({ ...h, status: 'present' }));
  const entries = new Set(base.map(entry));
  const slots = new Set(base.map(slot));
  return head.map((h) => ({
    ...h,
    status: entries.has(entry(h)) ? 'present' : slots.has(slot(h)) ? 'changed' : 'new',
  }));
}

/** Only an error fails, and only when `failOn` counts its status. */
export const isFailing = (h: TaggedHit, failOn: FailOn): boolean =>
  h.severity === 'error' && (failOn === 'any' || (failOn === 'new' && h.status !== 'present'));
