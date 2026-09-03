import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import bundleJson from '../../src/rules.bundle.json' with { type: 'json' };
import { compileRules } from '../../src/rules/compile.js';
import { loadBundledRules, parseBundle } from '../../src/rules/bundle.js';
import { scanContent } from '../../src/scan/scanner.js';

const root = join(import.meta.dirname, '../../../..');
const atrDir = join(root, 'rules/atr');
const benignDir = join(root, 'rules/fixtures/benign');
const disabledReport = join(root, 'rules/atr-disabled.json');

describe.skipIf(!existsSync(atrDir))('imported ATR rules', () => {
  const bundle = parseBundle(bundleJson);
  const benign = readdirSync(benignDir).map((f) => readFileSync(join(benignDir, f), 'utf8'));

  it('ships a large rule set with ATR ids and keeps the LICENSE', () => {
    expect(bundle.rules.filter((r) => r.id.startsWith('ATR-')).length).toBeGreaterThan(100);
    expect(existsSync(join(atrDir, 'LICENSE'))).toBe(true);
  });

  it('disables exactly the rules that fire on benign fixtures or fail to compile', () => {
    const disabled = new Set(bundle.disabled);
    const reasons = JSON.parse(readFileSync(disabledReport, 'utf8')) as Record<string, string>;
    const slow = new Set(
      Object.entries(reasons)
        .filter(([, reason]) => reason.startsWith('slow on '))
        .map(([id]) => id),
    );
    expect(slow.size).toBeGreaterThan(0);
    const { compiled, errors } = compileRules(bundle.rules);
    for (const e of errors) expect(disabled.has(e.id), `${e.id} should be disabled`).toBe(true);
    for (const rule of compiled) {
      // Rules disabled by the build-time performance gate are covered by the
      // gate itself; scanning them here would reintroduce the blow-up.
      if (rule.id.startsWith('STROQ-') || slow.has(rule.id)) continue;
      const fires = benign.some(
        (text) => scanContent([rule], text, { threshold: 0 }).matches.length > 0,
      );
      expect(disabled.has(rule.id), `${rule.id} fires=${fires}`).toBe(fires);
    }
  });

  // Regression test for the catastrophic-backtracking finding: rules such as
  // ATR-2026-00220 took ~47 s on a 6.4 KB run of base64 alphabet characters.
  it('keeps a full scan of a 16 KB base64-alphabet blob under 500 ms', () => {
    const rules = loadBundledRules();
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const blob = alphabet.repeat(Math.ceil(16_000 / alphabet.length)).slice(0, 16_000);
    const start = performance.now();
    const result = scanContent(rules, blob);
    expect(performance.now() - start).toBeLessThan(500);
    expect(result.timedOut).toBeUndefined();
  });

  it('keeps a full scan of a 50 KB benign document under 500 ms', () => {
    const rules = loadBundledRules();
    const joined = benign.join('\n');
    const text = joined.repeat(Math.ceil(50_000 / Math.max(1, joined.length)));
    const start = performance.now();
    scanContent(rules, text);
    expect(performance.now() - start).toBeLessThan(500);
  });
});
