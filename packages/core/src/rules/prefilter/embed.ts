import { compileRegex } from '../compile.js';
import type { PrefilterTable, RuleLiterals } from './prefilter.js';
import { requiredLiterals } from './requirements.js';

/**
 * The literals a condition's pattern requires, as `compileRule` finds them when it is given none.
 * A pattern that does not compile requires nothing here, and `compileRule` reports it.
 */
export function literalsOfPattern(pattern: string): readonly string[] | null {
  try {
    const regex = compileRegex(pattern);
    return requiredLiterals(regex.source, regex.flags);
  } catch {
    return null;
  }
}

interface RuleLike {
  readonly id?: unknown;
  readonly detection?: { readonly conditions?: unknown };
}

const conditionsOf = (rule: RuleLike): readonly unknown[] => {
  const conditions = rule.detection?.conditions;
  return Array.isArray(conditions) ? conditions : [];
};

function literalsOfCondition(condition: unknown): readonly string[] | null {
  const { operator, value } = (condition ?? {}) as { operator?: unknown; value?: unknown };
  return operator === 'regex' && typeof value === 'string' ? literalsOfPattern(value) : null;
}

/**
 * The literals every condition of `rules` requires, worked out once, when the CLI is built, instead
 * of by every hook call: reading 2,600 patterns takes about 40 ms in a new process, more than the
 * prefilter saves on a short text. The table lives in the same JSON as the patterns and is made from
 * them in the same step, so it cannot describe other patterns than the ones it ships with.
 *
 * Rules in `skip` (the disabled ones) are left out; the engine never compiles them. So is an id
 * that more than one rule has: the table is read by id, and one entry would be applied to the other
 * rule's patterns. Those rules work their literals out when they are compiled.
 */
export function prefilterTable(
  rules: readonly unknown[],
  skip: ReadonlySet<string> = new Set(),
): PrefilterTable {
  const entries = new Map<string, RuleLiterals>();
  const repeated = new Set<string>();
  for (const rule of rules) {
    const { id } = (rule ?? {}) as RuleLike;
    if (typeof id !== 'string' || skip.has(id)) continue;
    if (entries.has(id)) repeated.add(id);
    entries.set(id, conditionsOf(rule as RuleLike).map(literalsOfCondition));
  }
  return Object.fromEntries([...entries].filter(([id]) => !repeated.has(id)));
}
