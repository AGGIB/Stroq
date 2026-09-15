import type { ScanTarget } from '../rules/atr-types.js';
import type { CompiledRule, CompiledTest } from '../rules/compile.js';

export interface MatchContext {
  /**
   * The surface being scanned. A caller that knows it — the engine, the bench, the
   * exposure probe — names it, and a rule scoped to a different surface stays quiet.
   * Leaving it out means "surface unknown", under which every rule fires: an existing
   * call site that has not been taught about surfaces must not silently narrow.
   */
  readonly target?: ScanTarget;
  readonly [field: string]: string | undefined;
}

/**
 * Whether `rule` reads the surface the caller is scanning. Unknown surface, or a rule
 * that reads `any`, always applies — narrowing only ever happens when both sides have
 * named a surface and they differ.
 */
export function appliesTo(rule: CompiledRule, target: ScanTarget | undefined): boolean {
  if (target === undefined || target === 'any') return true;
  return rule.scanTarget === 'any' || rule.scanTarget === target;
}

function fieldValue(test: CompiledTest, text: string, context: MatchContext): string | null {
  if (test.field === 'content') return text;
  return context[test.field] ?? null;
}

export function evaluateTest(test: CompiledTest, text: string, context: MatchContext): boolean {
  const value = fieldValue(test, text, context);
  if (value === null) return false;
  switch (test.kind) {
    case 'regex':
      return test.regex?.test(value) ?? false;
    case 'contains':
      return value.toLowerCase().includes(test.value.toLowerCase());
    case 'exact':
      return value === test.value;
    case 'starts_with':
      return value.startsWith(test.value);
  }
}

export function ruleMatches(rule: CompiledRule, text: string, context: MatchContext): boolean {
  if (!appliesTo(rule, context.target)) return false;
  const results = rule.tests.map((t) => evaluateTest(t, text, context));
  return rule.condition === 'all' ? results.every(Boolean) : results.some(Boolean);
}

export function matchRules(
  rules: readonly CompiledRule[],
  text: string,
  context: MatchContext = {},
): CompiledRule[] {
  return rules.filter((rule) => ruleMatches(rule, text, context));
}
