import type { ActionClass, Effect } from '@stroq/core';

/**
 * What `stroq policy check` tells a person about a policy file, one finding at a time.
 *
 * - `error`: the policy does not do what the default one guarantees, or does not load.
 * - `warning`: it loads and probably does not do what its author meant.
 * - `info`: true and worth knowing, but the same is true of the built-in policy.
 *
 * Only an error or a warning makes the command exit 1 (`needsAttention`).
 */
export type Severity = 'error' | 'warning' | 'info';

/** A rule, told by where it stands in the list: ids are free text and two rules may share one. */
export interface RuleRef {
  /** 1 for the first rule. */
  readonly position: number;
  readonly id: string;
}

/** Who decided: a rule, or `null` when none matched and the policy's `default` did. */
export interface Held {
  readonly effect: Effect;
  readonly ruleId: string | null;
}

/** The taint of a session a finding is about: both states, a clean session, or a tainted one. */
export type Situation = 'any' | 'none' | 'suspect';

interface Base {
  readonly severity: Severity;
  /** One line, plain words. Anything taken from the file is shown in neutralized form. */
  readonly message: string;
  /** One line: what to change. */
  readonly fix: string;
}

export interface ShadowedRule extends Base {
  readonly kind: 'shadowed-rule';
  readonly rule: RuleRef;
  /** The earlier rules that between them decide everything this rule would match. */
  readonly shadowedBy: readonly RuleRef[];
}

export interface DroppedProtection extends Base {
  readonly kind: 'dropped-protection';
  readonly class: ActionClass;
  readonly taint: Situation;
  /** What the built-in default policy does with the class on its own. */
  readonly protection: Held;
  /** What this policy does with it. */
  readonly policy: Held;
}

export interface LooseDefault extends Base {
  readonly kind: 'loose-default';
}

export interface HighThreshold extends Base {
  readonly kind: 'high-threshold';
  readonly threshold: number;
  /** The built-in policy's threshold. */
  readonly baseline: number;
}

/** A key the policy file has that Stroq does not read, so that whatever it was meant to say is not said. */
export interface UnknownField extends Base {
  readonly kind: 'unknown-field';
  /** Dotted path of the key, as the schema faults write paths. */
  readonly path: string;
}

export type Finding =
  ShadowedRule | DroppedProtection | LooseDefault | HighThreshold | UnknownField;

export type FindingKind = Finding['kind'];
