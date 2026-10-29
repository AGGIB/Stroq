import { AuditLog, type Decision } from '@stroq/core';
import { mcpToolName } from '../adapters/cursor-mcp-name.js';
import { auditFile, auditFileIn } from '../paths.js';
import type { McpContext } from './judge.js';
import type { McpPolicyContinuity } from './policy-continuity.js';

type Failure = 'changed' | 'unavailable';

/** A connection never regains authority after losing its launch-policy continuity. */
export function policyDispatchGate(continuity: McpPolicyContinuity | undefined) {
  let failure: Failure | null = null;
  return (): Failure | null => {
    if (failure !== null || continuity === undefined) return failure;
    try {
      const state = continuity.check();
      if (state !== 'current') failure = state === 'changed' ? 'changed' : 'unavailable';
    } catch {
      failure = 'unavailable';
    }
    return failure;
  };
}

/** Producer-owned text contains neither a policy path nor policy/server-supplied content. */
export const policyContinuityDecision = (failure: Failure): Decision => ({
  effect: 'deny',
  ruleId: `mcp-policy-${failure}`,
  reason:
    failure === 'changed'
      ? 'The selected MCP policy changed after this proxy started. Restart the proxy to load the current policy, then explicitly retry.'
      : 'The selected MCP policy can no longer be verified. Restore a readable valid policy. Restart the proxy, then explicitly retry.',
});

/** A continuity refusal records no raw arguments, policy text, or filesystem diagnostics. */
export async function auditPolicyContinuityRefusal(
  ctx: McpContext,
  failure: Failure,
  home?: string,
): Promise<void> {
  try {
    await new AuditLog(home === undefined ? auditFile() : auditFileIn(home)).append({
      sessionId: ctx.sessionId,
      phase: 'pre',
      tool: mcpToolName(ctx.server, 'policy_continuity'),
      summary: 'mcp proxy: withheld a tool call because launch-policy continuity was lost',
      decision: policyContinuityDecision(failure),
    });
  } catch {
    // Audit failure cannot grant dispatch or replace the fixed client refusal.
  }
}
