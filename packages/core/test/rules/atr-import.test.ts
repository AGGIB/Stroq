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

describe.skipIf(!existsSync(atrDir))('imported ATR rules', () => {
  const bundle = parseBundle(bundleJson);
  const benign = readdirSync(benignDir).map((f) => readFileSync(join(benignDir, f), 'utf8'));

  it('ships a large rule set with ATR ids and keeps the LICENSE', () => {
    expect(bundle.rules.filter((r) => r.id.startsWith('ATR-')).length).toBeGreaterThan(100);
    expect(existsSync(join(atrDir, 'LICENSE'))).toBe(true);
  });

  it('disables exactly the rules that fire on benign fixtures or fail to compile', () => {
    const disabled = new Set(bundle.disabled);
    const { compiled, errors } = compileRules(bundle.rules);
    for (const e of errors) expect(disabled.has(e.id), `${e.id} should be disabled`).toBe(true);
    for (const rule of compiled) {
      if (rule.id.startsWith('STROQ-')) continue;
      const fires = benign.some(
        (text) => scanContent([rule], text, { threshold: 0 }).matches.length > 0,
      );
      expect(disabled.has(rule.id), `${rule.id} fires=${fires}`).toBe(fires);
    }
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
