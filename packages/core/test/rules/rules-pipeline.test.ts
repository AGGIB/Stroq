import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyRuleOverrides,
  assembleBundle,
  compareWithCommitted,
  compileRules,
  DEFAULT_SLOW_MS,
  deriveThresholdMs,
  loadRuleOverrides,
  loadRuleSources,
  RulesBuildError,
  measureAtSize,
  PRODUCTION_CHARS,
  productionGate,
  runBenignGate,
  SLOW_FACTOR,
  type AtrRule,
  type Bundle,
  type RuleTiming,
} from '../../../../scripts/lib/rules-pipeline.js';
import { loadBundledRules } from '../../src/rules/bundle.js';

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

  describe('rule overrides', () => {
    function tempOverrides(yaml: string): string {
      const dir = mkdtempSync(join(tmpdir(), 'stroq-rules-overrides-'));
      tempDirs.push(dir);
      const file = join(dir, 'atr-overrides.yaml');
      writeFileSync(file, yaml);
      return file;
    }

    const RULE = `
id: ATR-2099-00002
title: Overridable rule
severity: medium
detection:
  condition: any
  conditions:
    - operator: regex
      value: "upstream-pattern"
    - operator: regex
      value: "second-pattern"
`;

    function loadOne(): readonly AtrRule[] {
      return loadRuleSources([tempRuleDir({ 'r.yaml': RULE })]).rules;
    }

    it('returns no overrides when the file does not exist', () => {
      expect(loadRuleOverrides(join(tmpdir(), 'stroq-no-such-overrides.yaml')).size).toBe(0);
    });

    it('replaces the named condition and leaves the others alone', () => {
      const file = tempOverrides(
        'ATR-2099-00002:\n' +
          '  reason: narrowed\n' +
          '  conditions:\n' +
          '    - index: 0\n' +
          '      from: upstream-pattern\n' +
          '      to: tightened-pattern\n',
      );
      const { rules, applied } = applyRuleOverrides(loadOne(), loadRuleOverrides(file));
      expect(applied).toEqual(['ATR-2099-00002']);
      expect(rules[0]?.detection.conditions[0]?.value).toBe('tightened-pattern');
      expect(rules[0]?.detection.conditions[1]?.value).toBe('second-pattern');
    });

    // The point of `from`: a re-import at a new upstream version must fail loudly
    // rather than reapply a patch written against a pattern that no longer exists.
    it('fails when the vendored pattern is no longer the one the override expects', () => {
      const file = tempOverrides(
        'ATR-2099-00002:\n' +
          '  reason: stale\n' +
          '  conditions:\n' +
          '    - index: 0\n' +
          '      from: what-upstream-used-to-say\n' +
          '      to: tightened-pattern\n',
      );
      expect(() => applyRuleOverrides(loadOne(), loadRuleOverrides(file))).toThrow(
        /no longer the one this override was written against/,
      );
    });

    it('fails when the overridden rule is gone from the sources', () => {
      const file = tempOverrides(
        'ATR-2099-09999:\n' +
          '  reason: renamed upstream\n' +
          '  conditions:\n' +
          '    - index: 0\n' +
          '      from: a\n' +
          '      to: b\n',
      );
      expect(() => applyRuleOverrides(loadOne(), loadRuleOverrides(file))).toThrow(/no such rule/);
    });

    it('fails when the condition index does not exist', () => {
      const file = tempOverrides(
        'ATR-2099-00002:\n' +
          '  reason: out of range\n' +
          '  conditions:\n' +
          '    - index: 7\n' +
          '      from: upstream-pattern\n' +
          '      to: tightened-pattern\n',
      );
      expect(() => applyRuleOverrides(loadOne(), loadRuleOverrides(file))).toThrow(
        /condition 7 does not exist/,
      );
    });

    it('refuses to override a Stroq-authored rule, which is ours to edit directly', () => {
      const file = tempOverrides(
        'STROQ-2026-90001:\n' +
          '  reason: should be rejected\n' +
          '  conditions:\n' +
          '    - index: 0\n' +
          '      from: a\n' +
          '      to: b\n',
      );
      const rules = loadRuleSources([tempRuleDir({ 's.yaml': STROQ_RULE })]).rules;
      expect(() => applyRuleOverrides(rules, loadRuleOverrides(file))).toThrow(
        /edit its rule file instead/,
      );
    });

    it('rejects a malformed entry rather than silently applying nothing', () => {
      const file = tempOverrides('ATR-2099-00002:\n  reason: no conditions\n');
      expect(() => loadRuleOverrides(file)).toThrow(/"conditions" must be a non-empty list/);
    });

    it('rejects an unknown field, which is usually a typo in a field that matters', () => {
      const file = tempOverrides(
        'ATR-2099-00002:\n' +
          '  reason: typo\n' +
          '  conditions:\n' +
          '    - index: 0\n' +
          '      form: upstream-pattern\n' +
          '      to: tightened-pattern\n',
      );
      expect(() => loadRuleOverrides(file)).toThrow(/"from" must be a non-empty string/);
    });
  });
});

