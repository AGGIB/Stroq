'use client';
import { Dialog } from 'radix-ui';
import { useEffect, useRef, useState } from 'react';
import { Check, LoaderCircle, RefreshCw, Unplug, X } from 'lucide-react';
import { AgentGlyph, Badge } from '@/components/platform-ui';
import { AGENT_NAMES } from '@/lib/agent-status';
import { DISCONNECT_BACKUP_ROOT, type AgentDisconnectState } from '@/lib/agent-disconnect';
import type { SetupAgent, SetupScope } from '@/lib/agent-setup';
import { disconnectApplyInput } from '@/lib/agent-disconnect-binding';
import { SetupDialog } from './agent-setup';
import { useAgentDisconnect } from './use-agent-disconnect';

const REASONS: Record<NonNullable<AgentDisconnectState['reason']>, string> = {
  'custom-home-unsupported': 'Hook removal requires the default Stroq directory.',
  'platform-unsupported': 'Hook removal is unavailable on this platform.',
  'context-unavailable': 'Workspace or user context could not be established.',
  'engine-unavailable': 'The Stroq runtime is unavailable.',
  'runtime-path-unsupported': 'This runtime path cannot be used safely.',
};
export function AgentDisconnect({
  agent,
  scope,
  generation,
  onChanged,
  showTrigger = true,
}: {
  agent: SetupAgent;
  scope: SetupScope;
  generation: number;
  onChanged: () => void;
  showTrigger?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const heading = useRef<HTMLHeadingElement | null>(null);
  const consent = useRef<HTMLInputElement | null>(null);
  const action = useAgentDisconnect({ open, agent, scope, generation, onChanged });
  const preview = action.preview;
  const receipt = action.receipt;
  const canApply = preview && disconnectApplyInput(preview, action.acknowledged) !== null;
  const error =
    action.error ??
    (action.needsRecheck
      ? 'Completion is unknown. Recheck current configuration before preparing another removal.'
      : null);
  useEffect(() => {
    if (preview) (consent.current ?? heading.current)?.focus();
  }, [preview]);
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(value) => {
        if (action.busy !== 'apply') setOpen(value);
      }}
    >
      {(showTrigger || open) && (
        <Dialog.Trigger asChild>
          <button ref={trigger} className="button subtle small">
            <Unplug size={15} aria-hidden="true" />
            Remove Stroq hooks
          </button>
        </Dialog.Trigger>
      )}
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          className="dialog-content setup-dialog"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            heading.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            requestAnimationFrame(() => {
              if (trigger.current?.isConnected) trigger.current.focus();
              else document.getElementById(agent)?.focus();
            });
          }}
        >
          <div className="dialog-header">
            <Dialog.Title ref={heading} tabIndex={-1}>
              {receipt ? 'Hook removal receipt' : 'Remove Stroq hooks'}
            </Dialog.Title>
            <Dialog.Description>
              {AGENT_NAMES[agent]} · {scope === 'user' ? 'User · all workspaces' : 'Workspace'}
            </Dialog.Description>
            <Dialog.Close
              className="dialog-close icon-button"
              aria-label="Close hook removal"
              disabled={action.busy === 'apply'}
            >
              <X size={18} />
            </Dialog.Close>
          </div>
          <div className="setup-body">
            {error && (
              <p className="control-error" role="alert">
                {error}
              </p>
            )}
            {action.message && (
              <p className="control-meta" role="status">
                {action.message}
              </p>
            )}
            {(action.busy === 'load' || action.busy === 'recheck') && (
              <p className="control-meta" role="status">
                <LoaderCircle size={18} className="spin" aria-hidden="true" />
                {action.busy === 'recheck'
                  ? 'Rechecking current configuration…'
                  : 'Reading removal support…'}
              </p>
            )}
            {action.state && !action.state.available && action.state.reason && (
              <p className="control-error" role="status">
                {REASONS[action.state.reason]}
              </p>
            )}
            {receipt ? (
              <>
                <div className="setup-success">
                  <Check size={24} aria-hidden="true" />
                  <div>
                    <strong>{receipt.removedHooks} exact hooks removed from this file</strong>
                    <p>Recorded {new Date(receipt.completedAt).toLocaleString('en-GB')}.</p>
                  </div>
                </div>
                <dl className="property-list">
                  <div>
                    <dt>Source</dt>
                    <dd>
                      <code>{receipt.target}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>Impact</dt>
                    <dd>
                      {receipt.scopeImpact === 'all-workspaces'
                        ? 'User · all workspaces'
                        : 'Selected workspace'}
                    </dd>
                  </div>
                  <div>
                    <dt>Other hooks preserved</dt>
                    <dd>{receipt.preservedHooks}</dd>
                  </div>
                  <div>
                    <dt>Similar commands remaining</dt>
                    <dd>{receipt.remainingLookalikes}</dd>
                  </div>
                </dl>
                <p className="control-meta">
                  Running agents are not stopped. Use a new session to load this configuration.
                </p>
                {receipt.remainingLookalikes > 0 && (
                  <p className="control-error" role="status">
                    Modified or similar commands remain. This receipt is not a complete disconnect
                    of every source.
                  </p>
                )}
                <details className="setup-next">
                  <summary>Recovery reference</summary>
                  <code className="inventory-digest">{receipt.backupId}</code>
                  <p>{DISCONNECT_BACKUP_ROOT}</p>
                  <p>Private, unencrypted full settings copy retained without automatic expiry.</p>
                </details>
              </>
            ) : preview ? (
              <>
                <div className="setup-preview">
                  <div className="setup-preview-heading">
                    <AgentGlyph name={AGENT_NAMES[preview.agent]} />
                    <strong>{AGENT_NAMES[preview.agent]}</strong>
                    <Badge tone="muted">Configuration</Badge>
                  </div>
                  <dl className="property-list">
                    <div>
                      <dt>Source</dt>
                      <dd>
                        <code>{preview.target}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>Impact</dt>
                      <dd>
                        {preview.scopeImpact === 'all-workspaces'
                          ? 'User · all workspaces'
                          : 'Selected workspace'}
                      </dd>
                    </div>
                    <div>
                      <dt>Exact hooks to remove</dt>
                      <dd>{preview.removedHooks}</dd>
                    </div>
                    <div>
                      <dt>Other hooks preserved</dt>
                      <dd>{preview.preservedHooks}</dd>
                    </div>
                    <div>
                      <dt>Similar commands remaining</dt>
                      <dd>{preview.remainingLookalikes}</dd>
                    </div>
                  </dl>
                  {preview.scope === 'project' && preview.scopeImpact === 'all-workspaces' && (
                    <p className="control-error" role="status">
                      This workspace resolves to a user-wide file.
                    </p>
                  )}
                  {preview.operation === 'unchanged' && (
                    <p className="control-meta" role="status">
                      No exact hooks for this Stroq runtime were found to remove.
                    </p>
                  )}
                  {preview.remainingLookalikes > 0 && (
                    <p className="control-meta">
                      Modified or similar commands will remain for separate review.
                    </p>
                  )}
                  {preview.events.length > 0 && (
                    <details className="setup-next">
                      <summary>Affected events</summary>
                      <div className="setup-events">
                        {preview.events.map((event) => (
                          <div key={event.event}>
                            <span>{event.event}</span>
                            <span>{event.removed} removed</span>
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                  <details className="setup-next">
                    <summary>Fingerprints</summary>
                    <dl className="property-list">
                      <div>
                        <dt>Current settings</dt>
                        <dd className="inventory-digest">
                          {preview.sourceSha256 ?? 'No source file'}
                        </dd>
                      </div>
                      <div>
                        <dt>After removal</dt>
                        <dd className="inventory-digest">
                          {preview.candidateSha256 ?? 'No source file'}
                        </dd>
                      </div>
                    </dl>
                  </details>
                </div>
                {preview.operation === 'remove-hooks' && (
                  <div>
                    <label className="policy-ack">
                      <input
                        ref={consent}
                        type="checkbox"
                        disabled={action.busy === 'apply'}
                        checked={action.acknowledged.acknowledgeWeakenProtection}
                        onChange={(event) =>
                          action.acknowledge('acknowledgeWeakenProtection', event.target.checked)
                        }
                      />
                      <span>
                        I understand removing these hooks weakens protection in new agent sessions.
                      </span>
                    </label>
                    <label className="policy-ack">
                      <input
                        type="checkbox"
                        disabled={action.busy === 'apply'}
                        checked={action.acknowledged.acknowledgeRetainedCopy}
                        onChange={(event) =>
                          action.acknowledge('acknowledgeRetainedCopy', event.target.checked)
                        }
                      />
                      <span>
                        Keep a private, unencrypted full copy of these settings, including other
                        entries and any embedded credentials, without automatic expiry. The store
                        accepts up to 32 recovery records.
                      </span>
                    </label>
                    {preview.needs.acknowledgeSharedScope && (
                      <label className="policy-ack">
                        <input
                          type="checkbox"
                          disabled={action.busy === 'apply'}
                          checked={action.acknowledged.acknowledgeSharedScope}
                          onChange={(event) =>
                            action.acknowledge('acknowledgeSharedScope', event.target.checked)
                          }
                        />
                        <span>Apply this removal across workspaces for this OS user.</span>
                      </label>
                    )}
                  </div>
                )}
                <p className="control-meta">
                  Preview expires {new Date(preview.expiresAt).toLocaleTimeString('en-GB')}.
                </p>
                <details className="setup-next">
                  <summary>Scope & limits</summary>
                  <ul>
                    {preview.limitations.map((limit) => (
                      <li key={limit}>{limit}</li>
                    ))}
                  </ul>
                </details>
              </>
            ) : (
              !action.busy && (
                <p className="control-meta">
                  Preview the exact hooks in this selected source before removing them.
                </p>
              )
            )}
          </div>
          <div className="dialog-footer">
            {receipt ? (
              <>
                <SetupDialog
                  agent={{ id: agent }}
                  scope={scope}
                  label="Reconnect"
                  onConfigured={onChanged}
                />
                <Dialog.Close className="button primary">Done</Dialog.Close>
              </>
            ) : action.needsRecheck || action.error ? (
              <button
                className="button"
                disabled={Boolean(action.busy)}
                onClick={() => void action.recheck()}
              >
                <RefreshCw size={16} aria-hidden="true" />
                Recheck configuration
              </button>
            ) : preview?.operation === 'remove-hooks' ? (
              <>
                <button
                  className="button"
                  disabled={Boolean(action.busy)}
                  onClick={() => void action.prepare()}
                >
                  Refresh preview
                </button>
                <button
                  className="button primary"
                  disabled={Boolean(action.busy) || !canApply}
                  onClick={() => void action.apply()}
                >
                  {action.busy === 'apply' ? (
                    <LoaderCircle size={16} className="spin" aria-hidden="true" />
                  ) : (
                    <Unplug size={16} aria-hidden="true" />
                  )}
                  Remove these hooks
                </button>
              </>
            ) : (
              <button
                className="button"
                disabled={Boolean(action.busy) || !action.state?.available || action.needsRecheck}
                onClick={() => void action.prepare()}
              >
                {action.busy === 'preview' ? (
                  <LoaderCircle size={16} className="spin" aria-hidden="true" />
                ) : (
                  <Unplug size={16} aria-hidden="true" />
                )}
                {preview ? 'Preview again' : 'Preview removal'}
              </button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
