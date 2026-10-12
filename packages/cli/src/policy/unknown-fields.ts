import { PolicyRuleSchema, PolicySchema } from '@stroq/core';
import { quotePath } from '../install/safe-path.js';
import type { UnknownField } from './findings.js';

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
  // Loops, not `push(...many)`: a spread of a hundred thousand keys is more arguments than a call takes.
  rules.forEach((rule: unknown, index) => {
    for (const path of unknownIn(rule, RULE_KEYS, `rules.${index}.`)) found.push(path);
    if (!isRecord(rule)) return;
    for (const path of unknownIn(rule['when'], WHEN_KEYS, `rules.${index}.when.`)) found.push(path);
  });
  return found;
}

/** The paths as findings: a warning each, because what the key was meant to say is not said. */
export function unknownFieldFindings(paths: readonly string[]): readonly UnknownField[] {
  return paths.map((path) => ({
    kind: 'unknown-field',
    severity: 'warning',
    path,
    message: `${quotePath(path)} is not a field Stroq reads, so it is ignored and what it was meant to say is not said`,
    fix: 'correct the spelling of the field, or delete it',
  }));
}
