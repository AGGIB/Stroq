'use client';
import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { Badge } from '@/components/platform-ui';
import { policyHistoryHref } from '@/lib/policy-history-navigation';
import { mcpGovernanceHref } from '@/lib/mcp-governance-navigation';
import type { McpGovernanceAction } from './use-mcp-governance';
export function McpGovernanceHistory({
  action,
  operationId = null,
}: {
  action: McpGovernanceAction;
  operationId?: string | null;
}) {
  const records = action.state?.records ?? [],
    selected = records.find(
      (r) => r.operationId === operationId && r.binding.contextId === action.state?.contextId,
    ),
    focusKey = selected ? `${selected.binding.contextId}:${selected.operationId}` : null,
    target = useRef<HTMLElement | null>(null),
    focused = useRef<string | null>(null);
  useEffect(() => {
    if (action.busy || !focusKey || focused.current === focusKey || !target.current) return;
    focused.current = focusKey;
    target.current.focus({ preventScroll: true });
    target.current.scrollIntoView({ block: 'center', behavior: 'auto' });
  }, [focusKey, action.busy]);
  const missing = action.pending.filter(
    (w) =>
      !records.some(
        (r) =>
          r.operationId === w.preview.operationId &&
          r.binding.contextId === w.preview.binding.contextId,
      ),
  );
  return (
    <section className="mcp-governance-history" aria-label="MCP policy operation history">
      <div className="mcp-governance-heading">
        <h3>Saved operations</h3>
        <button
          className="inline-link"
          disabled={!!action.busy || !action.connected}
          onClick={() => void action.refresh()}
        >
          Reload history
        </button>
      </div>
      {!action.state || action.state.history === 'unavailable' ? (
        <p className="control-error">Saved operations could not be verified.</p>
      ) : records.length === 0 && missing.length === 0 ? (
        <p className="control-meta">No retained operations.</p>
      ) : null}
      {missing.map((w) => (
        <div
          className="mcp-governance-notice"
          key={`${w.preview.binding.contextId}:${w.preview.operationId}`}
          role="status"
        >
          <strong>Completion unknown</strong>
          <p className="control-meta">
            The exact operation is absent from this read. Absence does not prove that no write
            occurred.
          </p>
          <Link
            className="inline-link"
            href={mcpGovernanceHref({
              contextId: w.preview.binding.contextId,
              workspaceId: w.preview.binding.workspaceId,
              operationId: w.preview.operationId,
            })}
          >
            Open exact operation
          </Link>
        </div>
      ))}
      {[...records]
        .sort((a, b) =>
          a.operationId === operationId
            ? -1
            : b.operationId === operationId
              ? 1
              : b.updatedAt.localeCompare(a.updatedAt),
        )
        .map((r) => {
          const unknown = action.pending.some(
              (w) =>
                w.preview.operationId === r.operationId &&
                w.preview.binding.contextId === r.binding.contextId,
            ),
            status = unknown ? 'unknown' : r.status;
          return (
            <article
              className="mcp-governance-record"
              key={r.id}
              data-governance-operation={r.operationId}
              data-selected={r.operationId === operationId || undefined}
              ref={r.operationId === operationId ? target : undefined}
              tabIndex={r.operationId === operationId ? -1 : undefined}
              aria-label={
                r.operationId === operationId ? 'Selected MCP policy operation' : undefined
              }
            >
              <div className="mcp-governance-heading">
                <strong>
                  {status === 'unknown'
                    ? 'Completion unknown'
                    : status === 'not-applied'
                      ? 'Write did not publish'
                      : 'Policy write recorded'}
                </strong>
                <Badge tone={status === 'unknown' ? 'orange' : 'muted'}>
                  {status === 'applied' ? 'Historical write' : status}
                </Badge>
              </div>
              <p className="control-meta">
                {r.current === 'matches'
                  ? 'Candidate bytes match the latest policy read.'
                  : r.current === 'changed'
                    ? 'The policy changed after this operation.'
                    : 'Current policy correspondence is unavailable.'}{' '}
                Host adoption remains unverified.
              </p>
              <div className="mcp-governance-actions">
                {status === 'unknown' && (
                  <button
                    className="button"
                    disabled={!!action.busy || r.binding.contextId !== action.state?.contextId}
                    onClick={() => void action.recheck(r)}
                  >
                    Recheck exact operation
                  </button>
                )}
                {r.historyRef && (
                  <Link className="button" href={policyHistoryHref(r.historyRef.entryId)}>
                    Preview whole-policy restore
                  </Link>
                )}
              </div>
              <details className="mcp-governance-evidence">
                <summary>Recorded policy evidence</summary>
                <span>Updated {new Date(r.updatedAt).toLocaleString('en-GB')}</span>
                <span>Candidate policy</span>
                <code>{r.candidateRawSha256}</code>
                <span>Operation</span>
                <code>{r.operationId}</code>
                <p className="control-meta">
                  A retained write is separate from current policy correspondence and live hook or
                  proxy adoption.
                </p>
              </details>
            </article>
          );
        })}
      <Link className="inline-link" href={policyHistoryHref()}>
        Whole-policy recovery history
      </Link>
    </section>
  );
}
