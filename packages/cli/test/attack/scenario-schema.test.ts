import { describe, expect, it } from 'vitest';
import { atlasIds } from '../../src/coverage/atlas.js';
import { EFFECTS, ENCODINGS, ORIGINS, parseScenarioCorpus } from '../../src/attack/scenario.js';
import { SCENARIOS } from '../../src/attack/scenarios/index.js';

const documented = {
  id: '99-fixture',
  title: 'fixture',
  incident: { name: 'n', url: 'https://example.com/x', date: '2026-01' },
  class: null,
  origin: 'repo-file',
  encoding: 'plain',
  effect: 'exec',
  atlas: ['AML.T0051.001'],
  asi: [],
  steps: [{ event: { hook_event_name: 'PreToolUse' }, expect: 'deny' }],
};

describe('the scenario schema', () => {
  it('accepts a documented scenario', () => {
    expect(parseScenarioCorpus([documented])).toHaveLength(1);
  });

  it('accepts a synthetic cell with a class and no incident', () => {
    const synthetic = { ...documented, incident: null, class: 'models the padding bypass' };
    expect(parseScenarioCorpus([synthetic])[0]?.incident).toBeNull();
  });

  it('rejects a synthetic cell with no class, so an untraceable cell cannot ship', () => {
    expect(() => parseScenarioCorpus([{ ...documented, incident: null, class: null }])).toThrow();
  });

  it('rejects a cell that claims both an incident and a class', () => {
    expect(() => parseScenarioCorpus([{ ...documented, class: 'also a class' }])).toThrow();
  });

  it('rejects an ATLAS id that is not in the vendored denominator', () => {
    expect(() => parseScenarioCorpus([{ ...documented, atlas: ['AML.T9999'] }])).toThrow();
    expect(() => parseScenarioCorpus([{ ...documented, atlas: ['ATLAS01'] }])).toThrow();
  });

  it('rejects a scenario with no ATLAS id at all', () => {
    expect(() => parseScenarioCorpus([{ ...documented, atlas: [] }])).toThrow();
  });

  it('rejects an axis value outside its vocabulary', () => {
    expect(() => parseScenarioCorpus([{ ...documented, origin: 'telepathy' }])).toThrow();
    expect(() => parseScenarioCorpus([{ ...documented, effect: 'mischief' }])).toThrow();
  });
});

describe('the shipped corpus', () => {
  it('tags every scenario with real axes and real ATLAS ids', () => {
    const ids = atlasIds();
    for (const s of SCENARIOS) {
      expect(ORIGINS).toContain(s.origin);
      expect(ENCODINGS).toContain(s.encoding);
      expect(EFFECTS).toContain(s.effect);
      expect(s.atlas.length).toBeGreaterThan(0);
      for (const id of s.atlas) expect(ids.has(id)).toBe(true);
    }
  });

  it('keeps every launch scenario documented, with a reachable-looking citation', () => {
    for (const s of SCENARIOS.filter((x) => x.id !== '13-padded-secret-exfil')) {
      expect(s.incident).not.toBeNull();
      expect(s.incident?.url).toMatch(/^https:\/\//);
      expect(s.class).toBeNull();
    }
  });

  it('keeps the one synthetic launch cell synthetic', () => {
    const padded = SCENARIOS.find((s) => s.id === '13-padded-secret-exfil');
    expect(padded?.incident).toBeNull();
    expect(padded?.class).toMatch(/padding/i);
  });
});
