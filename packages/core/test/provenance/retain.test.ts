import { describe, expect, it } from 'vitest';
import { retain } from '../../src/provenance/retain.js';
import type { ProvenanceRecord } from '../../src/types.js';

const record = (
  seq: number,
  kind: ProvenanceRecord['kind'],
  flag: 'clean' | 'own' | 'suspect',
): ProvenanceRecord => ({
  seq,
  at: '2026-10-28T00:00:00.000Z',
  tool: 'Read',
  source: 'README.md',
  kind,
  hash: `h${seq}`,
  excerpt: `x${seq}`,
  suspect: flag === 'suspect',
  ...(flag === 'own' ? { flaggedOwn: true } : {}),
});

describe('retain', () => {
  it('drops clean records first, then those flagged on the own text, and those that tainted last', () => {
    const records = [
      record(1, 'url', 'own'),
      record(2, 'url', 'suspect'),
      record(3, 'url', 'clean'),
      record(4, 'pkg', 'clean'),
      record(5, 'url', 'clean'),
    ];
    const kept = retain(records, 2);
    expect(kept.kept.map((r) => r.seq)).toEqual([1, 2]);
    expect(kept.floorLost).toBe(true);
    expect(retain(records, 1).kept.map((r) => r.seq)).toEqual([2]);
  });

  it('keeps everything that fits', () => {
    const records = [record(1, 'url', 'clean'), record(2, 'pkg', 'own')];
    expect(retain(records, 5)).toEqual({ kept: records, floorLost: false });
  });
});
