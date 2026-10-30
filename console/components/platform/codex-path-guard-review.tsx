'use client';
import { useEffect, useRef } from 'react';
import { Badge } from '@/components/platform-ui';
import { CODEX_PATH_GUARD_LABELS } from '@/lib/codex-path-guard-client';
import type { CodexPathGuardAction } from './use-codex-path-guard';
export function CodexPathGuardReview({ action }: { action: CodexPathGuardAction }) {
  const p = action.preview,
    heading = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    if (p) heading.current?.focus({ preventScroll: true });
  }, [p?.id]);
  if (!p) return null;
  const label = CODEX_PATH_GUARD_LABELS[p.presetId];
  return (
    <section className="codex-path-review" aria-label="Review credential path rule">
      <div className="codex-path-heading">
        <h3 ref={heading} tabIndex={-1}>
          {p.operation === 'guard' ? 'Deny reads and writes' : 'Restore previous path rule'}
        </h3>
        <Badge tone="orange">User default</Badge>
      </div>
      <div className="codex-path-target">
        <strong>{label.name}</strong>
        <code>{label.path}</code>
      </div>
      <dl className="property-list codex-path-facts">
        <div>
          <dt>Path access</dt>
          <dd>{p.operation === 'guard' ? 'Deny reads + writes' : 'Previous rule'}</dd>
        </div>
        <div>
          <dt>Networking</dt>
          <dd>Preserved</dd>
        </div>
      </dl>
      <p className="control-meta">
        {p.operation === 'guard'
          ? 'Adds one exact path denial.'
          : 'Restores only the owned path rule; later unrelated settings stay in place.'}{' '}
        Existing chats may not adopt this change. Native enforcement remains unverified.
      </p>
      <div className="codex-path-consent">
        <label>
          <input
            type="checkbox"
            checked={action.ack.shared}
            disabled={!!action.busy}
            onChange={(e) => action.acknowledge('shared', e.target.checked)}
          />
          <span>Change this Codex user configuration across workspaces.</span>
        </label>
        <label>
          <input
            type="checkbox"
            checked={action.ack.retention}
            disabled={!!action.busy}
            onChange={(e) => action.acknowledge('retention', e.target.checked)}
          />
          <span>
            Keep full, unencrypted configuration copies, including private settings or credentials,
            without automatic expiry.
          </span>
        </label>
        {p.operation === 'restore' && (
          <label>
            <input
              type="checkbox"
              checked={action.ack.weakening}
              disabled={!!action.busy}
              onChange={(e) => action.acknowledge('weakening', e.target.checked)}
            />
            <span>Restore this path rule; read or write access may return.</span>
          </label>
        )}
      </div>
      <div className="codex-path-actions">
        <button
          className="button primary"
          disabled={!action.canApply || !!action.busy}
          onClick={() => void action.apply()}
        >
          {p.operation === 'guard' ? 'Apply deny' : 'Restore path rule'}
        </button>
        <button className="button" disabled={!!action.busy} onClick={action.clearPreview}>
          Cancel preview
        </button>
      </div>
      <details className="codex-path-evidence">
        <summary>Configuration fingerprints</summary>
        <span>Before</span>
        <code>{p.beforeSha256 ?? 'File absent'}</code>
        <span>After</span>
        <code>{p.afterSha256 ?? 'File absent'}</code>
        <p>
          Declaration only. Aliases, hardlinks, other copies and file tools are outside this path
          evidence.
        </p>
      </details>
    </section>
  );
}
