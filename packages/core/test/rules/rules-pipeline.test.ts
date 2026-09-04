import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assembleBundle,
  compareWithCommitted,
  compileRules,
  loadRuleSources,
  RulesBuildError,
  runBenignGate,
  type Bundle,
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
});
