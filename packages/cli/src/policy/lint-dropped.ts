import {
  ACTION_CLASSES,
  DEFAULT_POLICY,
  evaluatePolicy,
  type ActionClass,
  type Decision,
  type Effect,
  type Policy,
  type TaintLevel,
} from '@stroq/core';
import { quotePath } from '../install/safe-path.js';
import type { DroppedProtection, Held, Situation } from './findings.js';

/** How much an effect stops: an action that is allowed is stopped by nothing. */
const STRICTNESS: Readonly<Record<Effect, number>> = { allow: 0, ask: 1, deny: 2 };

/** The states of a session a class can be met in, as the evaluator is asked about them. */
const STATES: readonly { readonly name: 'none' | 'suspect'; readonly taint: TaintLevel | null }[] =
  [
    { name: 'none', taint: null },
    { name: 'suspect', taint: 'suspect' },
  ];

const held = (decision: Decision): Held => ({ effect: decision.effect, ruleId: decision.ruleId });

const sameHeld = (a: Held, b: Held): boolean => a.effect === b.effect && a.ruleId === b.ruleId;

const VERB: Readonly<Record<Effect, string>> = {
  deny: 'denies',
  ask: 'asks about',
  allow: 'allows',
};

const WHEN: Readonly<Record<Situation, string>> = {
  any: '',
  none: ' in a clean session',
  suspect: ' in a tainted session',
};

/** Who decided, in words: a rule by its id, or the policy's own default when no rule matched. */
function decidedBy(who: Held, defaultEffect: Effect): string {
  return who.ruleId === null
    ? `no rule matches, so default: ${defaultEffect}`
    : `rule ${quotePath(who.ruleId)}`;
}

/** The first line of a finding; the ids it names are shown in neutralized form. */
function messageOf(
  cls: ActionClass,
  taint: Situation,
  protection: Held,
  policy: Held,
  candidate: Policy,
): string {
  return (
    `${cls}${WHEN[taint]}: the default policy ${VERB[protection.effect]} it ` +
    `(${decidedBy(protection, DEFAULT_POLICY.default)}); this policy ${VERB[policy.effect]} it ` +
    `(${decidedBy(policy, candidate.default)})`
  );
}

function findingOf(
  cls: ActionClass,
  taint: Situation,
  protection: Held,
  policy: Held,
  candidate: Policy,
): DroppedProtection {
  const named = protection.ruleId === null ? '' : ` ${quotePath(protection.ruleId)}`;
  return {
    kind: 'dropped-protection',
    // Losing a deny altogether is the case the default policy exists to prevent; the rest is a loosening.
    severity: protection.effect === 'deny' && policy.effect === 'allow' ? 'error' : 'warning',
    class: cls,
    taint,
    protection,
    policy,
    message: messageOf(cls, taint, protection, policy, candidate),
    fix: `restore the default policy's rule${named}, above the rule that decides ${cls}`,
  };
}

/**
 * Each class the built-in default policy stops (denies, or asks about) that this policy stops less.
 *
 * "Stops" is judged by the evaluator, for the class on its own, in a clean session and in a tainted
 * one, under both policies: so a protection kept under another rule id, or by one rule for several
 * classes, is not reported, and one lost to a rule placed above it, or to a softer effect, or to a
 * `default` that is looser, is. The comparison is of effects (deny stops more than ask, ask more
 * than allow), never of ids. When a clean and a tainted session lose the very same thing the class
 * is reported once, for any taint.
 */
export function droppedProtections(policy: Policy): readonly DroppedProtection[] {
  const found: DroppedProtection[] = [];
  // Exercise the class rules for a representative permitted label, never credit the
  // class-only missing-identity refusal as evidence that allowed-server checks remain.
  // Every listed pair reaches the same class rules; an empty list denies all MCP calls.
  const allowed = policy.version === 2 ? policy.mcpGovernance.allowed[0] : undefined;
  const context =
    allowed === undefined ? undefined : { mcpIdentity: { kind: 'server' as const, ...allowed } };
  for (const cls of ACTION_CLASSES) {
    const lost = STATES.flatMap((state) => {
      const protection = held(evaluatePolicy(DEFAULT_POLICY, [cls], state.taint));
      const mine = held(
        evaluatePolicy(policy, [cls], state.taint, cls.startsWith('mcp.') ? context : undefined),
      );
      return STRICTNESS[mine.effect] < STRICTNESS[protection.effect]
        ? [{ name: state.name, protection, mine }]
        : [];
    });
    const [first, second] = lost;
    if (first !== undefined && second !== undefined && lost.length === STATES.length) {
      if (sameHeld(first.protection, second.protection) && sameHeld(first.mine, second.mine)) {
        found.push(findingOf(cls, 'any', first.protection, first.mine, policy));
        continue;
      }
    }
    for (const state of lost) {
      found.push(findingOf(cls, state.name, state.protection, state.mine, policy));
    }
  }
  return found;
}
