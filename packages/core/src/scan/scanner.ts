import { expandVariants } from '../normalize/normalizer.js';
import type { CompiledRule } from '../rules/compile.js';
import type { RuleMatch, ScanResult, Severity } from '../types.js';
import { ruleMatches, type MatchContext } from './matcher.js';

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
const DEFAULT_MAX_CHARS = 200_000;
// 500 ms, not 200 ms: a spurious fail-closed (timedOut → suspect) on a
// slow/loaded machine is worse than a scan that occasionally takes longer.
export const DEFAULT_BUDGET_MS = 500;
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
  const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS;
  const startedAt = performance.now();
  const input = text.length > maxChars ? text.slice(0, maxChars) : text;
  const seen = new Set<string>();
  const matches: RuleMatch[] = [];
  for (const variant of expandVariants(input)) {
    for (const rule of rules) {
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
