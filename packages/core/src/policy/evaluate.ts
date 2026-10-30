import type { ActionClass, Decision, TaintLevel } from '../types.js';
import type { Policy, PolicyRule } from './policy-types.js';
import { evaluateMcpGovernance, type McpGovernanceContext } from './mcp-governance.js';

function taintMatches(rule: PolicyRule, taint: TaintLevel | null): boolean {
  if (rule.when.taint === 'any') return true;
  if (rule.when.taint === 'none') return taint === null;
  return taint === rule.when.taint;
}

function ruleMatches(
  rule: PolicyRule,
  classes: readonly ActionClass[],
  taint: TaintLevel | null,
): boolean {
  return (
    rule.when.classes.some((c) => classes.includes(c as ActionClass)) && taintMatches(rule, taint)
  );
}

/** Class-only callers cannot establish an MCP identity; v2 MCP calls then fail closed. */
export function evaluatePolicy(
  policy: Policy,
  classes: readonly ActionClass[],
  taint: TaintLevel | null,
  context?: McpGovernanceContext,
): Decision {
  const governance = evaluateMcpGovernance(policy, classes, context);
  if (governance !== null) return governance;
  const rule = policy.rules.find((r) => ruleMatches(r, classes, taint));
  if (!rule) return { effect: policy.default, ruleId: null, reason: 'default' };
  return { effect: rule.effect, ruleId: rule.id, reason: rule.reason };
}
