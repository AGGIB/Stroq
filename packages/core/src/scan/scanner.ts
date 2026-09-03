import { expandVariants } from '../normalize/normalizer.js';
import type { CompiledRule } from '../rules/compile.js';
import type { RuleMatch, ScanResult, Severity } from '../types.js';
import { matchRules, type MatchContext } from './matcher.js';

export interface ScanOptions {
  readonly threshold?: number;
  readonly maxChars?: number;
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
const ENCODED_FLOOR = 0.7;

function weightOf(match: RuleMatch): number {
  const base = SEVERITY_WEIGHT[match.severity];
  const encoded = match.variant !== 'raw' && match.variant !== 'normalized';
  return encoded ? Math.max(base, ENCODED_FLOOR) : base;
}

export function scanContent(
  rules: readonly CompiledRule[],
  text: string,
  opts: ScanOptions = {},
  context: MatchContext = {},
): ScanResult {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const input = text.length > maxChars ? text.slice(0, maxChars) : text;
  const seen = new Set<string>();
  const matches: RuleMatch[] = [];
  for (const variant of expandVariants(input)) {
    for (const rule of matchRules(rules, variant.text, context)) {
      const key = `${rule.id}@${variant.kind}`;
      if (seen.has(key)) continue;
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
