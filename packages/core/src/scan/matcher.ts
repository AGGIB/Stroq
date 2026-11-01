import type { ScanTarget } from '../rules/atr-types.js';
import type { CompiledRule, CompiledTest } from '../rules/compile.js';
import { mayMatch } from '../rules/prefilter/prefilter.js';
import { TextIndexes } from '../rules/prefilter/text-index.js';

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
  if (rule.surfaces !== undefined) return rule.surfaces.includes(target);
  return rule.scanTarget === 'any' || rule.scanTarget === target;
}

function fieldValue(test: CompiledTest, text: string, context: MatchContext): string | null {
  if (test.field === 'content') return text;
  return context[test.field] ?? null;
}

/**
 * Whether one condition holds. `indexes` is what a scan remembers about the texts it reads, so that
 * the many conditions that look for the same literal in the same text look once; a caller that
 * evaluates a single condition can leave it out.
 */
export function evaluateTest(
  test: CompiledTest,
  text: string,
  context: MatchContext,
  indexes: TextIndexes = new TextIndexes(),
): boolean {
  const value = fieldValue(test, text, context);
  if (value === null) return false;
  switch (test.kind) {
    case 'regex':
      // The prefilter is false only for a text the regex cannot match, and is asked about exactly
      // the string the regex would be given.
      if (test.prefilter !== undefined && !mayMatch(test.prefilter, value, indexes)) return false;
      return test.regex?.test(value) ?? false;
    case 'contains':
      return value.toLowerCase().includes(test.value.toLowerCase());
    case 'exact':
      return value === test.value;
    case 'starts_with':
      return value.startsWith(test.value);
  }
}

/**
 * Whether a condition is read on the surface being scanned: always when it names no surfaces or
 * the caller names none (or `any`), so an unscoped call loses nothing.
 */
function testApplies(test: CompiledTest, target: ScanTarget | undefined): boolean {
  if (test.surfaces === undefined || target === undefined || target === 'any') return true;
  return test.surfaces.includes(target);
}

export function ruleMatches(
  rule: CompiledRule,
  text: string,
  context: MatchContext,
  indexes: TextIndexes = new TextIndexes(),
): boolean {
  if (!appliesTo(rule, context.target)) return false;
  const tests = rule.tests.filter((t) => testApplies(t, context.target));
  if (tests.length === 0) return false;
  const results = tests.map((t) => evaluateTest(t, text, context, indexes));
  return rule.condition === 'all' ? results.every(Boolean) : results.some(Boolean);
}

export function matchRules(
  rules: readonly CompiledRule[],
  text: string,
  context: MatchContext = {},
): CompiledRule[] {
  const indexes = new TextIndexes();
  return rules.filter((rule) => ruleMatches(rule, text, context, indexes));
}
