import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadBundledRules } from '../../src/rules/bundle.js';
import { scanContent } from '../../src/scan/scanner.js';

const root = join(import.meta.dirname, '../../../../rules/fixtures');
const read = (dir: string) =>
  readdirSync(join(root, dir)).map((f) => ({
    name: f,
    text: readFileSync(join(root, dir, f), 'utf8'),
  }));
const rules = loadBundledRules();

describe('bundled rules against the fixture corpus', () => {
  it('loads at least the 12 Stroq rules', () => {
    expect(rules.length).toBeGreaterThanOrEqual(12);
  });
  for (const fixture of read('benign')) {
    it(`does not flag benign fixture ${fixture.name}`, () => {
      const r = scanContent(rules, fixture.text);
      expect(r.verdict, JSON.stringify(r.matches)).toBe('clean');
    });
  }
  for (const fixture of read('malicious')) {
    it(`flags malicious fixture ${fixture.name}`, () => {
      expect(scanContent(rules, fixture.text).verdict).toBe('suspect');
    });
  }
});
