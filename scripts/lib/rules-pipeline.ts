// Pure building blocks for scripts/build-rules.ts: loading, compiling, the
// two build-time gates, bundle assembly, and the byte-compare used by
// `--check`. Nothing here touches process.argv, prints, or calls
// process.exit — that's the thin CLI's job — so every step here can be
// exercised directly from a test with a temp directory.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
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

// --- Vendored-rule pattern overrides -----------------------------------------

/**
 * One condition's regex, replaced at build time. See rules/atr-overrides.yaml for
 * why this exists at all rather than editing the vendored file or disabling the
 * rule outright.
 */
export interface OverrideCondition {
  readonly index: number;
  /** The value as currently parsed from the vendored rule. A mismatch fails the build. */
  readonly from: string;
  readonly to: string;
}

export interface RuleOverride {
  readonly reason: string;
  readonly conditions: readonly OverrideCondition[];
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/**
 * Parses rules/atr-overrides.yaml; an absent file means no overrides.
 *
 * Validated by hand rather than with zod, which is a dependency of @stroq/core and
 * not of the build scripts. Malformed input throws: this file changes what ships in
 * the bundle, so a typo must stop the build rather than silently apply nothing.
 */
export function loadRuleOverrides(file: string): ReadonlyMap<string, RuleOverride> {
  if (!existsSync(file)) return new Map();
  let doc: unknown;
  try {
    doc = parseYaml(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new RulesBuildError(`${file}: invalid YAML: ${(err as Error).message}`);
  }
  if (doc === null || doc === undefined) return new Map();
  if (!isObject(doc))
    throw new RulesBuildError(`${file}: expected a mapping of rule id to override`);

  const out = new Map<string, RuleOverride>();
  for (const [id, raw] of Object.entries(doc)) {
    const where = `${file}: ${id}`;
    if (!isObject(raw)) throw new RulesBuildError(`${where}: expected a mapping`);
    if (!isNonEmptyString(raw['reason'])) {
      throw new RulesBuildError(`${where}: "reason" must be a non-empty string`);
    }
    const conditions = raw['conditions'];
    if (!Array.isArray(conditions) || conditions.length === 0) {
      throw new RulesBuildError(`${where}: "conditions" must be a non-empty list`);
    }
    const parsed = conditions.map((c, i) => {
      const at = `${where}.conditions[${i}]`;
      if (!isObject(c)) throw new RulesBuildError(`${at}: expected a mapping`);
      const index = c['index'];
      if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
        throw new RulesBuildError(`${at}: "index" must be a non-negative integer`);
      }
      if (!isNonEmptyString(c['from']))
        throw new RulesBuildError(`${at}: "from" must be a non-empty string`);
      if (!isNonEmptyString(c['to']))
        throw new RulesBuildError(`${at}: "to" must be a non-empty string`);
      const unknown = Object.keys(c).filter((k) => !['index', 'from', 'to'].includes(k));
      if (unknown.length > 0)
        throw new RulesBuildError(`${at}: unknown field(s): ${unknown.join(', ')}`);
      return { index, from: c['from'], to: c['to'] } satisfies OverrideCondition;
    });
    const unknown = Object.keys(raw).filter((k) => !['reason', 'conditions'].includes(k));
    if (unknown.length > 0)
      throw new RulesBuildError(`${where}: unknown field(s): ${unknown.join(', ')}`);
    out.set(id, { reason: raw['reason'], conditions: parsed });
  }
  return out;
}

/**
 * Returns `rules` with each override applied, and the ids it touched.
 *
 * Every failure mode is a build error rather than a skipped override, because the
 * situation an override has to survive is a re-import at a new upstream version:
 * an entry that no longer applies has to be read by a human, not dropped. In
 * particular `from` must still match — upstream may have fixed the pattern itself,
 * or moved the defect somewhere this override no longer addresses.
 */
export function applyRuleOverrides(
  rules: readonly AtrRule[],
  overrides: ReadonlyMap<string, RuleOverride>,
): { readonly rules: readonly AtrRule[]; readonly applied: readonly string[] } {
  if (overrides.size === 0) return { rules, applied: [] };
  const byId = new Map(rules.map((r) => [r.id, r]));
  for (const id of overrides.keys()) {
    if (id.startsWith(STROQ_PREFIX)) {
      throw new RulesBuildError(
        `rule override for ${id}: ${id} is Stroq-authored — edit its rule file instead of overriding it`,
      );
    }
    if (!byId.has(id)) {
      throw new RulesBuildError(
        `rule override for ${id}: no such rule in the loaded sources (was it renamed or dropped upstream?)`,
      );
    }
  }

  const applied: string[] = [];
  const out = rules.map((rule) => {
    const override = overrides.get(rule.id);
    if (!override) return rule;
    const conditions = [...rule.detection.conditions];
    for (const c of override.conditions) {
      const current = conditions[c.index];
      if (!current) {
        throw new RulesBuildError(
          `rule override for ${rule.id}: condition ${c.index} does not exist (the rule has ${conditions.length})`,
        );
      }
      if (current.value !== c.from) {
        throw new RulesBuildError(
          `rule override for ${rule.id} condition ${c.index}: the vendored pattern is no longer the one this override was written against.\n` +
            `  expected: ${c.from}\n` +
            `  found:    ${current.value}\n` +
            `Re-read the upstream rule and either update or delete the entry in rules/atr-overrides.yaml.`,
        );
      }
      if (c.to === c.from) {
        throw new RulesBuildError(
          `rule override for ${rule.id} condition ${c.index}: "to" is identical to "from", so the entry changes nothing`,
        );
      }
      conditions[c.index] = { ...current, value: c.to };
    }
    applied.push(rule.id);
    return { ...rule, detection: { ...rule.detection, conditions } };
  });
  return { rules: out, applied };
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

/**
 * Ceiling for the disable threshold: no machine gets a *looser* gate than this,
 * however slow it is. It is no longer the threshold itself — see
 * `deriveThresholdMs`, which tightens it on faster hardware.
 */
export const DEFAULT_SLOW_MS = 25;

/**
 * The percentile of the rule population used as this machine's speed anchor.
 *
 * Deliberately not p99: the gate measures all 648 rules *including* the slow
 * ones it exists to catch, and there are 8 of them — 1.2% of the population —
 * so p99 lands inside the tail it is supposed to detect. Measured here, p99 is
 * 21.5 ms while p95 is 0.232 ms. An anchor contaminated by the outliers scales
 * with them and the gate stops convicting anything.
 *
 * p95 sits in open space. The population's slowest non-pathological rule is
 * 0.6 ms and the slowest pathological one 1926 ms; the cliff between them
 * (0.6 → 21.3 ms) is a factor of 35, so nothing lives near the boundary.
 */
export const ANCHOR_PERCENTILE = 0.95;

/**
 * The disable threshold, in multiples of this machine's own anchor rule time.
 *
 * An absolute millisecond threshold does not mean the same thing on two
 * machines, and the gate's verdict moved with the builder's laptop: measured on
 * the same two rules, the same blob, `ATR-2026-00141` timed 21 ms here and
 * 55.9 ms on a CI runner, `ATR-2026-00149` 21 ms here and 70.2 ms there — a
 * 2.7–3.3x spread straddling the 25 ms line, so whoever ran `build:rules` last
 * decided whether those rules shipped. Anchoring to a percentile of the same
 * population, measured in the same process, removes the hardware from the
 * verdict: a slow rule is slow *relative to the other 640 rules on this
 * machine*.
 *
 * 30 lands in the middle of that cliff. Measured here after warm-up: p95 is
 * 0.232 ms, so the threshold is 7.0 ms — twelve times the slowest rule that
 * should ship (0.6 ms) and a third of the slowest that should not (21.3 ms).
 * Any factor from roughly 5 to 90 returns the same verdict on this population,
 * so this is not a number tuned to produce an answer.
 */
export const SLOW_FACTOR = 30;

/** Timing passes per rule. The reported figure is the fastest — noise on a wall
 *  clock is one-sided, so the minimum is the closest estimate of the real cost. */
export const TIMING_PASSES = 3;

/**
 * Derives this machine's disable threshold from its own measurements.
 *
 * Capped by `DEFAULT_SLOW_MS` so a slow machine can only ever be *stricter*
 * than the historical absolute gate, never more permissive: the scan budget a
 * rule eventually competes with (`DEFAULT_BUDGET_MS`) is wall-clock on the
 * *user's* machine, so a fast builder must not be able to bless a rule that is
 * catastrophic for everyone else.
 */
export function deriveThresholdMs(measurements: readonly RuleTiming[]): number {
  if (measurements.length === 0) return DEFAULT_SLOW_MS;
  const sorted = [...measurements].map((m) => m.ms).sort((a, b) => a - b);
  const anchor = sorted[Math.floor(sorted.length * ANCHOR_PERCENTILE)] ?? 0;
  return Math.min(DEFAULT_SLOW_MS, SLOW_FACTOR * anchor);
}

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

/**
 * `measureRuleTimings` made reproducible: one discarded warm-up pass, then the
 * fastest of `TIMING_PASSES` measurements per rule.
 *
 * A single cold pass is not a measurement, it is a coin toss. Three consecutive
 * single-pass runs of this corpus on one unchanged machine reported p99 of
 * 1.558, 0.398 and 0.372 ms and a slowest rule of 24.9, 23.9 and 27.7 ms — the
 * last of which crosses the 25 ms line the gate used to decide on, so the same
 * machine disabled different rules depending on when it was asked. Most of the
 * spread is JIT warm-up: the first pass over 641 rules cost 162 ms against 71
 * and 76 ms for the two that followed. Warmed and taken as a minimum, the same
 * figures repeat within about 2% (p99 0.298–0.312 ms, slowest 21.3–21.7 ms).
 *
 * `capMs` only bounds the escalation to larger blobs, so a catastrophic rule
 * still terminates early; the verdict itself is `deriveThresholdMs`'s.
 */
export function measureRuleTimingsStable(
  rules: readonly CompiledRule[],
  capMs: number = DEFAULT_SLOW_MS,
  blobs: readonly BlobSpec[] = DEFAULT_BLOBS,
  stages: readonly number[] = DEFAULT_STAGES,
): readonly RuleTiming[] {
  measureRuleTimings(rules, capMs, blobs, stages);
  const best = new Map<string, RuleTiming>();
  for (let pass = 0; pass < TIMING_PASSES; pass += 1) {
    for (const m of measureRuleTimings(rules, capMs, blobs, stages)) {
      const seen = best.get(m.ruleId);
      if (!seen || m.ms < seen.ms) best.set(m.ruleId, m);
    }
  }
  return rules.map((r) => best.get(r.id) ?? { ruleId: r.id, ms: -1, blob: '', size: 0 });
}

/**
 * The largest input `scanContent` will ever hand a rule.
 *
 * Kept equal to the engine's own `DEFAULT_MAX_CHARS` rather than imported, so
 * that the number the gate tests at is visible in the gate — and so the two can
 * only diverge through an edit that reads this sentence. `productionGate`'s
 * shipped-set assertion in the test suite fails if they do.
 */
export const PRODUCTION_CHARS = 200_000;

/** Times every rule against every blob at one fixed size, worst blob wins. */
export function measureAtSize(
  rules: readonly CompiledRule[],
  size: number,
  blobs: readonly BlobSpec[] = DEFAULT_BLOBS,
): readonly RuleTiming[] {
  return rules.map((rule) => {
    let worst: RuleTiming = { ruleId: rule.id, ms: -1, blob: '', size };
    for (const blob of blobs) {
      const text = blob.build(size);
      const started = performance.now();
      matchRules([rule], text);
      const ms = performance.now() - started;
      if (ms > worst.ms) worst = { ruleId: rule.id, ms, blob: blob.name, size };
    }
    return worst;
  });
}

/**
 * The second gate: no rule may be slow at the size production actually allows.
 *
 * The escalation gate above measures up to 32,768 characters and decides
 * RELATIVELY, against this machine's own p95. Both choices are right for what it
 * does — it has to terminate on a catastrophic rule, and it has to give the same
 * verdict on a fast laptop and a slow runner. Neither answers this question:
 * backtracking is superlinear, so being comfortable on the gate's largest blob
 * is not the same as being comfortable on 200,000 characters, which is 6.1x more
 * and is what `scanContent` will hand it.
 *
 * Measured on the shipped set at that size: every rule is linear (the ratio from
 * 32 KB to 200 KB tracks the size ratio), the slowest single rule is 3.4 ms, and
 * the whole set with every variant costs 117 ms against a 500 ms scan budget. So
 * this gate convicts nothing today. It is here because the scanner checks its
 * budget BETWEEN rules and cannot interrupt one that has already entered V8:
 * the only place a pathological regex can be stopped is before it ships, and
 * until now the place it shipped through did not test it at full size.
 *
 * Absolute, not relative: this is a question about a fixed budget, so a faster
 * machine must not be allowed to admit a slower rule. Returns the rules over
 * `ceilingMs`, with the same value-free reason the escalation gate uses, because
 * it is committed to `rules/atr-disabled.json`.
 */
export function productionGate(
  rules: readonly CompiledRule[],
  ceilingMs: number = DEFAULT_SLOW_MS,
  blobs: readonly BlobSpec[] = DEFAULT_BLOBS,
): ReadonlyMap<string, string> {
  const over = new Map<string, string>();
  for (const timing of measureAtSize(rules, PRODUCTION_CHARS, blobs)) {
    if (timing.ms <= ceilingMs) continue;
    const reason = `slow on ${timing.blob}@${PRODUCTION_CHARS} (production-size perf gate)`;
    if (timing.ruleId.startsWith(STROQ_PREFIX))
      throw new RulesBuildError(`${timing.ruleId} — ${reason}`);
    over.set(timing.ruleId, reason);
  }
  return over;
}

export interface TimingGateResult {
  readonly disabled: ReadonlyMap<string, string>;
  readonly measurements: readonly RuleTiming[];
  /** What this machine derived as its own threshold, for the build to report. */
  readonly thresholdMs: number;
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
  capMs: number = DEFAULT_SLOW_MS,
  blobs: readonly BlobSpec[] = DEFAULT_BLOBS,
  stages: readonly number[] = DEFAULT_STAGES,
): TimingGateResult {
  const measurements = measureRuleTimingsStable(rules, capMs, blobs, stages);
  const thresholdMs = deriveThresholdMs(measurements);
  const disabled = new Map<string, string>();
  for (const m of measurements) {
    if (m.ms <= thresholdMs) continue;
    // The reason stays free of measured values on purpose: it is committed to
    // rules/atr-disabled.json, and a rerun that changed nothing real must leave
    // that file byte-identical.
    const reason = `slow on ${m.blob}@${m.size} (relative perf gate)`;
    if (m.ruleId.startsWith(STROQ_PREFIX)) throw new RulesBuildError(`${m.ruleId} — ${reason}`);
    disabled.set(m.ruleId, reason);
  }
  return { disabled, measurements, thresholdMs };
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
 *
 * Surface-blind on purpose: the scan below names no `scan_target`, so every rule is
 * measured against every fixture whatever surface it reads. A rule must be benign
 * everywhere to ship enabled — otherwise declaring a surface would become a way to
 * get a rule that fires on benign text past the gate, which is the gate inverted.
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
