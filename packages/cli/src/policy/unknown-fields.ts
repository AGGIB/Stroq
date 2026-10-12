import { PolicyRuleSchema, PolicySchema } from '@stroq/core';

/**
 * The keys a policy file has that Stroq does not read.
 *
 * The schema ignores a key it does not know, so `taintt: suspect` on a rule is not an error: the rule
 * simply gets the default `taint: any`, and says something other than its author wrote. A policy that
 * loads cleanly can therefore still be wrong in a way only the raw document shows. The known keys are
 * read from the schema itself, so a field added to it is known here the day it is added.
 *
 * Paths are dotted, like the paths of schema faults (`rules.2.when.taintt`).
 */

const TOP_KEYS = new Set(Object.keys(PolicySchema.shape));
const RULE_KEYS = new Set(Object.keys(PolicyRuleSchema.shape));
const WHEN_KEYS = new Set(Object.keys(PolicyRuleSchema.shape.when.shape));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const unknownIn = (value: unknown, known: ReadonlySet<string>, prefix: string): string[] =>
  isRecord(value)
    ? Object.keys(value)
        .filter((key) => !known.has(key))
        .map((key) => `${prefix}${key}`)
    : [];

export function unknownFieldPaths(document: unknown): readonly string[] {
  if (!isRecord(document)) return [];
  const found = unknownIn(document, TOP_KEYS, '');
  const rules = document['rules'];
  if (!Array.isArray(rules)) return found;
  rules.forEach((rule: unknown, index) => {
    found.push(...unknownIn(rule, RULE_KEYS, `rules.${index}.`));
    if (isRecord(rule)) {
      found.push(...unknownIn(rule['when'], WHEN_KEYS, `rules.${index}.when.`));
    }
  });
  return found;
}
