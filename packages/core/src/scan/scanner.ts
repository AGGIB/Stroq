import { expandVariants } from '../normalize/normalizer.js';
import type { CompiledRule } from '../rules/compile.js';
import type { RuleMatch, ScanResult, Severity } from '../types.js';
import { appliesTo, ruleMatches, type MatchContext } from './matcher.js';

export interface ScanOptions {
  readonly threshold?: number;
  readonly maxChars?: number;
  /** Wall-clock budget for the whole scan; exceeding it fails closed. */
  readonly budgetMs?: number;
}

export const SEVERITY_WEIGHT: Readonly<Record<Severity, number>> = {
  critical: 1,
  high: 0.7,
  medium: 0.4,
  low: 0.2,
  informational: 0,
};

const DEFAULT_THRESHOLD = 0.6;
// Shared with `extractAtomsDeep` (packages/core/src/provenance/atoms.ts), which
// bounds its input to the same prefix so the two halves of `engine.post` — the
// content scan and provenance atom extraction — never read a different amount of
// the same untrusted text. See the comment there for why that symmetry is safe.
export const DEFAULT_MAX_CHARS = 200_000;
/**
 * The wall-clock ceiling for one scan. Exceeding it fails closed: `timedOut` →
 * `suspect`, which taints the session and denies later actions.
 *
 * It was 500 ms, and 500 ms was too small for the work — measured, not guessed.
 * Scanning the 25 files of the vendored benign corpus with no budget at all, on
 * the machine this was written on:
 *
 *   idle            p50 46 ms   p95 497 ms   max 828 ms   4 of 100 over 500
 *   14 jobs, 10 cores   p50 92 ms   p95 1559 ms  max 1880 ms  12 of 100 over 500
 *
 * So ordinary documentation on an IDLE machine already tripped the budget 4% of
 * the time, and every trip marked a benign read suspect. The evidence was sitting
 * in two files that were never read together: `bench/run.ts` says its slowest
 * corpus file "measures well under 1 s", and `HOOK_DEADLINE_FRACTION`'s comment
 * says "the only wall-clock budget in the decision path is the scanner's 500 ms".
 * Both true; together they say the budget is smaller than the work.
 *
 * 4,000 ms is 2.1x the worst measured under heavy contention and 4.8x the worst
 * measured idle. The hook's own deadline is 60% of a 15 s agent timeout — 9,000 ms
 * — so a scan that spends its whole budget still answers with 5 s to spare, and
 * the watchdog remains the backstop it was.
 *
 * Raising it does not move the primary defence, which is not this. A pathological
 * regex is caught before it ships, by the build-time gate in
 * `scripts/lib/rules-pipeline.ts` — now measured at the scanner's own 200,000
 * character cap rather than at 32,768. This budget is the backstop for a rule that
 * gate missed, and a backstop that fires on benign READMEs is not a backstop.
 */
export const DEFAULT_BUDGET_MS = 4_000;

/**
 * Overrides the default for a machine where it is wrong.
 *
 * It cannot weaken the guard in either direction, which is why it is safe to read
 * from the environment at all: a SMALLER budget fails closed sooner, which is
 * stricter, and a LARGER one only means the scan finishes rather than being
 * abandoned — more detection, not less, bounded above by the hook's own watchdog.
 * An explicit `opts.budgetMs` still wins, so the tests that exercise the timeout
 * set their own and are unaffected by it.
 *
 * Two readers: a container or an old laptop where 4,000 ms is not enough and benign
 * reads are being marked suspect, and this project's own test suite, which sets it
 * high so that a busy machine cannot turn `clean` into `suspect` and fail an
 * assertion that is about behaviour rather than about the clock.
 */
export const SCAN_BUDGET_ENV = 'STROQ_SCAN_BUDGET_MS';

function budgetFromEnv(): number | undefined {
  const raw = process.env[SCAN_BUDGET_ENV];
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  /* A malformed value is ignored rather than honoured as 0, which would fail every
     scan closed and mark every read suspect. */
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
const ENCODED_FLOOR = 0.7;

/** Synthetic match reported when the scan budget runs out. */
export const BUDGET_MATCH: RuleMatch = {
  ruleId: 'STROQ-SCAN-BUDGET',
  title: 'scan budget exceeded',
  severity: 'critical',
  category: 'internal',
  variant: 'raw',
};

function weightOf(match: RuleMatch): number {
  const base = SEVERITY_WEIGHT[match.severity];
  const encoded = match.variant !== 'raw' && match.variant !== 'normalized';
  return encoded ? Math.max(base, ENCODED_FLOOR) : base;
}

function timedOutResult(matches: readonly RuleMatch[]): ScanResult {
  return { verdict: 'suspect', score: 1, matches: [...matches, BUDGET_MATCH], timedOut: true };
}

// Defence in depth against catastrophic regex backtracking (see the
// ATR-2026-00220 finding). The budget is checked *between* rule/variant
// checks, so a single pathological regex still cannot be interrupted once
// V8 has entered it — the build-time performance gate in
// scripts/build-rules.ts is therefore the primary defence, and true
// pre-emption via worker-thread isolation is the Week 3 follow-up.
export function scanContent(
  rules: readonly CompiledRule[],
  text: string,
  opts: ScanOptions = {},
  context: MatchContext = {},
): ScanResult {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const budgetMs = opts.budgetMs ?? budgetFromEnv() ?? DEFAULT_BUDGET_MS;
  const startedAt = performance.now();
  const input = text.length > maxChars ? text.slice(0, maxChars) : text;
  const seen = new Set<string>();
  const matches: RuleMatch[] = [];
  // Filtered once, not per variant: a rule that does not read this surface cannot
  // match any encoding of the text either. `ruleMatches` re-checks, so a caller
  // reaching it by another path is scoped too; this only saves the work.
  const applicable = rules.filter((rule) => appliesTo(rule, context.target));
  for (const variant of expandVariants(input)) {
    for (const rule of applicable) {
      if (performance.now() - startedAt > budgetMs) return timedOutResult(matches);
      const key = `${rule.id}@${variant.kind}`;
      if (seen.has(key) || !ruleMatches(rule, variant.text, context)) continue;
      seen.add(key);
      matches.push({
        ruleId: rule.id,
        title: rule.title,
        severity: rule.severity,
        category: rule.category,
        variant: variant.kind,
      });
    }
  }
  const score = matches.reduce((max, m) => Math.max(max, weightOf(m)), 0);
  return { verdict: score >= threshold ? 'suspect' : 'clean', score, matches };
}
