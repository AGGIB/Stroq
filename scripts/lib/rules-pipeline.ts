// Pure building blocks for scripts/build-rules.ts: loading, compiling, the
// two build-time gates, bundle assembly, and the byte-compare used by
// `--check`. Nothing here touches process.argv, prints, or calls
// process.exit — that's the thin CLI's job — so every step here can be
// exercised directly from a test with a temp directory.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadRulesFromDir, type SkippedRule } from '../../packages/core/src/rules/atr-loader.js';
import { compileRules, type CompiledRule } from '../../packages/core/src/rules/compile.js';
import type { AtrRule } from '../../packages/core/src/rules/atr-types.js';
import { matchRules } from '../../packages/core/src/scan/matcher.js';
import { scanContent } from '../../packages/core/src/scan/scanner.js';

export { compileRules };
export type { AtrRule, CompiledRule, SkippedRule };

/** Rule ids with this prefix are Stroq-authored: never auto-disabled — any
 *  gate failure fails the build instead. */
export const STROQ_PREFIX = 'STROQ-';

/** Raised for a build-breaking condition: a Stroq-authored rule that is slow
 *  or fires on the benign corpus. Callers (the CLI) turn this into a
 *  `console.error` + `process.exit(1)`. */
export class RulesBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RulesBuildError';
  }
}

export interface LoadResult {
  readonly rules: readonly AtrRule[];
  readonly skipped: readonly SkippedRule[];
}

/** Loads and merges ATR-format rules from every existing directory in `dirs`. */
export function loadRuleSources(dirs: readonly string[]): LoadResult {
  const perDir = dirs.filter(existsSync).map((dir) => loadRulesFromDir(dir));
  return {
    rules: perDir.flatMap((r) => r.rules),
    skipped: perDir.flatMap((r) => r.skipped),
  };
}

export interface BenignFixture {
  readonly name: string;
  readonly text: string;
}

/** Reads every file in `dir` as a benign fixture; `[]` if it doesn't exist. */
export function loadBenignFixtures(dir: string): readonly BenignFixture[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8') }));
}

// --- Timing gate -------------------------------------------------------------

