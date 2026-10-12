import { DEFAULT_POLICY, type Policy } from '@stroq/core';
import type { HighThreshold, LooseDefault } from './findings.js';

/**
 * How far above the built-in threshold a policy's may be before it is called high. The threshold is
 * the score a tool result must reach to be flagged and to taint the session, so a higher one flags
 * less. The margin is a judgement, not a measurement: a step of a tenth reads as tuning, a step of a
 * fifth (0.8 against the default 0.6) is large enough that whoever took it should have measured
 * what it lets through, and a note that says so costs a reader one line.
 */
const THRESHOLD_MARGIN = 0.2;

/** Floating point: `0.8 - 0.6` is `0.2000000000000001`, and `0.9 - 0.7` is `0.2000000000000000`. */
const EPSILON = 1e-9;

/**
 * `default: allow`: an action no rule names is allowed, whatever it is. The built-in policy does the
 * same, so this is a note (it does not make `policy check` fail), but it is the first thing to look
 * at in a policy that is meant to be an allow-list.
 */
export function looseDefault(policy: Policy): readonly LooseDefault[] {
  if (policy.default !== 'allow') return [];
  return [
    {
      kind: 'loose-default',
      severity: 'info',
      message:
        'default is allow: an action that no rule names is allowed, whatever it is (the built-in policy does the same)',
      fix: 'set default: ask to be asked about what no rule names, and add rules for what you allow',
    },
  ];
}

/** A threshold far above the built-in one, which leaves most injected text unflagged. */
export function highThreshold(policy: Policy): readonly HighThreshold[] {
  const baseline = DEFAULT_POLICY.threshold;
  if (policy.threshold - baseline < THRESHOLD_MARGIN - EPSILON) return [];
  return [
    {
      kind: 'high-threshold',
      severity: 'warning',
      threshold: policy.threshold,
      baseline,
      message:
        `threshold is ${policy.threshold}, the default policy's is ${baseline}: a tool result must score ` +
        `${policy.threshold} before it is flagged and taints the session, so less of what is injected is caught`,
      fix: `set threshold: ${baseline} (or lower), or run stroq policy test on this file to see what ${policy.threshold} lets through`,
    },
  ];
}
