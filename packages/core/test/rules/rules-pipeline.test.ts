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
  BLOB_CHARS,
  DEFAULT_BLOBS,
  PRODUCTION_CAP_MS,
  PRODUCTION_CHARS,
  runTimingGate,
  runBenignGate,
  SLOW_FACTOR,
  type AtrRule,
  type Bundle,
  type RuleTiming,
} from '../../../../scripts/lib/rules-pipeline.js';
import { loadBundledRules } from '../../src/rules/bundle.js';
import { DEFAULT_MAX_CHARS } from '../../src/scan/scanner.js';

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
   * every rule on blobs up to 32,768 characters, while `scanContent` runs in
   * production against up to 200,000 — 6.1x more. Backtracking is superlinear, so
   * comfortable at the gate's largest blob is not comfortable at the size a rule
   * will actually be handed.
   *
   * It is the SAME gate at a different size, deliberately: warmed, taken as a
   * minimum, and decided relative to the population's own p95. An absolute
   * ceiling was tried first and was wrong — it passed here and convicted a rule
   * on a slower CI runner, which is the exact failure `measureRuleTimingsStable`
   * and `SLOW_FACTOR` are documented against a few hundred lines above.
   *
   * What is NOT asserted here is that a superlinear rule clears the small blob
   * and fails the large one. Proving that needs a fixture whose cost is a
   * specific multiple on unknown hardware, which is the flakiness this file
   * exists to avoid — and a catastrophic fixture at 200,000 characters does not
   * terminate at all. The disable-and-throw policy is covered by the escalation
   * gate's own tests; what is new here is only the size, so the size is what is
   * pinned.
   */
  it('measures at the size production actually allows, not the gate\u2019s largest blob', () => {
    const result = runTimingGate(loadBundledRules().slice(0, 1), DEFAULT_SLOW_MS, DEFAULT_BLOBS, [
      PRODUCTION_CHARS,
    ]);
    expect(result.measurements.map((m) => m.size)).toEqual([PRODUCTION_CHARS]);
    expect(PRODUCTION_CHARS).toBeGreaterThan(BLOB_CHARS);
  });

  it('measures the number the engine will actually hand it', () => {
    // The drift guard. If these separate, the gate is testing a size production
    // never uses and every comment about it is false.
    expect(PRODUCTION_CHARS).toBe(DEFAULT_MAX_CHARS);
  });

  /**
   * There is deliberately no "every shipped rule passes" assertion here.
   *
   * It was written, and CI taught the lesson: a 639-rule timing sweep at 200,000
   * characters is six times the work of the gate's own sweep, so the window for a
   * shared runner to deschedule one measurement is six times wider, and something
   * eventually catches a hiccup. It convicted `ATR-2026-02304`, which costs
   * 0.04 ms here and ranks 283rd of 639 against a 37.79 ms threshold — noise, not
   * a slow rule. A test that fails on noise teaches people to rerun CI rather
   * than to read it.
   *
   * The gate belongs where timing decisions already live: `pnpm build:rules`,
   * which runs on one machine and produces the bundle. `check:rules` then
   * verifies that bundle byte for byte, so CI still proves the gate ran — it just
   * does not re-run a stopwatch. What is deterministic is asserted above.
   */
});

describe('the cap scales with the input size', () => {
  /**
   * The bug this pins, found by CI rather than by reading: `deriveThresholdMs`
   * takes the MINIMUM of the cap and p95 x SLOW_FACTOR. At 32,768 characters
   * p95 x 30 is about 7 ms, so the relative term binds and the 25 ms cap is a
   * floor on strictness. At 200,000 it is about 42 ms, so an unchanged cap
   * becomes the binding term and the gate turns absolute — it passed here and
   * convicted a rule on a slower runner.
   */
  const measurements = (ms: number): RuleTiming[] =>
    Array.from({ length: 100 }, (_, n) => ({ ruleId: `R-${n}`, ms, blob: 'b', size: 0 }));

  it('lets the relative term bind at production size', () => {
    // p95 x 30 = 42 ms here, under the scaled cap and over the unscaled one.
    const at = measurements(1.4);
    expect(deriveThresholdMs(at, DEFAULT_SLOW_MS)).toBe(DEFAULT_SLOW_MS);
    expect(deriveThresholdMs(at, PRODUCTION_CAP_MS)).toBeCloseTo(1.4 * SLOW_FACTOR, 5);
  });

  it('still lets the cap bind on a machine slow enough to deserve it', () => {
    expect(deriveThresholdMs(measurements(200), PRODUCTION_CAP_MS)).toBe(PRODUCTION_CAP_MS);
  });

  it('scales the cap by exactly the size ratio it is used at', () => {
    expect(PRODUCTION_CAP_MS).toBeCloseTo((DEFAULT_SLOW_MS * PRODUCTION_CHARS) / BLOB_CHARS, 5);
    expect(PRODUCTION_CAP_MS).toBeGreaterThan(DEFAULT_SLOW_MS);
  });
});
