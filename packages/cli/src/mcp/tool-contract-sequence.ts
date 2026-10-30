import { createHash } from 'node:crypto';
import { stableStringify } from '@stroq/core';
import { contractError, type ToolContractRecord } from './tool-contract-types.js';

/**
 * The highest record sequence one store has accepted per binding, for as long as it lives (the proxy
 * keeps one store for its whole run). The signature cannot tell an older record this home signed from
 * the newest one, so a record put back from before a revocation would verify; below what was seen, it
 * is refused like one that does not verify. Every write raises the sequence, so two genuine records
 * with the same sequence are the same record: one that differs at the sequence already seen belongs
 * to another history of the file (one written after it was removed) and is refused too. A new store
 * has nothing to compare with and accepts the first valid record it reads: nothing a process of the
 * same user cannot write records which is newest.
 */
export function createContractSequences(): {
  accept(record: ToolContractRecord): void;
  next(record: ToolContractRecord): number;
} {
  const seen = new Map<string, { sequence: number; sha256: string }>();
  const highest = (record: ToolContractRecord): number =>
    seen.get(record.binding.id)?.sequence ?? 0;
  const digest = (record: ToolContractRecord): string =>
    createHash('sha256').update(stableStringify(record)).digest('hex');
  return {
    /** Refuses a record older than, or different from, one already accepted; remembers it otherwise. */
    accept(record) {
      const before = seen.get(record.binding.id);
      const sha256 = digest(record);
      if (
        before &&
        (record.sequence < before.sequence ||
          (record.sequence === before.sequence && sha256 !== before.sha256))
      )
        contractError('tool-contract-invalid');
      seen.set(record.binding.id, { sequence: record.sequence, sha256 });
    },
    /** The sequence the next write gets: above `record`, and above anything seen even if it is gone. */
    next: (record) => Math.max(record.sequence, highest(record)) + 1,
  };
}
