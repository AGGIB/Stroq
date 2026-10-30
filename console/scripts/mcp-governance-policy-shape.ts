import type { Policy } from '../../packages/core/src/policy/policy-types.js';
import type { McpGovernanceCurrent, McpGovernanceRestoreDiff } from '../lib/mcp-governance-types';
import {
  governanceHash,
  governancePairSummary,
  type GovernancePair,
} from './mcp-governance-capture-policy';

export function governanceAllowed(policy: Policy): GovernancePair[] {
  return policy.version === 2 ? policy.mcpGovernance.allowed : [];
}
export function governanceCurrent(policy: Policy): McpGovernanceCurrent {
  return {
    policyVersion: policy.version,
    gate: policy.version === 2 ? 'enforced' : 'absent',
    allowed: governanceAllowed(policy).map(governancePairSummary),
  };
}
export function governanceDiff(
  before: readonly GovernancePair[],
  after: readonly GovernancePair[],
) {
  const previous = new Set(before.map(governanceHash)),
    next = new Set(after.map(governanceHash));
  return {
    added: after.filter((p) => !previous.has(governanceHash(p))).map(governancePairSummary),
    removed: before.filter((p) => !next.has(governanceHash(p))).map(governancePairSummary),
    retained: after.filter((p) => previous.has(governanceHash(p))).map(governancePairSummary),
  };
}
export function mcpGovernanceRestoreDiff(before: Policy, after: Policy): McpGovernanceRestoreDiff {
  return {
    current: governanceCurrent(before),
    candidate: governanceCurrent(after),
    diff: governanceDiff(governanceAllowed(before), governanceAllowed(after)),
    selectedEffect: 'continue-existing-checks',
    registrationPinned: false,
    hostEnforcement: false,
  };
}
/** Comparison fixtures keep every existing action rule; only the prerequisite is absent. */
export function withoutGovernance(policy: Policy): Policy {
  return {
    version: 1,
    default: policy.default,
    threshold: policy.threshold,
    rules: policy.rules,
  };
}
