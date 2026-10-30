import { snapshotMcpIdentity } from '../mcp/identity.js';
import type { ActionClass, Decision, PreToolEvent } from '../types.js';
import type { Policy } from './policy-types.js';

export type McpGovernanceContext = Pick<PreToolEvent, 'mcpIdentity'>;

/** A malformed present witness still denotes a call; it cannot erase MCP coverage. */
export function isMcpGovernedCall(
  classes: readonly ActionClass[],
  context?: McpGovernanceContext,
): boolean {
  return (
    classes.some((value) => value.startsWith('mcp.')) ||
    (context !== undefined && 'mcpIdentity' in context)
  );
}

/**
 * A deny-only prerequisite for tool calls. A listed reported label grants no action,
 * trust, server startup permission or authentication of the server process.
 */
export function evaluateMcpGovernance(
  policy: Policy,
  classes: readonly ActionClass[],
  context?: McpGovernanceContext,
): Decision | null {
  if (policy.version !== 2 || !isMcpGovernedCall(classes, context)) return null;
  const identity = snapshotMcpIdentity(context?.mcpIdentity);
  if (identity === null || identity.kind !== 'server') {
    return {
      effect: 'deny',
      ruleId: 'mcp-governance-identity-unknown',
      reason:
        'This MCP tool call has no usable reported server identity for the active governance policy.',
    };
  }
  if (
    policy.mcpGovernance.allowed.some(
      (row) => row.channel === identity.channel && row.name === identity.name,
    )
  )
    return null;
  return {
    effect: 'deny',
    ruleId: 'mcp-governance-unlisted',
    reason:
      'This reported MCP server label is not listed for this channel in the active governance policy.',
  };
}
