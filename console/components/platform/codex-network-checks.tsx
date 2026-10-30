'use client';
import { useEffect, useRef } from 'react';
import { Badge } from '@/components/platform-ui';
import { CODEX_NETWORK_ERROR_MESSAGES } from '@/lib/codex-network-client';
import type { CodexNetworkControls } from './use-codex-network-controls';
const PROGRESS = {
  preparing: 'Preparing isolated files',
  positive: 'Checking positive controls',
  native: 'Running native socket canaries',
  cleanup: 'Verifying cleanup',
} as const;
const COPY = {
  profile: 'Permission profile copy',
  'legacy-translated': 'Legacy settings translated to a permission copy',
  'implicit-translated': 'Implicit settings translated to a permission copy',
} as const;
export function CodexNetworkChecks({
  action,
  autoFocus = true,
  focusRequest = null,
}: {
  action: CodexNetworkControls;
  autoFocus?: boolean;
  focusRequest?: { jobId: string; sequence: number } | null;
}) {
  const c = action.checks,
    p = c.preview,
    j = c.job,
    heading = useRef<HTMLHeadingElement | null>(null),
    focusedRequest = useRef<string | null>(null);
  useEffect(() => {
    if (!autoFocus || (!p && !j) || !heading.current) return;
    heading.current.focus({ preventScroll: true });
    const request =
      focusRequest && focusRequest.jobId === j?.id
        ? `${focusRequest.jobId}:${focusRequest.sequence}`
        : null;
    if (request && request !== focusedRequest.current) {
      focusedRequest.current = request;
      heading.current.scrollIntoView({ block: 'center', behavior: 'auto' });
    }
  }, [autoFocus, p?.id, j?.id, focusRequest?.jobId, focusRequest?.sequence]);
  if (!p && !j && !c.pending.length && !c.foreignPending.length) return null;
  return (
    <section className="codex-network-check" aria-label="Native copied-policy check">
      <div className="codex-network-heading">
        <h3 ref={heading} tabIndex={-1}>
          Native profile-copy check
        </h3>
        <Badge tone="muted">Isolated copy</Badge>
      </div>
      <p className="control-meta">
        TCP loopback + Unix socket · no model requests. This tests a copied policy, not a running
        chat or the current workspace loader.
      </p>
      {p && (
        <div className="codex-network-review">
          <strong>{COPY[p.binding.copyKind]}</strong>
          <p className="control-meta">
            Runs fixed local canaries with positive controls. Configuration stays unchanged; a
            derived result is retained locally.
          </p>
          <div className="codex-network-actions">
            <button
              className="button primary"
              disabled={!c.canStart || !!action.busy}
              onClick={() => void c.start()}
            >
              Run check
            </button>
            <button className="button" disabled={!!action.busy} onClick={c.clearPreview}>
              Cancel check preview
            </button>
          </div>
        </div>
      )}
      {c.pending.length > 0 && (
        <div className="codex-network-notice" role="status">
          <strong>Check outcome unconfirmed</strong>
          <p>
            An exact attempt has an unconfirmed outcome. Recheck its history; no earlier request is
            retried.
          </p>
          <button className="button" disabled={!!action.busy} onClick={() => void c.refresh(true)}>
            Recheck exact attempt
          </button>
        </div>
      )}
      {c.foreignPending.length > 0 && (
        <p className="control-meta">
          An unresolved attempt belongs to another workspace or Codex data directory. Reconnect that
          context to recheck.
        </p>
      )}
      {j && (
        <>
          {(j.binding.controlContextId !== action.guard.state?.controlContextId ||
            j.binding.workspaceId !== action.workspaceId) && (
            <p className="control-meta">
              This historical check belongs to another Codex data directory or workspace. Evidence
              is read-only.
            </p>
          )}
          <div className="codex-network-heading">
            <strong role={j.status === 'running' && c.currentOwned ? 'status' : undefined}>
              {j.status === 'running'
                ? c.currentOwned
                  ? PROGRESS[j.progress]
                  : 'Recorded running · ownership unverified'
                : j.status === 'completed'
                  ? j.result?.outcome === 'passed'
                    ? 'Copy refused both connections'
                    : j.result?.outcome === 'attention'
                      ? 'Copied policy allowed a connection'
                      : 'Check inconclusive'
                  : j.status === 'cancelled'
                    ? 'Check cancelled'
                    : 'Check failed'}
            </strong>
            <Badge
              tone={j.status === 'failed' || j.result?.outcome === 'attention' ? 'orange' : 'muted'}
            >
              {j.status === 'running' && !c.currentOwned ? 'Ownership unverified' : j.status}
            </Badge>
          </div>
          <p className="control-meta">
            {COPY[j.binding.copyKind]} ·{' '}
            {c.currentProof
              ? 'Matches inspected settings'
              : 'Historical copy · current relation unverified'}
          </p>
          {j.error && (
            <p className="control-error" role="alert">
              {CODEX_NETWORK_ERROR_MESSAGES[j.error]}
            </p>
          )}
          {j.status === 'running' && (
            <button
              className="button"
              disabled={!!action.busy || !c.canCancel}
              onClick={() => void c.cancel()}
            >
              Cancel check
            </button>
          )}
          {j.result && (
            <>
              <dl className="property-list codex-network-facts">
                {j.result.checks.map((probe) => (
                  <div key={probe.id}>
                    <dt>{probe.id === 'tcp' ? 'TCP loopback' : 'Unix socket'}</dt>
                    <dd>
                      {probe.effect === 'denied'
                        ? `OS refused · ${probe.errno}`
                        : probe.effect === 'allowed'
                          ? 'Connection accepted'
                          : probe.effect === 'unreached'
                            ? 'Not reached'
                            : 'Probe error'}
                    </dd>
                  </div>
                ))}
              </dl>
              <span className="control-meta">
                Positive controls:{' '}
                {j.result.checks.filter((probe) => probe.positiveConnections === 1).length}/2
                connected · cleanup confirmed
              </span>
            </>
          )}
          <details className="codex-network-evidence">
            <summary>Recorded check evidence</summary>
            <span>Recorded {new Date(j.finishedAt ?? j.startedAt).toLocaleString('en-GB')}</span>
            <span>Native binary SHA-256</span>
            <code>{j.binding.nativeBinarySha256}</code>
            <span>Permission copy SHA-256</span>
            <code>{j.binding.profileCopySha256}</code>
            <span>Probe suite SHA-256</span>
            <code>{j.binding.suiteSha256}</code>
          </details>
        </>
      )}
      {c.pollFailures >= 3 && (
        <p className="control-error" role="status">
          Automatic updates paused. Reload check history.
        </p>
      )}
    </section>
  );
}