export interface BlobSpec {
  readonly name: string;
  readonly build: (size: number) => string;
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const repeatTo = (unit: string, size: number): string =>
  unit.repeat(Math.ceil(size / unit.length)).slice(0, size);

export const BLOB_CHARS = 32_768;
// A rule that already blows up on a short blob is disabled without escalating
// to the full 32 KB: catastrophic backtracking is superlinear, so a smaller
// measurement over the threshold is a safe (and terminating) over-approximation.
export const DEFAULT_STAGES: readonly number[] = [2_048, 8_192, BLOB_CHARS];
export const DEFAULT_BLOBS: readonly BlobSpec[] = [
  { name: 'base64-alphabet', build: (size) => repeatTo(BASE64_ALPHABET, size) },
  { name: 'letter-a', build: (size) => 'a'.repeat(size) },
  { name: 'urls', build: (size) => repeatTo('http://a.example/x ', size) },
];

/** Local build default: a rule slower than this on the adversarial blobs is
 *  disabled. Lower than the previous 50 ms specifically to leave margin for
 *  machines slower than the one that ran the build (see --advisory-perf). */
export const DEFAULT_SLOW_MS = 25;

export interface RuleTiming {
  readonly ruleId: string;
  readonly ms: number;
  readonly blob: string;
  readonly size: number;
}

/**
 * Times every rule against the adversarial blobs, one measurement per rule:
 * its worst (slowest) stage. Stops escalating a rule to the next stage once
 * one exceeds `thresholdMs` (see DEFAULT_STAGES) — that stage's numbers are
 * what's returned for it. Pure timing only: no disabling, no throwing, so
 * both the build-time gate and the CI advisory pass can share it.
 */
export function measureRuleTimings(
  rules: readonly CompiledRule[],
  thresholdMs: number,
  blobs: readonly BlobSpec[] = DEFAULT_BLOBS,
  stages: readonly number[] = DEFAULT_STAGES,
): readonly RuleTiming[] {
  return rules.map((rule) => {
    let worst: RuleTiming = { ruleId: rule.id, ms: -1, blob: '', size: 0 };
    for (const blob of blobs) {
      for (const size of stages) {
        const started = performance.now();
        matchRules([rule], blob.build(size));
        const ms = performance.now() - started;
        if (ms > worst.ms) worst = { ruleId: rule.id, ms, blob: blob.name, size };
        if (ms > thresholdMs) return worst;
      }
    }
    return worst;
  });
}

export interface TimingGateResult {
  readonly disabled: ReadonlyMap<string, string>;
  readonly measurements: readonly RuleTiming[];
}

/**
 * Applies the timing gate's build policy on top of `measureRuleTimings`: a
 * vendored rule over `thresholdMs` is disabled with a deterministic reason
 * (no measured value, so a rerun with no real change stays byte-identical);
 * a Stroq rule over the threshold throws `RulesBuildError` instead — Stroq
 * rules are never auto-disabled.
 */
export function runTimingGate(
  rules: readonly CompiledRule[],
  thresholdMs: number,
  blobs: readonly BlobSpec[] = DEFAULT_BLOBS,
  stages: readonly number[] = DEFAULT_STAGES,
): TimingGateResult {
  const measurements = measureRuleTimings(rules, thresholdMs, blobs, stages);
  const disabled = new Map<string, string>();
  for (const m of measurements) {
    if (m.ms <= thresholdMs) continue;
    const reason = `slow on ${m.blob}@${m.size} (>${thresholdMs} ms)`;
    if (m.ruleId.startsWith(STROQ_PREFIX)) throw new RulesBuildError(`${m.ruleId} — ${reason}`);
    disabled.set(m.ruleId, reason);
  }
  return { disabled, measurements };
}

// --- Benign-corpus gate --------------------------------------------------

export interface BenignGateResult {
  readonly disabled: ReadonlyMap<string, string>;
}

/**
 * Scans `rules` against every benign fixture. A vendored rule that fires is
 * disabled with the fixture's name as the reason; a Stroq rule that fires
 * throws `RulesBuildError` instead — a Stroq false positive is a bug to fix,
 * never something to silently disable.
 *
 * Callers decide which rules are candidates: `--check` mode excludes
 * anything already in the committed disabled list before calling this, so
 * an already-known firing rule never reaches it (see build-rules.ts).
 */
export function runBenignGate(
  rules: readonly CompiledRule[],
  fixtures: readonly BenignFixture[],
): BenignGateResult {
  const disabled = new Map<string, string>();
  for (const rule of rules) {
    const hit = fixtures.find(
      (f) => scanContent([rule], f.text, { threshold: 0, budgetMs: 5_000 }).matches.length > 0,
    );
    if (!hit) continue;
    if (rule.id.startsWith(STROQ_PREFIX))
      throw new RulesBuildError(`${rule.id} — fires on ${hit.name}`);
    disabled.set(rule.id, hit.name);
  }
  return { disabled };
}

// --- Assemble ----------------------------------------------------------------

export interface PreviousBundleInfo {
  readonly generatedAt?: string;
  readonly rules?: unknown;
  readonly disabled?: unknown;
}

export interface Bundle {
  readonly version: 1;
  readonly generatedAt: string;
  readonly rules: readonly AtrRule[];
  readonly disabled: readonly string[];
}

export interface AssembleBundleInput {
  readonly loadedRules: readonly AtrRule[];
  readonly compilableIds: ReadonlySet<string>;
  readonly disabledIds: ReadonlySet<string>;
  readonly previousBundle: PreviousBundleInfo | null;
  /** Injectable clock for tests; defaults to the real current time. */
  readonly now?: () => string;
}

/**
 * Builds the bundle payload from loaded rules plus the gates' verdicts.
 * Reuses `previousBundle.generatedAt` when the rule set and disabled list
 * are otherwise unchanged, so a rerun with no real change produces a
 * byte-identical bundle instead of dirtying the tree on every build.
 */
export function assembleBundle(input: AssembleBundleInput): Bundle {
  const rules = input.loadedRules.filter(
    (r) => input.compilableIds.has(r.id) || input.disabledIds.has(r.id),
  );
  const disabled = [...input.disabledIds].sort();
  const unchanged =
    input.previousBundle !== null &&
    JSON.stringify(input.previousBundle.rules) === JSON.stringify(rules) &&
    JSON.stringify(input.previousBundle.disabled) === JSON.stringify(disabled);
  const generatedAt =
    unchanged && input.previousBundle?.generatedAt
      ? input.previousBundle.generatedAt
      : (input.now ?? (() => new Date().toISOString()))();
  return { version: 1, generatedAt, rules, disabled };
}

// --- Compare -------------------------------------------------------------

export interface CompareResult {
  readonly equal: boolean;
  readonly assembledJson: string;
}

/**
 * Byte-compares an assembled bundle against the committed bundle file's raw
 * text (as written by the default build: `JSON.stringify`, no pretty
 * printing, no trailing newline).
 */
export function compareWithCommitted(assembled: Bundle, committedJson: string): CompareResult {
  const assembledJson = JSON.stringify(assembled);
  return { equal: assembledJson === committedJson, assembledJson };
}
