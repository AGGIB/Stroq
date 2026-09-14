import { describe, expect, it } from 'vitest';
import { asiIds, loadAsi } from '../../src/coverage/asi.js';
import { SCENARIOS } from '../../src/attack/scenarios/index.js';

describe('the OWASP ASI layer', () => {
  it('pins the edition it was transcribed from', () => {
    const layer = loadAsi();
    expect(layer.edition).toBe('2026');
    expect(layer.published).toBe('2025-12-09');
    expect(layer.url).toMatch(/^https:\/\//);
  });

  it('carries exactly the ten risks', () => {
    const risks = loadAsi().risks;
    expect(risks).toHaveLength(10);
    expect(risks.map((r) => r.id)).toEqual([
      'ASI01', 'ASI02', 'ASI03', 'ASI04', 'ASI05',
      'ASI06', 'ASI07', 'ASI08', 'ASI09', 'ASI10',
    ]);
    expect(risks[0]?.name).toBe('Agent Goal Hijack');
  });
});

describe('the corpus against the ASI layer', () => {
  it('tags every scenario with at least one risk from the pinned list', () => {
    const ids = asiIds();
    for (const s of SCENARIOS) {
      expect(s.asi.length, `${s.id} has no ASI tag`).toBeGreaterThan(0);
      for (const id of s.asi) expect(ids.has(id), `${s.id} cites unknown ${id}`).toBe(true);
    }
  });

  it('does not claim the two risks a single-agent firewall cannot exercise', () => {
    // ASI07 (inter-agent communication) and ASI08 (cascading agent failures) need a
    // multi-agent system. Stroq sits on one agent's tool calls; claiming them from
    // this corpus would be a coverage claim the suite cannot back.
    for (const s of SCENARIOS) {
      expect(s.asi).not.toContain('ASI07');
      expect(s.asi).not.toContain('ASI08');
    }
  });
});
