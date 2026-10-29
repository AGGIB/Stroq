import { isSeq, type Document } from 'yaml';
import { ACTION_CLASSES, type ActionClass } from '../../packages/core/src/types.js';
import { evaluatePolicy } from '../../packages/core/src/policy/evaluate.js';
import type { Policy, PolicyRule } from '../../packages/core/src/policy/policy-types.js';

export interface ActionControl {
  classes: ActionClass[];
  removedRules: number;
  narrowedRules: number;
  taint: 'any';
  scope: 'stroq-home';
  hostEnforcement: false;
}

export function validActionClasses(value: unknown): value is ActionClass[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= ACTION_CLASSES.length &&
    new Set(value).size === value.length &&
    Array.from(value).every((item) => ACTION_CLASSES.includes(item))
  );
}

/**
 * First-match OR predicates make pairs sufficient: any earlier non-deny rule that
 * could win for a larger combination is witnessed by one of its classes plus cls.
 */
export function newActionDenials(policy: Policy, requested: ActionClass[]): ActionClass[] {
  return requested
    .filter(
      (cls) =>
        ![null, 'suspect' as const].every((taint) =>
          ACTION_CLASSES.every(
            (companion) => evaluatePolicy(policy, [cls, companion], taint).effect === 'deny',
          ),
        ),
    )
    .sort();
}

function generatedRule(policy: Policy, classes: ActionClass[]): PolicyRule {
  const ids = new Set(policy.rules.map((rule) => rule.id));
  const base = 'stroq-console-deny-actions';
  let id = base;
  for (let suffix = 2; ids.has(id); suffix += 1) id = `${base}-${suffix}`;
  return {
    id,
    effect: 'deny',
    reason: 'Action class denied by the local Stroq policy.',
    when: { classes, taint: 'any' },
  };
}

/** Preserve every decision for class combinations that do not contain a selected class. */
export function applyActionDenials(document: Document, policy: Policy, classes: ActionClass[]) {
  if (classes.length === 0) return { policy, actionControl: null };
  const selected = new Set(classes);
  let removedRules = 0;
  let narrowedRules = 0;
  const retained: PolicyRule[] = [];
  for (let index = policy.rules.length - 1; index >= 0; index -= 1) {
    const rule = policy.rules[index]!;
    const remaining = rule.when.classes.filter((cls) => !selected.has(cls));
    if (remaining.length === 0) {
      document.deleteIn(['rules', index]);
      removedRules += 1;
      continue;
    }
    if (remaining.length !== rule.when.classes.length) {
      // Delete individual class nodes so comments on surviving nodes are retained.
      for (let ci = rule.when.classes.length - 1; ci >= 0; ci -= 1) {
        if (selected.has(rule.when.classes[ci]!))
          document.deleteIn(['rules', index, 'when', 'classes', ci]);
      }
      narrowedRules += 1;
    }
    retained.unshift({ ...rule, when: { ...rule.when, classes: remaining } });
  }
  const rules = document.get('rules', true);
  if (!isSeq(rules)) throw new Error('policy-invalid');
  const first = generatedRule(policy, classes);
  rules.items.unshift(document.createNode(first));
  const actionControl: ActionControl = {
    classes,
    removedRules,
    narrowedRules,
    taint: 'any',
    scope: 'stroq-home',
    hostEnforcement: false,
  };
  return { policy: { ...policy, rules: [first, ...retained] }, actionControl };
}
