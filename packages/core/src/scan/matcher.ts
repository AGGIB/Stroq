import type { CompiledRule, CompiledTest } from '../rules/compile.js';

export type MatchContext = Readonly<Record<string, string>>;

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
