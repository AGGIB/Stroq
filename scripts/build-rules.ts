// Thin CLI over scripts/lib/rules-pipeline.ts.
//
// Default mode (local, authoritative): rebuilds packages/core/src/rules.bundle.json
// and rules/atr-disabled.json, measuring the regex performance gate on this
// machine. Run this after any change under rules/ and commit the result.
//
// `--check` (CI, deterministic): re-verifies rule compilation and the
// benign-corpus scan against the *committed* rules/atr-disabled.json, then
// byte-compares an in-memory rebuild against the committed bundle. It never
// measures performance (machine speed must not change the outcome) and
// never writes files.
//
// `--advisory-perf` (combine with --check): additionally times every rule
// and prints WARNING lines for anything over threshold that isn't already
// disabled. Purely informational — it never fails the build.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  assembleBundle,
  compareWithCommitted,
  compileRules,
  DEFAULT_SLOW_MS,
  loadBenignFixtures,
  loadRuleSources,
  measureRuleTimings,
  runBenignGate,
  runTimingGate,
  RulesBuildError,
  STROQ_PREFIX,
  type PreviousBundleInfo,
  type RuleTiming,
} from './lib/rules-pipeline.js';

const root = resolve(import.meta.dirname, '..');
const sources = ['rules/stroq', 'rules/atr'].map((d) => join(root, d));
const benignDir = join(root, 'rules/fixtures/benign');
const outFile = join(root, 'packages/core/src/rules.bundle.json');
const disabledReport = join(root, 'rules/atr-disabled.json');

const OUT_OF_DATE_MESSAGE =
  'rules bundle is out of date: run "pnpm build:rules" locally and commit packages/core/src/rules.bundle.json and rules/atr-disabled.json';

const args = new Set(process.argv.slice(2));
const checkMode = args.has('--check');
const advisoryPerf = args.has('--advisory-perf');

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** Loads + compiles the rule sources, printing skip/uncompilable warnings. */
function loadCompiled() {
  const loaded = loadRuleSources(sources);
  for (const s of loaded.skipped) console.warn(`skip ${s.file}: ${s.reason}`);
  const { compiled, errors } = compileRules(loaded.rules);
  for (const e of errors) console.warn(`uncompilable ${e.id}: ${e.error}`);
  return { loaded, compiled, errors };
}

function readPreviousBundle(): PreviousBundleInfo | null {
  return existsSync(outFile)
    ? (JSON.parse(readFileSync(outFile, 'utf8')) as PreviousBundleInfo)
    : null;
}

function printSlowest(measurements: readonly RuleTiming[]): void {
  const top = [...measurements].sort((a, b) => b.ms - a.ms).slice(0, 10);
  console.log('slowest rules (top 10):');
  for (const m of top) console.log(`  ${m.ruleId}: ${m.ms.toFixed(1)} ms on ${m.blob}@${m.size}`);
}

function runDefault(): void {
  const { loaded, compiled, errors } = loadCompiled();
  const compilableIds = new Set(compiled.map((r) => r.id));
  const benign = loadBenignFixtures(benignDir);

  let timing;
  try {
    timing = runTimingGate(compiled, DEFAULT_SLOW_MS);
  } catch (err) {
    if (err instanceof RulesBuildError) fail(`performance gate failed: ${err.message}`);
    throw err;
  }
  printSlowest(timing.measurements);

  const survivors = compiled.filter((r) => !timing.disabled.has(r.id));
  let benignGate;
  try {
    benignGate = runBenignGate(survivors, benign);
  } catch (err) {
    if (err instanceof RulesBuildError) fail(`benign-corpus gate failed: ${err.message}`);
    throw err;
  }

  const disabled = new Map<string, string>([...timing.disabled, ...benignGate.disabled]);
  for (const e of errors) disabled.set(e.id, `uncompilable: ${e.error}`);

  const bundle = assembleBundle({
    loadedRules: loaded.rules,
    compilableIds,
    disabledIds: new Set(disabled.keys()),
    previousBundle: readPreviousBundle(),
  });

  mkdirSync(join(root, 'packages/core/src'), { recursive: true });
  writeFileSync(outFile, JSON.stringify(bundle));
  writeFileSync(disabledReport, JSON.stringify(Object.fromEntries(disabled), null, 2) + '\n');
  console.log(`perf gate: ${timing.disabled.size} slow rule(s) disabled (> ${DEFAULT_SLOW_MS} ms)`);
  console.log(`bundle: ${bundle.rules.length} rules, ${disabled.size} disabled → ${outFile}`);
}

