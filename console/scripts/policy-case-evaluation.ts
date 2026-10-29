import { evaluatePolicy } from '../../packages/core/src/policy/evaluate.js';
import type { Policy } from '../../packages/core/src/policy/policy-types.js';
import { policySha256 } from '../../packages/cli/src/policy/digest.js';
import { MAX_POLICY_CASES, validatePolicyCase, type PolicyCase } from '../lib/policy-cases';

/** Deliberately evaluates classes, not reconstructed commands or the original session. */
export function evaluatePolicyCases(policy: Policy, records: unknown) {
  if (
    !Array.isArray(records) ||
    records.length > MAX_POLICY_CASES ||
    !Array.from(records).every(validatePolicyCase) ||
    new Set(records.map((row) => row.id)).size !== records.length ||
    new Set(records.map((row) => JSON.stringify(row.classes))).size !== records.length
  )
    throw new Error('invalid-request');
  const results = (records as PolicyCase[]).map((record) => {
    const scenarios = record.expected.map((row) => ({
      taint: row.taint,
      expected: row.effect,
      actual: evaluatePolicy(policy, record.classes, row.taint === 'none' ? null : 'suspect')
        .effect,
    }));
    return {
      caseId: record.id,
      passed: scenarios.every((row) => row.expected === row.actual),
      scenarios,
    };
  });
  const passed = results.filter((row) => row.passed).length;
  return {
    policyFingerprint: policySha256(policy),
    total: results.length,
    passed,
    failed: results.length - passed,
    results,
  };
}
