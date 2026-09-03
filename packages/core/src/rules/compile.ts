import type { Severity } from '../types.js';
import type { AtrCondition, AtrRule } from './atr-types.js';

export interface CompiledTest {
  readonly field: string;
  readonly kind: AtrCondition['operator'];
  readonly regex?: RegExp;
  readonly value: string;
}

export interface CompiledRule {
  readonly id: string;
  readonly title: string;
  readonly severity: Severity;
  readonly category: string;
  readonly condition: 'any' | 'all';
  readonly tests: readonly CompiledTest[];
}

const LEADING_FLAGS = /^\(\?([imsx]+)\)/;
// `\u{...}` code-point escapes and `\p{...}` property escapes only compile
// with the `u` flag. We add it *only* for those patterns, because `u` also
// rejects escapes that are legal in a non-unicode RegExp; a pattern that
// still throws is recorded as an error, exactly as before.
const NEEDS_UNICODE = /\\[upP]\{/;

export function translatePcre(pattern: string): { source: string; flags: string } {
  let source = pattern;
  let flags = '';
  const m = LEADING_FLAGS.exec(source);
  if (m) {
    source = source.slice(m[0].length);
    for (const f of m[1] ?? '') if ('ims'.includes(f) && !flags.includes(f)) flags += f;
  }
  source = source
    .replace(/\\A/g, '^')
    .replace(/\\Z/g, '$')
    .replace(/([+*?}])\+/g, '$1');
  if (NEEDS_UNICODE.test(source)) flags += 'u';
  return { source, flags };
}

function compileTest(c: AtrCondition): CompiledTest {
  if (c.operator !== 'regex') return { field: c.field, kind: c.operator, value: c.value };
  const { source, flags } = translatePcre(c.value);
  return { field: c.field, kind: 'regex', regex: new RegExp(source, flags), value: c.value };
}

export function compileRule(rule: AtrRule): { compiled?: CompiledRule; error?: string } {
  try {
    const tests = rule.detection.conditions.map(compileTest);
    return {
      compiled: {
        id: rule.id,
        title: rule.title,
        severity: rule.severity,
        category: rule.tags?.category ?? 'uncategorized',
        condition: rule.detection.condition,
        tests,
      },
    };
  } catch (err) {
    return { error: `${rule.id}: ${(err as Error).message}` };
  }
}

export function compileRules(rules: readonly AtrRule[]): {
  compiled: CompiledRule[];
  errors: Array<{ id: string; error: string }>;
} {
  const compiled: CompiledRule[] = [];
  const errors: Array<{ id: string; error: string }> = [];
  for (const rule of rules) {
    const result = compileRule(rule);
    if (result.compiled) compiled.push(result.compiled);
    else errors.push({ id: rule.id, error: result.error ?? 'unknown' });
  }
  return { compiled, errors };
}
