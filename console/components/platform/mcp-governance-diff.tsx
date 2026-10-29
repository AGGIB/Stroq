'use client';
import { AgentGlyph } from '@/components/platform-ui';
import type {
  McpGovernanceChannel,
  McpGovernancePairSummary,
  McpGovernanceRestoreDiff,
} from '@/lib/mcp-governance';
export const GOVERNANCE_CHANNEL_LABELS: Record<McpGovernanceChannel, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex CLI',
  cursor: 'Cursor',
  windsurf: 'Windsurf',
  'mcp-proxy': 'Stroq proxy',
};
export function McpGovernanceIdentity({ pair }: { pair: McpGovernancePairSummary }) {
  return (
    <span className="mcp-governance-identity">
      {pair.channel !== 'mcp-proxy' && (
        <AgentGlyph name={GOVERNANCE_CHANNEL_LABELS[pair.channel]} />
      )}
      <strong>{pair.label}</strong>
      <span>{GOVERNANCE_CHANNEL_LABELS[pair.channel]}</span>
      {pair.redacted && <span>Masked identity · {pair.identitySha256.slice(0, 8)}</span>}
    </span>
  );
}
export function McpGovernanceDiffPanel({
  value,
  restore = false,
}: {
  value: McpGovernanceRestoreDiff;
  restore?: boolean;
}) {
  const { current, candidate, diff } = value;
  const label = (v: typeof current) =>
    v.gate === 'enforced'
      ? `v2 · ${v.allowed.length} listed`
      : v.gate === 'absent'
        ? `v${v.policyVersion ?? 1} · MCP gate absent`
        : 'MCP gate unavailable';
  return (
    <section className="mcp-governance-diff" aria-label="MCP gate changes">
      <div className="mcp-governance-heading">
        <h3>MCP gate</h3>
        <span className="control-meta">
          {label(current)} → {label(candidate)}
        </span>
      </div>
      {restore && (
        <p className="control-meta">
          This restores the whole policy, including all rules and this MCP gate.
        </p>
      )}
      {candidate.gate === 'absent' && current.gate === 'enforced' && (
        <p className="control-error">
          The candidate removes the MCP gate. Unlisted MCP identities will no longer be denied by
          this gate.
        </p>
      )}
      <div className="mcp-governance-diff-counts">
        <span>{diff.added.length} added</span>
        <span>{diff.removed.length} removed</span>
        <span>{diff.retained.length} retained</span>
      </div>
      <details className="mcp-governance-evidence">
        <summary>Identity changes</summary>
        {(['added', 'removed', 'retained'] as const).map(
          (kind) =>
            diff[kind].length > 0 && (
              <div key={kind}>
                <h4>{kind.charAt(0).toUpperCase() + kind.slice(1)}</h4>
                <ul>
                  {diff[kind].map((pair) => (
                    <li key={`${pair.channel}:${pair.identitySha256}`}>
                      <McpGovernanceIdentity pair={pair} />
                      <code>{pair.identitySha256}</code>
                    </li>
                  ))}
                </ul>
              </div>
            ),
        )}
        <p className="control-meta">
          Identity labels do not pin a server, endpoint or registration. Other policy checks still
          apply to listed identities.
        </p>
      </details>
    </section>
  );
}
