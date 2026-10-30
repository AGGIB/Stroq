'use client';
import { Badge } from '@/components/platform-ui';
import { MCP_GOVERNANCE_ERROR_MESSAGES } from '@/lib/mcp-governance-client';
import type { McpGovernanceAction } from './use-mcp-governance';
import { McpGovernanceGaps } from './mcp-governance-gaps';
export function McpGovernanceBlock({
  action,
  onManage,
}: {
  action: McpGovernanceAction;
  onManage: () => void;
}) {
  const current = action.capture?.current ?? action.state?.current,
    already = current?.gate === 'enforced' && current.allowed.length === 0;
  return (
    <section className="mcp-governance-select" aria-label="Block MCP calls">
      {already && (
        <div className="mcp-governance-heading">
          <Badge tone="muted">Already declared</Badge>
        </div>
      )}
      <p>Deny governed MCP tool calls through updated Stroq hooks and proxies.</p>
      <p className="control-meta">
        All workspaces using this Stroq home. Servers and in-flight calls continue.
      </p>
      {already ? (
        <p className="control-meta">
          The current declared policy lists no MCP identities. This does not establish what a
          running agent or proxy has loaded.
        </p>
      ) : (
        current && (
          <p className="control-meta">
            {current.gate === 'enforced'
              ? `${current.allowed.length} identities currently listed · preview removes every allowance.`
              : current.gate === 'absent'
                ? 'Current declared policy has no MCP gate. Preview adds a v2 deny-all gate.'
                : 'Current policy could not be verified.'}
          </p>
        )
      )}
      {action.capture?.reason && (
        <p className="control-error" role="alert">
          {MCP_GOVERNANCE_ERROR_MESSAGES[action.capture.reason]}
        </p>
      )}
      <div className="mcp-governance-actions">
        <button
          className="button primary"
          disabled={already || !!action.busy || !action.connected || !action.state?.editable}
          onClick={() => void action.prepareDenyAll()}
        >
          {action.busy === 'capture'
            ? 'Inspecting configured servers…'
            : action.busy === 'preview'
              ? 'Testing candidate…'
              : 'Preview block MCP calls'}
        </button>
        <button
          className="inline-link"
          disabled={!!action.busy || !action.connected}
          onClick={() => void action.refresh()}
        >
          Reload declaration
        </button>
      </div>
      <p className="control-meta">
        Preview checks the exact candidate without starting a server or using a model. Apply
        requires separate review and consent.
      </p>
      {action.capture && <McpGovernanceGaps gaps={action.capture.gaps} />}
      <details className="mcp-governance-evidence">
        <summary>Scope & recovery</summary>
        <p className="control-meta">
          Only MCP calls reaching this updated hook or proxy boundary are covered. Already
          dispatched calls, other routes and current host adoption remain unverified. Older runtimes
          reject policy v2; existing proxies need restart.
        </p>
        <p className="control-meta">
          A later allowance needs a fresh inspected preview. Whole-policy Restore is available
          separately in history; it restores every policy rule.
        </p>
      </details>
      <button className="inline-link" disabled={!!action.busy} onClick={onManage}>
        Manage listed identities
      </button>
    </section>
  );
}
