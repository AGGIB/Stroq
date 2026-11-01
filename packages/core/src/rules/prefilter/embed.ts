import { compileRegex } from '../compile.js';
import type { PrefilterTable, RuleLiterals } from './prefilter.js';
import { requiredLiterals } from './requirements.js';
import { readPrefilterTable } from './table-check.js';

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

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * `bundle` (as `runtimeBundle` cuts it) with `prefilters`, the table of `prefilterTable` for its
 * enabled rules, unless it already carries one that reads as a table. The CLI's build calls it once,
 * so a hook call reads the table instead of 2,600 patterns; from source it runs when the rules load.
 */
export function withPrefilterTable(bundle: unknown): unknown {
  if (!isObject(bundle) || !Array.isArray(bundle['rules'])) return bundle;
  if (readPrefilterTable(bundle['prefilters']) !== null) return bundle;
  const disabled = Array.isArray(bundle['disabled']) ? bundle['disabled'] : [];
  const skip = new Set(disabled.filter((id): id is string => typeof id === 'string'));
  return { ...bundle, prefilters: prefilterTable(bundle['rules'], skip) };
}
