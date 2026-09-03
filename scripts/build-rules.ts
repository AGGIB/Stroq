import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadRulesFromDir } from '../packages/core/src/rules/atr-loader.js';
import { compileRules } from '../packages/core/src/rules/compile.js';
import { scanContent } from '../packages/core/src/scan/scanner.js';
import type { AtrRule } from '../packages/core/src/rules/atr-types.js';

const root = resolve(import.meta.dirname, '..');
const sources = ['rules/stroq', 'rules/atr'].map((d) => join(root, d)).filter(existsSync);
const benignDir = join(root, 'rules/fixtures/benign');
const outFile = join(root, 'packages/core/src/rules.bundle.json');
const disabledReport = join(root, 'rules/atr-disabled.json');

const loaded = sources.flatMap((dir) => {
  const { rules, skipped } = loadRulesFromDir(dir);
  for (const s of skipped) console.warn(`skip ${s.file}: ${s.reason}`);
  return rules;
});
const { compiled, errors } = compileRules(loaded);
for (const e of errors) console.warn(`uncompilable ${e.id}: ${e.error}`);
const compilable = new Set(compiled.map((r) => r.id));

const benign = existsSync(benignDir)
  ? readdirSync(benignDir).map((f) => ({ name: f, text: readFileSync(join(benignDir, f), 'utf8') }))
  : [];
const disabled = new Map<string, string>();
for (const rule of compiled) {
  if (rule.id.startsWith('STROQ-')) continue;
  for (const fixture of benign) {
    if (scanContent([rule], fixture.text, { threshold: 0 }).matches.length > 0) {
      disabled.set(rule.id, fixture.name);
      break;
    }
  }
}
for (const e of errors) disabled.set(e.id, `uncompilable: ${e.error}`);

const rules: AtrRule[] = loaded.filter((r) => compilable.has(r.id) || disabled.has(r.id));
const bundle = {
  version: 1,
  generatedAt: new Date().toISOString(),
  rules,
  disabled: [...disabled.keys()].sort(),
};
mkdirSync(join(root, 'packages/core/src'), { recursive: true });
writeFileSync(outFile, JSON.stringify(bundle));
writeFileSync(disabledReport, JSON.stringify(Object.fromEntries(disabled), null, 2) + '\n');
console.log(`bundle: ${rules.length} rules, ${disabled.size} disabled → ${outFile}`);
