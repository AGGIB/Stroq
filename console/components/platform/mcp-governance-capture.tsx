'use client';
import type { McpGovernanceAction } from './use-mcp-governance';
import { McpGovernanceIdentity } from './mcp-governance-diff';
import { McpGovernanceGaps } from './mcp-governance-gaps';
const REASONS = {
  'unsupported-agent': 'This host does not supply a supported MCP identity.',
  'unsupported-source': 'This registration source is unsupported.',
  'unsupported-name': 'The reported name cannot be represented by this policy.',
  'missing-identity': 'No reported identity is available.',
  'ambiguous-identity': 'The reported identity is ambiguous.',
  'source-unavailable': 'This registration could not be inspected.',
  'proxy-unverified': 'The proxy binding could not be verified.',
  'proxy-other-home': 'This proxy uses another Stroq home.',
  'redacted-identity': 'The identity is unavailable for selection.',
} as const;
export function McpGovernanceCapturePanel({ action }: { action: McpGovernanceAction }) {
  const capture = action.capture;
  const current = capture?.current ?? action.state?.current;
  return (
    <section className="mcp-governance-select" aria-label="MCP policy draft">
      <div className="mcp-governance-heading">
        <div>
          <h3>Choose reported identities</h3>
          <p className="control-meta">
            Unlisted and unknown identities will be denied. Listed calls continue through other
            checks.
          </p>
        </div>
        <button
          className="button"
          disabled={!!action.busy || !action.connected || !action.state?.editable}
          onClick={() => void action.inspect()}
        >
          {action.busy === 'capture' ? 'Inspecting…' : 'Inspect configured servers'}
        </button>
      </div>
      {current && (
        <div className="mcp-governance-baseline">
          <span className="control-meta">
            {current.gate === 'enforced'
              ? `Current declared policy · v2 · ${current.allowed.length} listed`
              : current.gate === 'absent'
                ? 'Current declared policy · v1 · MCP gate absent'
                : 'Current policy could not be verified'}
          </span>
          {current.allowed.length > 0 && (
            <details className="mcp-governance-evidence">
              <summary>Current listed identities</summary>
              <ul>
                {current.allowed.map((pair) => (
                  <li key={`${pair.channel}:${pair.identitySha256}`}>
                    <McpGovernanceIdentity pair={pair} />
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
      {!capture ? (
        <p className="control-meta">
          Inspection reads supported registrations without starting their servers.
        </p>
      ) : (
        <>
          <div className="mcp-governance-selection-heading">
            <span>{action.selected.length}/64 listed in this draft</span>
            <span className="control-meta">{capture.current.allowed.length} currently listed</span>
          </div>
          {capture.choices.length ? (
            <div className="mcp-governance-choices">
              {capture.choices.map((choice) => (
                <label key={choice.id} className="mcp-governance-choice">
                  <input
                    type="checkbox"
                    value={choice.id}
                    checked={action.selected.some((s) => s.id === choice.id)}
                    disabled={
                      !!action.busy ||
                      choice.eligibility !== 'eligible' ||
                      (action.selected.length >= 64 &&
                        !action.selected.some((s) => s.id === choice.id))
                    }
                    onChange={(e) => action.selectChoice(choice.id, e.target.checked)}
                  />
                  <span>
                    {choice.pair ? (
                      <McpGovernanceIdentity pair={choice.pair} />
                    ) : (
                      <strong>Unsupported registration</strong>
                    )}
                    <span className="control-meta">
                      {choice.kind === 'retained'
                        ? 'Retained allowance · no captured registration'
                        : choice.pair
                          ? (['project', 'user'] as const)
                              .filter((scope) => choice.sourceRefs.some((r) => r.scope === scope))
                              .map((scope) => (scope === 'project' ? 'Project' : 'User'))
                              .join(' · ')
                          : [...new Set(choice.sourceRefs.map((r) => r.label))].join(' / ')}
                    </span>
                    {choice.reason && (
                      <span className="control-error">{REASONS[choice.reason]}</span>
                    )}
                  </span>
                </label>
              ))}
            </div>
          ) : (
            <p className="control-meta">
              No selectable reported identities were found. An empty list denies all classified MCP
              calls.
            </p>
          )}
          <McpGovernanceGaps gaps={capture.gaps} />
          <div className="mcp-governance-actions">
            <button
              className="button primary"
              disabled={!action.canPrepare}
              onClick={() => void action.prepare()}
            >
              {action.busy === 'preview' ? 'Testing candidate…' : 'Preview MCP policy'}
            </button>
            <span className="control-meta">
              Replaces the full MCP list; other policy rules stay in place.
            </span>
          </div>
        </>
      )}
      <details className="mcp-governance-evidence">
        <summary>What this gate covers</summary>
        <p className="control-meta">
          MCP calls observed by updated Stroq hooks and proxies. Names are reported by that
          boundary; registration presence does not prove server identity or trust.
        </p>
        <p className="control-meta">
          Older runtimes reject policy v2. Existing proxies need restart; existing tasks can retain
          their launch policy. Native adoption is unverified.
        </p>
      </details>
    </section>
  );
}
