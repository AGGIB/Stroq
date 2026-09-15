import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assembleBundle,
  compareWithCommitted,
  compileRules,
  DEFAULT_SLOW_MS,
  deriveThresholdMs,
  loadRuleSources,
  RulesBuildError,
  runBenignGate,
  SLOW_FACTOR,
  type Bundle,
  type RuleTiming,
} from '../../../../scripts/lib/rules-pipeline.js';

// Minimal ATR-format rule bodies. `id` must match /^[A-Z]+-\d{4}-\d{5}$/
// (see atr-types.ts) — these ids are made up and don't collide with any
// real rule in rules/stroq or rules/atr.
const STROQ_RULE = `
id: STROQ-2026-90001
title: Test Stroq rule
severity: low
detection:
  condition: any
  conditions:
    - operator: contains
      value: "stroq-trigger-phrase"
`;

const ATR_RULE = `
id: ATR-2099-00001
title: Test ATR rule
severity: medium
detection:
  condition: any
  conditions:
    - operator: contains
      value: "atr-trigger-phrase"
`;

describe('rules-pipeline', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tempRuleDir(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'stroq-rules-pipeline-'));
    tempDirs.push(dir);
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
    return dir;
  }

  describe('assembleBundle', () => {
    it('assembles a bundle from a temp dir with one Stroq rule and one ATR rule', () => {
      const dir = tempRuleDir({ 'stroq.yaml': STROQ_RULE, 'atr.yaml': ATR_RULE });
      const loaded = loadRuleSources([dir]);
      expect(loaded.skipped).toEqual([]);
      const { compiled, errors } = compileRules(loaded.rules);
      expect(errors).toEqual([]);
      const compilableIds = new Set(compiled.map((r) => r.id));

      const bundle = assembleBundle({
        loadedRules: loaded.rules,
        compilableIds,
        disabledIds: new Set(),
        previousBundle: null,
        now: () => '2026-01-01T00:00:00.000Z',
      });

      expect(bundle.rules.map((r) => r.id).sort()).toEqual(['ATR-2099-00001', 'STROQ-2026-90001']);
      expect(bundle.disabled).toEqual([]);
      expect(bundle.generatedAt).toBe('2026-01-01T00:00:00.000Z');
    });

    it('reuses the previous generatedAt when rules and disabled ids are unchanged', () => {
      const dir = tempRuleDir({ 'atr.yaml': ATR_RULE });
      const loaded = loadRuleSources([dir]);
      const { compiled } = compileRules(loaded.rules);
      const compilableIds = new Set(compiled.map((r) => r.id));
      const previousBundle = {
        generatedAt: '2020-01-01T00:00:00.000Z',
        rules: loaded.rules,
        disabled: [],
      };

      const bundle = assembleBundle({
        loadedRules: loaded.rules,
        compilableIds,
        disabledIds: new Set(),
        previousBundle,
        now: () => '2026-01-01T00:00:00.000Z',
      });

      expect(bundle.generatedAt).toBe('2020-01-01T00:00:00.000Z');
    });

    it('picks a new generatedAt when the disabled set changed', () => {
      const dir = tempRuleDir({ 'atr.yaml': ATR_RULE });
      const loaded = loadRuleSources([dir]);
      const { compiled } = compileRules(loaded.rules);
      const compilableIds = new Set(compiled.map((r) => r.id));
      const previousBundle = {
        generatedAt: '2020-01-01T00:00:00.000Z',
        rules: loaded.rules,
        disabled: [],
      };

      const bundle = assembleBundle({
        loadedRules: loaded.rules,
        compilableIds,
        disabledIds: new Set(['ATR-2099-00001']),
        previousBundle,
        now: () => '2026-01-01T00:00:00.000Z',
      });

      expect(bundle.generatedAt).toBe('2026-01-01T00:00:00.000Z');
    });
  });

  describe('runBenignGate', () => {
    it('disables an ATR rule that fires on a benign fixture', () => {
      const dir = tempRuleDir({ 'atr.yaml': ATR_RULE });
      const { compiled } = compileRules(loadRuleSources([dir]).rules);
      const fixtures = [{ name: 'fixture.md', text: 'this contains atr-trigger-phrase in prose' }];

      const result = runBenignGate(compiled, fixtures);

      expect(result.disabled.get('ATR-2099-00001')).toBe('fixture.md');
    });

    it('does not disable a rule that does not fire on any fixture', () => {
      const dir = tempRuleDir({ 'atr.yaml': ATR_RULE });
      const { compiled } = compileRules(loadRuleSources([dir]).rules);
      const fixtures = [{ name: 'fixture.md', text: 'nothing suspicious here' }];

      const result = runBenignGate(compiled, fixtures);

      expect(result.disabled.size).toBe(0);
    });

    it('throws RulesBuildError when a Stroq rule fires on a benign fixture', () => {
      const dir = tempRuleDir({ 'stroq.yaml': STROQ_RULE });
      const { compiled } = compileRules(loadRuleSources([dir]).rules);
      const fixtures = [
        { name: 'fixture.md', text: 'this contains stroq-trigger-phrase in prose' },
      ];

      expect(() => runBenignGate(compiled, fixtures)).toThrow(RulesBuildError);
    });

    it('a committed disabled list makes a firing ATR rule pass verification', () => {
      const dir = tempRuleDir({ 'atr.yaml': ATR_RULE });
      const { compiled } = compileRules(loadRuleSources([dir]).rules);
      const fixtures = [{ name: 'fixture.md', text: 'this contains atr-trigger-phrase in prose' }];
      const committedDisabled = new Set(['ATR-2099-00001']);

      // This mirrors what --check mode does: filter out anything already in
      // the committed disabled list before running the gate, so a firing
      // rule that's already accounted for never gets reported as new.
      const candidates = compiled.filter((r) => !committedDisabled.has(r.id));
      const result = runBenignGate(candidates, fixtures);

      expect(result.disabled.size).toBe(0);
    });
  });

  describe('compareWithCommitted', () => {
    it('reports equal when the assembled bundle matches the committed text byte-for-byte', () => {
      const bundle: Bundle = {
        version: 1,
        generatedAt: '2026-01-01T00:00:00.000Z',
        rules: [],
        disabled: [],
      };
      const committedJson = JSON.stringify(bundle);

      expect(compareWithCommitted(bundle, committedJson).equal).toBe(true);
    });

    it('reports unequal when the assembled bundle differs from the committed text', () => {
      const bundle: Bundle = {
        version: 1,
        generatedAt: '2026-01-01T00:00:00.000Z',
        rules: [],
        disabled: [],
      };
      const committedJson = JSON.stringify({ ...bundle, disabled: ['ATR-9999-00000'] });

      expect(compareWithCommitted(bundle, committedJson).equal).toBe(false);
    });
  });

  describe('deriveThresholdMs', () => {
    // A population shaped like the real one: a long body of fast rules and a
    // short pathological tail. `slowFactor` scales every time, standing in for
    // running the same corpus on slower hardware.
    const population = (scale: number): RuleTiming[] => {
      const t = (ms: number, i: number): RuleTiming => ({
        ruleId: `ATR-2026-${String(i).padStart(5, '0')}`,
        ms: ms * scale,
        blob: 'letter-a',
        size: 8_192,
      });
      // Proportions matter, not just shape: the real corpus is 648 rules of which
      // 8 are pathological — 1.23%, just over the 1% a p99 anchor excludes, which
      // is exactly why p99 landed inside the tail. A fixture with a thinner tail
      // passes under either anchor and pins nothing.
      const body = Array.from({ length: 640 }, (_, i) => t(0.002 + (i / 640) * 0.23, i));
      const tail = [21.3, 21.5, 25.5, 25.5, 33.7, 34.4, 156.4, 1926.4].map((ms, i) =>
        t(ms, 900 + i),
      );
      return [...body, ...tail];
    };

    it('scales with the machine, so the same rules are convicted on slower hardware', () => {
      const fast = deriveThresholdMs(population(1));
      const slow = deriveThresholdMs(population(3));
      expect(slow).toBeGreaterThan(fast);

      // What matters is not the threshold but the verdict: the tail is convicted
      // and the body is not, on both machines.
      for (const scale of [1, 3]) {
        const measurements = population(scale);
        const threshold = deriveThresholdMs(measurements);
        const convicted = measurements.filter((m) => m.ms > threshold);
        expect(convicted).toHaveLength(8);
        expect(convicted.every((m) => m.ruleId >= 'ATR-2026-00900')).toBe(true);
      }
    });

    it('never exceeds the absolute ceiling, so a slow machine cannot loosen the gate', () => {
      expect(deriveThresholdMs(population(1_000))).toBe(DEFAULT_SLOW_MS);
    });

    it('anchors below the tail it exists to detect', () => {
      // The regression this guards: anchoring at p99 put the anchor *inside* the
      // pathological tail (1.2% of the population is pathological), so the
      // threshold scaled with the outliers and convicted nothing.
      const measurements = population(1);
      const threshold = deriveThresholdMs(measurements);
      const slowestConvicted = Math.min(
        ...measurements.filter((m) => m.ms > threshold).map((m) => m.ms),
      );
      const fastestCleared = Math.max(
        ...measurements.filter((m) => m.ms <= threshold).map((m) => m.ms),
      );
      expect(threshold).toBeLessThan(slowestConvicted);
      expect(threshold).toBeGreaterThan(fastestCleared);
    });

    it('falls back to the ceiling when there is nothing to measure', () => {
      expect(deriveThresholdMs([])).toBe(DEFAULT_SLOW_MS);
    });

    it('derives the threshold from the anchor and the factor, not from a constant', () => {
      const flat = Array.from({ length: 100 }, (_, i) => ({
        ruleId: `ATR-2026-${String(i).padStart(5, '0')}`,
        ms: 0.1,
        blob: 'letter-a',
        size: 2_048,
      }));
      expect(deriveThresholdMs(flat)).toBeCloseTo(Math.min(DEFAULT_SLOW_MS, 0.1 * SLOW_FACTOR), 5);
    });
  });
});
