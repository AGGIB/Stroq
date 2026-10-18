import type { ProvenanceRecord } from '../types.js';
import { isFloorKind } from './atom-kinds.js';

/** The records a session keeps, and whether one that can raise the floor was dropped to make room. */
export interface Retained {
  readonly kept: ProvenanceRecord[];
  readonly floorLost: boolean;
}

/**
 * At most `max` of `records`, the newest. When some have to go, the oldest URL and host records
 * go first: no record of one can raise the floor of an incomplete session, so a session that read a
 * great many links loses links, not the packages it read before them, and says nothing about it. Only
 * when the records that can raise the floor are themselves more than `max` do the oldest of those
 * go, and that is a loss (`floorLost`) which the caller has to note.
 */
export function retain(records: readonly ProvenanceRecord[], max: number): Retained {
  const overflow = records.length - max;
  if (overflow <= 0) return { kept: [...records], floorLost: false };
  let links = 0;
  const afterLinks = records.filter((record) => {
    if (isFloorKind(record.kind) || links >= overflow) return true;
    links += 1;
    return false;
  });
  const stillOver = afterLinks.length - max;
  return stillOver > 0
    ? { kept: afterLinks.slice(stillOver), floorLost: true }
    : { kept: afterLinks, floorLost: false };
}
