import { AuditLog, type Decision } from '@stroq/core';
import { mcpToolName } from '../adapters/cursor-mcp-name.js';
import { auditFile, auditFileIn } from '../paths.js';
import type { McpContext } from './judge.js';
import type { McpCallControlAudit } from './call-control-types.js';

export const callControlDecision = (reason: McpCallControlAudit['reason']): Decision => ({
  effect: 'deny',
  ruleId: `mcp-call-control-${reason}`,
  reason:
    reason === 'paused'
      ? 'This MCP connection is paused in Stroq. Resume its exact connection in the local console, then explicitly retry.'
      : reason === 'busy'
        ? 'The MCP call-control authority is busy. Explicitly retry after the current local operation completes.'
        : 'The MCP call-control authority can no longer be verified for this connection. Restore its valid configuration, restart the proxy, then explicitly retry.',
});

/** Fixed text plus finite identifiers; never arguments, environment or filesystem errors. */
export async function auditCallControlRefusal(
  ctx: McpContext,
  evidence: McpCallControlAudit,
  home?: string,
): Promise<void> {
  try {
    await new AuditLog(home === undefined ? auditFile() : auditFileIn(home)).append({
      sessionId: ctx.sessionId,
      phase: 'pre',
      tool: mcpToolName(ctx.server, 'call_control'),
      summary: 'mcp proxy: withheld a new tool call at the native dispatch control',
      decision: callControlDecision(evidence.reason),
      mcpCallControl: evidence,
    });
  } catch {
    /* Losing audit cannot grant dispatch or replace the fixed refusal. */
  }
}

export const callControlInvalidDecision: Decision = {
  effect: 'deny',
  ruleId: 'mcp-call-control-invalid-message',
  reason:
    'Stroq withheld an unreadable or ambiguous MCP client message. Send one valid unambiguous JSON message, then explicitly retry.',
};
export async function auditCallControlInvalidMessage(
  ctx: McpContext,
  home?: string,
): Promise<void> {
  try {
    await new AuditLog(home === undefined ? auditFile() : auditFileIn(home)).append({
      sessionId: ctx.sessionId,
      phase: 'pre',
      tool: mcpToolName(ctx.server, 'call_control'),
      summary: 'mcp proxy: withheld an unreadable or ambiguous controlled client message',
      decision: callControlInvalidDecision,
    });
  } catch {
    /* Audit cannot authorize ambiguous dispatch. */
  }
}
