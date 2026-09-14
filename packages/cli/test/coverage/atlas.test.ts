import { describe, expect, it } from 'vitest';
import { ATLAS_ID, atlasIds, loadAtlas } from '../../src/coverage/atlas.js';

describe('loadAtlas', () => {
  it('carries the vendored release and its hash', () => {
    const atlas = loadAtlas();
    expect(atlas.release).toBe('2026.08');
    expect(atlas.formatVersion).toBe('6.0.0');
    expect(atlas.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(atlas.source).toContain('mitre-atlas');
  });

  it('carries every technique in the distribution', () => {
    const atlas = loadAtlas();
    expect(atlas.techniques.length).toBe(197);
    expect(atlas.techniques.filter((t) => t.parent !== null).length).toBe(83);
  });

  it('gives every id the canonical shape and every sub-technique its parent', () => {
    for (const t of loadAtlas().techniques) {
      expect(t.id).toMatch(ATLAS_ID);
      expect(t.name.length).toBeGreaterThan(0);
      if (t.parent !== null) expect(t.id.startsWith(`${t.parent}.`)).toBe(true);
    }
  });

  it('includes the agent techniques the corpus tags against', () => {
    const ids = atlasIds();
    for (const id of [
      'AML.T0051',
      'AML.T0051.001',
      'AML.T0080',
      'AML.T0081',
      'AML.T0086',
      'AML.T0101',
      'AML.T0110',
      'AML.T0010.005',
    ])
      expect(ids.has(id)).toBe(true);
  });

  it('rejects an id that is not in the distribution', () => {
    expect(atlasIds().has('AML.T9999')).toBe(false);
    expect(atlasIds().has('ATLAS01')).toBe(false);
  });
});
