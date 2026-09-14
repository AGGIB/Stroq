import { describe, expect, it } from 'vitest';
import type { CoverageStatus } from '../../src/coverage/report.js';
import { buildCoverage, formatCoverage, toNavigatorLayer } from '../../src/coverage/report.js';
import { loadScope } from '../../src/coverage/scope.js';
import { SCENARIOS } from '../../src/attack/scenarios/index.js';

describe('buildCoverage', () => {
  it('reports one row per in-scope technique and no more', () => {
    const report = buildCoverage();
    expect(report.techniques).toHaveLength(loadScope().inScope.length);
    expect(report.summary.inScope).toBe(loadScope().inScope.length);
  });

  it('adds up: covered plus partial plus not-covered is the in-scope set', () => {
    const s = buildCoverage().summary;
    expect(s.covered + s.partial + s.notCovered).toBe(s.inScope);
  });

  it('each summary count matches the techniques actually carrying that status', () => {
    // A self-consistent hardcode (covered + partial + notCovered === inScope, with
    // inScope pinned to loadScope().inScope.length) would pass the two tests above
    // without ever touching `techniques`. This one recomputes each count directly
    // from `report.techniques` so a literal in place of the `reduce` cannot pass.
    const report = buildCoverage();
    const countOf = (status: CoverageStatus): number =>
      report.techniques.filter((t) => t.status === status).length;
    expect(report.summary.covered).toBe(countOf('covered'));
    expect(report.summary.partial).toBe(countOf('partial'));
    expect(report.summary.notCovered).toBe(countOf('not_covered'));
  });

  it('marks a technique covered only when a scenario tags it', () => {
    const report = buildCoverage();
    const tagged = new Set(SCENARIOS.flatMap((s) => s.atlas));
    for (const t of report.techniques) {
      if (t.status === 'not_covered') expect(tagged.has(t.id)).toBe(false);
      else expect(tagged.has(t.id)).toBe(true);
    }
  });

  it('carries a limitation on every partial row and none on a covered one', () => {
    for (const t of buildCoverage().techniques) {
      if (t.status === 'partial') expect(t.limitation).not.toBeNull();
      if (t.status === 'covered') expect(t.limitation).toBeNull();
    }
  });

  it('names the scenarios behind each covered technique', () => {
    const covered = buildCoverage().techniques.filter((t) => t.status !== 'not_covered');
    for (const t of covered) expect(t.scenarios.length).toBeGreaterThan(0);
  });

  it('counts documented and synthetic scenarios apart', () => {
    const report = buildCoverage();
    expect(report.scenarios.documented + report.scenarios.synthetic).toBe(report.scenarios.total);
    expect(report.scenarios.total).toBe(SCENARIOS.length);
  });
});

describe('formatCoverage', () => {
  it('leads with the depth number, not a ratio', () => {
    const out = formatCoverage(buildCoverage());
    expect(out).toMatch(/\d+ scenarios/);
    expect(out).not.toMatch(/\d+(\.\d+)?%/);
  });

  it('prints uncovered techniques in the same summary line as covered ones', () => {
    const out = formatCoverage(buildCoverage());
    const summary = out.split('\n').find((l) => l.includes('not covered'));
    expect(summary).toBeDefined();
    expect(summary).toMatch(/covered/);
  });

  it('prints the limitation beside anything not fully covered', () => {
    const report = buildCoverage();
    const partial = report.techniques.find((t) => t.status === 'partial');
    if (!partial) return;
    expect(formatCoverage(report)).toContain(partial.limitation ?? '');
  });
});

describe('toNavigatorLayer', () => {
  it('emits the shape MITRE ATLAS layers use', () => {
    const layer = toNavigatorLayer(buildCoverage()) as {
      domain: string;
      versions: { layer: string };
      techniques: { techniqueID: string; tactic?: string }[];
      metadata: { name: string; value: string }[];
    };
    expect(layer.domain).toBe('atlas-atlas');
    expect(layer.versions.layer).toBe('4.3');
    expect(layer.metadata.some((m) => m.name === 'atlas_data_version')).toBe(true);
  });

  it('omits the per-technique tactic, which ATLAS v6 cannot supply', () => {
    const layer = toNavigatorLayer(buildCoverage()) as {
      techniques: Record<string, unknown>[];
    };
    for (const t of layer.techniques) expect('tactic' in t).toBe(false);
  });

  it('includes every in-scope technique, uncovered ones included', () => {
    const report = buildCoverage();
    const layer = toNavigatorLayer(report) as { techniques: { techniqueID: string }[] };
    expect(layer.techniques).toHaveLength(report.techniques.length);
  });
});