describe('the production-size gate', () => {
  /**
   * The gap this closes, measured on the shipped set: the escalation gate times
   * every rule on blobs up to 32,768 characters, and `scanContent` runs in
   * production against up to 200,000 — 6.1x more. Backtracking is superlinear,
   * so a rule that is comfortable at the gate's largest blob is not thereby
   * comfortable at the size it will actually be handed.
   *
   * Nothing shipped today crosses it (the whole set at the production cap is
   * 79 ms single-pass, the slowest single rule 3.4 ms, against a 500 ms scan
   * budget). The gate exists so the next vendored rule drop cannot.
   */
  const quadratic = (id: string): AtrRule => ({
    id,
    title: 'catastrophic on a long run of a',
    severity: 'high',
    status: 'experimental',
    tags: { category: 'test' },
    // Classic nested quantifier: linear-ish on a short blob, quadratic on a long one.
    detection: {
      condition: 'any',
      conditions: [{ field: 'content', operator: 'regex', value: '(a+)+$' }],
    },
    test_cases: { true_positives: [], true_negatives: [] },
    author: 'test',
    date: '2026/09/22',
    schema_version: '1.0',
  });

  it('times rules at the size production actually allows', () => {
    const { compiled } = compileRules([quadratic('ATR-2026-99001')]);
    const short = measureAtSize(compiled, 8_192);
    const full = measureAtSize(compiled, PRODUCTION_CHARS);
    expect(full[0]?.size).toBe(PRODUCTION_CHARS);
    // The point of the gate: the cost is not the same number at both sizes.
    expect(full[0]?.ms).toBeGreaterThan(short[0]?.ms ?? 0);
  });

  it('convicts a rule that only misbehaves at production size', () => {
    const { compiled } = compileRules([quadratic('ATR-2026-99002')]);
    const over = productionGate(compiled, 0.000_1);
    expect(over.has('ATR-2026-99002')).toBe(true);
    expect(over.get('ATR-2026-99002')).toMatch(/production/i);
  });

  it('leaves a linear rule alone', () => {
    const linear: AtrRule = {
      ...quadratic('ATR-2026-99003'),
      detection: {
        condition: 'any',
        conditions: [{ field: 'content', operator: 'regex', value: 'zzz-not-present' }],
      },
    };
    const { compiled } = compileRules([linear]);
    expect(productionGate(compiled, DEFAULT_SLOW_MS).size).toBe(0);
  });

  it('holds for every rule that ships', () => {
    // The assertion a slow rule would have to answer before it could land, run
    // against the bundle the package actually ships rather than the sources.
    expect(productionGate(loadBundledRules(), DEFAULT_SLOW_MS).size).toBe(0);
  });
});
