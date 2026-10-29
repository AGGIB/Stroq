'use client';
import { useEffect, useRef } from 'react';
import type { McpGovernanceAction } from './use-mcp-governance';
import type { McpGovernanceAcknowledgements } from '@/lib/mcp-governance-client';
import { McpGovernanceDiffPanel } from './mcp-governance-diff';
import { McpGovernanceGaps } from './mcp-governance-gaps';
const CASES = {
  'listed-continues': 'Listed identity continues',
  'unlisted-denied': 'Unlisted identity denied',
  'unknown-denied': 'Unknown identity denied',
  'non-mcp-unchanged': 'Non-MCP decision unchanged',
} as const;
export function McpGovernanceReview({ action }: { action: McpGovernanceAction }) {
  const p = action.preview,
    heading = useRef<HTMLHeadingElement | null>(null),
    focused = useRef<string | null>(null);
  useEffect(() => {
    if (!p || action.busy || focused.current === p.id || !heading.current) return;
    focused.current = p.id;
    heading.current.focus({ preventScroll: true });
    heading.current.scrollIntoView({ block: 'center', behavior: 'auto' });
  }, [p?.id, action.busy]);
  if (!p) return null;
  const consent = (name: keyof McpGovernanceAcknowledgements, text: string) => (
    <label className="mcp-governance-consent">
      <input
        type="checkbox"
        checked={action.ack[name]}
        disabled={!!action.busy}
        onChange={(e) => action.acknowledge(name, e.target.checked)}
      />
      <span>{text}</span>
    </label>
  );
  return (
    <section className="mcp-governance-review" aria-label="MCP policy preview">
      <div className="mcp-governance-heading">
        <h3 ref={heading} tabIndex={-1}>
          Review MCP policy
        </h3>
        <span className="control-meta">Preview expires in 2 minutes</span>
      </div>
      <p>
        Unlisted and unknown identities are denied. Other policy checks still apply to listed calls.
      </p>
      {p.selected.length === 0 && (
        <p className="control-meta">
          This candidate lists no identities: all governed MCP calls will be denied.
        </p>
      )}
      {action.capture?.captureId === p.captureId && (
        <McpGovernanceGaps gaps={action.capture.gaps} />
      )}
      <McpGovernanceDiffPanel
        value={{
          current: p.current,
          candidate: {
            policyVersion: 2,
            gate: 'enforced',
            allowed: [...p.diff.added, ...p.diff.retained],
          },
          diff: p.diff,
          selectedEffect: p.selectedEffect,
          registrationPinned: false,
          hostEnforcement: false,
        }}
      />
      <div className="mcp-governance-checks" aria-label="Candidate check results">
        <span>Core fixtures: {p.gateChecks.passed ? 'Passed' : 'Needs attention'}</span>
        <span>Attack scenarios allowed: {p.simulation.attacksPassing}</span>
        <span>New interruptions: {p.simulation.newInterruptions}</span>
        <span>
          Saved checks: {p.regressions.passed}/{p.regressions.total}
        </span>
      </div>
      <details className="mcp-governance-evidence">
        <summary>Test scope and binding</summary>
        <ul>
          {p.gateChecks.cases.map((c) => (
            <li key={c.id}>
              {CASES[c.id]} ·{' '}
              {c.status === 'not-applicable' ? 'Not applicable: empty list' : c.status}
            </li>
          ))}
        </ul>
        <p className="control-meta">
          Model-free core fixtures and policy simulation. These do not prove native host adoption or
          a live server’s identity.
        </p>
        <span className="control-meta">Candidate policy</span>
        <code>{p.candidateRawSha256}</code>
        <span className="control-meta">Runtime</span>
        <code>{p.binding.runtimeSha256}</code>
      </details>
      {p.blockers.length > 0 && (
        <p className="control-error" role="alert">
          Candidate blocked · {p.blockers.map((b) => b.replaceAll('-', ' ')).join(', ')}
        </p>
      )}
      <p className="control-meta">
        Existing proxies need restart; existing tasks retain their launch policy. Host adoption
        remains unverified.
      </p>
      <div className="mcp-governance-consents">
        {consent(
          'scope',
          'This replaces the MCP list for every workspace using this Stroq home. Older runtimes reject policy v2.',
        )}
        {consent(
          'retention',
          'Stroq retains unencrypted policy copies for recovery. These may contain private rules or names.',
        )}
        {action.pending.length > 0 && (
          <>
            <p className="control-error">
              {action.pending.length} earlier browser operations remain unknown, including any
              absent from saved history.
            </p>
            {consent(
              'pendingReview',
              'I reviewed those unknown outcomes. This independent change does not retry or confirm them.',
            )}
          </>
        )}
        {p.requiresWeakening &&
          consent(
            'weakening',
            'New allowances pass this MCP gate; this relaxes the existing v2 list. Other checks still apply.',
          )}
        {p.requiresInterruptions &&
          consent(
            'interruptions',
            'I reviewed removed identities and new interruptions; ordinary MCP calls may be denied.',
          )}
        {p.requiresRecoveryReview && (
          <>
            <p className="control-error">
              {p.unconfirmedRecords.length} earlier operations remain unconfirmed. This is a fresh
              policy change, not a retry or proof of earlier completion.
            </p>
            {consent(
              'recovery',
              'I reviewed those unconfirmed operations and accept an independent replacement of the current policy.',
            )}
          </>
        )}
      </div>
      <div className="mcp-governance-actions">
        <button
          className="button primary"
          disabled={!action.canApply}
          onClick={() => void action.apply()}
        >
          Apply MCP policy
        </button>
        <button className="button" disabled={!!action.busy} onClick={action.clearPreview}>
          Back to draft
        </button>
      </div>
    </section>
  );
}