/** Compile errors are a deterministic gate too: an ATR rule newly failing to
 *  compile must already be in the committed disabled list; a Stroq rule
 *  failing to compile always fails the build. */
function verifyCompileErrors(
  errors: readonly { id: string; error: string }[],
  committedDisabled: ReadonlySet<string>,
): string[] {
  const newFailures: string[] = [];
  for (const e of errors) {
    if (e.id.startsWith(STROQ_PREFIX)) fail(`rule ${e.id} fails to compile: ${e.error}`);
    if (!committedDisabled.has(e.id)) newFailures.push(`${e.id} — uncompilable: ${e.error}`);
  }
  return newFailures;
}

function runAdvisoryPerf(
  compiled: ReturnType<typeof loadCompiled>['compiled'],
  committedDisabled: ReadonlySet<string>,
): void {
  const timings = measureRuleTimings(compiled, DEFAULT_SLOW_MS);
  for (const t of timings) {
    if (t.ms > DEFAULT_SLOW_MS && !committedDisabled.has(t.ruleId)) {
      console.warn(`WARNING: slow rule ${t.ruleId}: ${t.ms.toFixed(1)} ms on ${t.blob}@${t.size}`);
    }
  }
}

function runCheck(): void {
  const { loaded, compiled, errors } = loadCompiled();
  const compilableIds = new Set(compiled.map((r) => r.id));

  if (!existsSync(outFile) || !existsSync(disabledReport)) fail(OUT_OF_DATE_MESSAGE);
  const committedText = readFileSync(outFile, 'utf8');
  const committedBundle = JSON.parse(committedText) as PreviousBundleInfo;
  const committedReasons = JSON.parse(readFileSync(disabledReport, 'utf8')) as Record<
    string,
    string
  >;
  const committedDisabled = new Set(Object.keys(committedReasons));

  const newCompileFailures = verifyCompileErrors(errors, committedDisabled);

  // Rules already accounted for in the committed disabled list (typically
  // ones the local perf gate flagged as slow) are never re-scanned here:
  // --check does no timing measurement, and re-running a catastrophic
  // regex through the benign corpus is exactly what the perf gate exists
  // to avoid.
  const candidates = compiled.filter((r) => !committedDisabled.has(r.id));
  let benignGate;
  try {
    benignGate = runBenignGate(candidates, loadBenignFixtures(benignDir));
  } catch (err) {
    if (err instanceof RulesBuildError) fail(`benign-corpus gate failed: ${err.message}`);
    throw err;
  }
  const newBenignFailures = [...benignGate.disabled.entries()].map(
    ([id, fixture]) => `${id} — fires on ${fixture} (not in committed rules/atr-disabled.json)`,
  );

  const newFailures = [...newCompileFailures, ...newBenignFailures];
  if (newFailures.length > 0) {
    console.error(
      'rules bundle check failed — new rule failures not covered by the committed disabled list:',
    );
    for (const f of newFailures) console.error(`  ${f}`);
    process.exit(1);
  }

  const bundle = assembleBundle({
    loadedRules: loaded.rules,
    compilableIds,
    disabledIds: committedDisabled,
    previousBundle: committedBundle,
  });
  if (!compareWithCommitted(bundle, committedText).equal) fail(OUT_OF_DATE_MESSAGE);
  console.log(
    `rules bundle verified: ${bundle.rules.length} rules, ${bundle.disabled.length} disabled`,
  );

  if (advisoryPerf) runAdvisoryPerf(compiled, committedDisabled);
}

if (checkMode) runCheck();
else runDefault();
