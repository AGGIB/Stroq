'use client';
import { useEffect, useRef } from 'react';
import { Badge } from '@/components/platform-ui';
import type { CodexNetworkControls } from './use-codex-network-controls';
export const NETWORK_KIND_LABEL = {
  'profile-network-off': 'Permission profile · network flag',
  'profile-child': 'Full access → workspace profile',
  'legacy-network-off': 'Legacy workspace-write · network flag',
  'legacy-enable-workspace': 'Legacy full access → workspace-write',
} as const;
export function CodexNetworkReview({ action }: { action: CodexNetworkControls }) {
  const g = action.guard,
    p = g.preview,
    heading = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    if (p) heading.current?.focus();
  }, [p?.id]);
  if (!p) return null;
  return (
    <section className="codex-network-review" aria-label="Review Codex network setting">
      <div className="codex-network-heading">
        <h3 ref={heading} tabIndex={-1}>
          {p.operation === 'guard' ? 'Turn command networking off' : 'Restore previous setting'}
        </h3>
        <Badge tone="orange">User default</Badge>
      </div>
      <span className="control-meta">{NETWORK_KIND_LABEL[p.kind]}</span>
      <dl className="property-list codex-network-facts">
        <div>
          <dt>Networking</dt>
          <dd>{p.networkEffect === 'off' ? 'Off' : 'Previous setting'}</dd>
        </div>
        <div>
          <dt>Filesystem</dt>
          <dd>
            {p.filesystemEffect === 'unchanged'
              ? 'Unchanged'
              : p.filesystemEffect === 'workspace-restricted'
                ? 'Workspace policy'
                : 'Previous settings'}
          </dd>
        </div>
      </dl>
      {p.kind === 'profile-network-off' && p.operation === 'guard' && (
        <p className="control-meta">
          Updates the selected permission profile’s network flag. Its filesystem rules and default
          selector stay unchanged.
        </p>
      )}
      {p.filesystemEffect === 'workspace-restricted' && (
        <p className="control-meta">
          Also replaces full access with a workspace policy. This restricts file writes.
        </p>
      )}
      {p.retainsInactiveProfile && (
        <p className="control-meta">
          The owned profile remains inactive after Restore. Later unrelated settings are preserved.
        </p>
      )}
      <div className="codex-network-consent">
        <label>
          <input
            type="checkbox"
            checked={g.ack.shared}
            disabled={!!action.busy}
            onChange={(e) => g.acknowledge('shared', e.target.checked)}
          />
          <span>Change this Codex user default across workspaces.</span>
        </label>
        <label>
          <input
            type="checkbox"
            checked={g.ack.retention}
            disabled={!!action.busy}
            onChange={(e) => g.acknowledge('retention', e.target.checked)}
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
              checked={g.ack.weakening}
              disabled={!!action.busy}
              onChange={(e) => g.acknowledge('weakening', e.target.checked)}
            />
            <span>
              {p.kind === 'profile-child' || p.kind === 'legacy-enable-workspace'
                ? 'Restore the prior setting; network access or broader file writes may return.'
                : 'Restore the prior networking setting; network access may return.'}
            </span>
          </label>
        )}
      </div>
      <div className="codex-network-actions">
        <button
          className="button primary"
          disabled={!g.canApply || !!action.busy}
          onClick={() => void g.apply()}
        >
          {p.operation === 'guard' ? 'Apply network guard' : 'Restore setting'}
        </button>
        <button className="button" disabled={!!action.busy} onClick={g.clearPreview}>
          Cancel preview
        </button>
      </div>
      <details className="codex-network-evidence">
        <summary>Configuration fingerprints</summary>
        <span>Before</span>
        <code>{p.beforeSha256 ?? 'File absent'}</code>
        <span>After</span>
        <code>{p.afterSha256 ?? 'File absent'}</code>
      </details>
    </section>
  );
}
