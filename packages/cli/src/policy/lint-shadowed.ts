import { evaluatePolicy, type ActionClass, type Policy, type TaintLevel } from '@stroq/core';
import { quotePath } from '../install/safe-path.js';
import type { RuleRef, ShadowedRule } from './findings.js';

type Rule = Policy['rules'][number];

/**
 * The states of a session the evaluator is ever asked about: clean (`null`) or tainted. A rule
 * decides an action by the classes the action has and by this, so these are all the ways one can
 * reach it.
 */
const TAINT_STATES: readonly (TaintLevel | null)[] = [null, 'suspect'];

/**
 * Whether `rule`, on its own, decides an action of the single class `cls` in a session of the given
 * taint. It asks the real evaluator, with this rule as the only rule, so that what counts as a match
 * can never drift from what the hook does.
 */
function decides(rule: Rule, cls: ActionClass, taint: TaintLevel | null): boolean {
  const alone: Policy = { version: 1, threshold: 0, default: 'allow', rules: [rule] };
  return evaluatePolicy(alone, [cls], taint).ruleId !== null;
}

/** A class and a taint state, as one key. */
const stateKey = (cls: ActionClass, taint: TaintLevel | null): string => `${cls}|${taint ?? ''}`;

/** The (class, taint) states in which `rule` would be the first match if nothing stood before it. */
function statesOf(rule: Rule): readonly { cls: ActionClass; taint: TaintLevel | null }[] {
  const states: { cls: ActionClass; taint: TaintLevel | null }[] = [];
  for (const cls of new Set(rule.when.classes)) {
    for (const taint of TAINT_STATES) if (decides(rule, cls, taint)) states.push({ cls, taint });
  }
  return states;
}

function shadowedMessage(rule: RuleRef, effect: Rule['effect'], by: readonly RefAndEffect[]): string {
  const hidden = by.map((b) => `${b.position} ${quotePath(b.id)} (${b.effect})`).join(', ');
  const plural = by.length === 1 ? 'rule' : 'rules';
  return (
    `rule ${rule.position} ${quotePath(rule.id)} (${effect}) never decides anything: ` +
    `${plural} ${hidden} before it already decide${by.length === 1 ? 's' : ''} every action it would match`
  );
}

interface RefAndEffect extends RuleRef {
  readonly effect: Rule['effect'];
}

/**
 * Rules that can never be the first match.
 *
 * A rule matches an action when any one of its classes is among the action's classes and its taint
 * condition holds (`ruleMatches` in core). An action can have just one class, so a later rule is
 * shadowed exactly when, for every class it names and every taint state it matches, some earlier
 * rule matches that class in that state: then no action the later rule matches reaches it. That is
 * the whole test, and it is exact: it has no false positive, and it does not guess about partial
 * overlap. A rule that is hidden in some states and decides in others is not reported.
 *
 * One pass in rule order, keeping for each state the first rule that matched it: linear in the
 * number of rules (times the 20 classes and 2 taint states), whatever the file holds.
 */
export function shadowedRules(policy: Policy): readonly ShadowedRule[] {
  const owners = new Map<string, RefAndEffect>();
  const found: ShadowedRule[] = [];
  policy.rules.forEach((rule, index) => {
    const states = statesOf(rule);
    const ref: RefAndEffect = { position: index + 1, id: rule.id, effect: rule.effect };
    const covering = states.map((s) => owners.get(stateKey(s.cls, s.taint)));
    const hidden = states.length > 0 && covering.every((owner) => owner !== undefined);
    if (hidden) {
      const by = [
        ...new Map(covering.flatMap((o) => (o === undefined ? [] : [[o.position, o] as const]))),
      ]
        .map(([, owner]) => owner)
        .sort((a, b) => a.position - b.position);
      found.push({
        kind: 'shadowed-rule',
        severity: 'warning',
        rule: { position: ref.position, id: ref.id },
        shadowedBy: by.map(({ position, id }) => ({ position, id })),
        message: shadowedMessage(ref, rule.effect, by),
        fix: `move rule ${ref.position} above rule ${by[0]?.position ?? 1}, or delete it`,
      });
    }
    states.forEach((s) => {
      const key = stateKey(s.cls, s.taint);
      if (!owners.has(key)) owners.set(key, ref);
    });
  });
  return found;
}
