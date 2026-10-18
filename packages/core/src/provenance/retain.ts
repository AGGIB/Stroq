import type { ProvenanceRecord } from '../types.js';
import { isFloorKind } from './atom-kinds.js';

/** The records a session keeps, and whether one that can raise the floor was dropped to make room. */
export interface Retained {
  readonly kept: ProvenanceRecord[];
  readonly floorLost: boolean;
}

/**
 * How soon a record goes when the session holds more than it keeps: the lower, the sooner. Records
 * that were read clean go before any that was flagged, because a flagged record wins over every
 * later record of the same atom (see `action-lookup.ts`), and that holds only for the records that
 * are still there: a flagged record dropped while a clean record of the same atom stays would turn
 * the denial of its command into a question. Within each, the record of a URL or a host goes before
 * the record of a package, a pipe-to-shell or an encoded blob: no record of the first kind can
 * raise the floor of an incomplete session. The records of hashes go before all of these.
 */
function dropOrder(record: ProvenanceRecord): number {
  // A hash is the cheapest record there is: it goes before every other, flagged or not.
  if (record.kind === 'digest') return -1;
  return (record.suspect ? 2 : 0) + (isFloorKind(record.kind) ? 1 : 0);
}

/**
 * At most `max` of `records`, in the order they were read. When some have to go, the oldest of the
 * lowest `dropOrder` do; a session without a flagged record therefore keeps its newest records, as
 * it always did, except that the records of URLs and hosts go before those of packages. Only the
 * loss of a record that can raise the floor is reported (`floorLost`), and the caller has to note it.
 */
export function retain(records: readonly ProvenanceRecord[], max: number): Retained {
  const overflow = records.length - max;
  if (overflow <= 0) return { kept: [...records], floorLost: false };
  const dropped = new Set(
    records
      .map((record, index) => ({ index, order: dropOrder(record) }))
      .sort((a, b) => a.order - b.order || a.index - b.index)
      .slice(0, overflow)
      .map(({ index }) => index),
  );
  return {
    kept: records.filter((_, index) => !dropped.has(index)),
    floorLost: [...dropped].some((index) => isFloorKind(records[index]?.kind ?? 'url')),
  };
}
