import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadRulesFromDir } from '../packages/core/src/rules/atr-loader.js';
import { compileRules, type CompiledRule } from '../packages/core/src/rules/compile.js';
import { matchRules } from '../packages/core/src/scan/matcher.js';
import { scanContent } from '../packages/core/src/scan/scanner.js';
import type { AtrRule } from '../packages/core/src/rules/atr-types.js';

const root = resolve(import.meta.dirname, '..');
const sources = ['rules/stroq', 'rules/atr'].map((d) => join(root, d)).filter(existsSync);
const benignDir = join(root, 'rules/fixtures/benign');
const outFile = join(root, 'packages/core/src/rules.bundle.json');
const disabledReport = join(root, 'rules/atr-disabled.json');

const SLOW_MS = 50;
const BLOB_CHARS = 32_768;
// A rule that already blows up on a short blob is disabled without escalating
// to the full 32 KB: catastrophic backtracking is superlinear, so a smaller
// measurement over the threshold is a safe (and terminating) over-approximation.
const STAGES = [2_048, 8_192, BLOB_CHARS];
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const repeatTo = (unit: string, size: number): string =>
  unit.repeat(Math.ceil(size / unit.length)).slice(0, size);

const BLOBS: ReadonlyArray<{ name: string; build: (size: number) => string }> = [
  { name: 'base64-alphabet', build: (size) => repeatTo(BASE64_ALPHABET, size) },
  { name: 'letter-a', build: (size) => 'a'.repeat(size) },
  { name: 'urls', build: (size) => repeatTo('http://a.example/x ', size) },
];

/** Returns a `slow: …` reason when the rule exceeds SLOW_MS on any blob. */
function slowReason(rule: CompiledRule): string | null {
  for (const blob of BLOBS) {
    for (const size of STAGES) {
      const text = blob.build(size);
      const started = performance.now();
      matchRules([rule], text);
      const ms = performance.now() - started;
      if (ms > SLOW_MS) return `slow: ${ms.toFixed(0)} ms on ${blob.name}@${size}`;
    }
  }
  return null;
}

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
const slowOurs: string[] = [];
let slowCount = 0;
for (const rule of compiled) {
  const slow = slowReason(rule);
  if (slow) {
    // We fix our own rules, never auto-disable them.
    if (rule.id.startsWith('STROQ-')) slowOurs.push(`${rule.id} — ${slow}`);
    else {
      disabled.set(rule.id, slow);
      slowCount += 1;
    }
    continue;
  }
  if (rule.id.startsWith('STROQ-')) continue;
  for (const fixture of benign) {
    if (scanContent([rule], fixture.text, { threshold: 0, budgetMs: 5_000 }).matches.length > 0) {
      disabled.set(rule.id, fixture.name);
      break;
    }
  }
}
if (slowOurs.length > 0) {
  console.error(`performance gate failed for ${slowOurs.length} Stroq rule(s):`);
  for (const line of slowOurs) console.error(`  ${line}`);
  process.exit(1);
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
console.log(`perf gate: ${slowCount} slow rule(s) disabled (> ${SLOW_MS} ms)`);
console.log(`bundle: ${rules.length} rules, ${disabled.size} disabled → ${outFile}`);
