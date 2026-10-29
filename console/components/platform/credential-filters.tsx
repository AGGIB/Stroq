'use client';
import { useEffect, useRef, useState } from 'react';
import { Dialog } from 'radix-ui';
import { LoaderCircle, RefreshCw, X } from 'lucide-react';
import { Badge } from '@/components/platform-ui';
import {
  CREDENTIAL_FILTER_REASONS,
  CREDENTIAL_FILTER_TARGETS,
  type CredentialFilterReceipt,
  type CredentialFilterTarget,
} from '@/lib/credential-filters';
import {
  credentialFilterContextKey,
  credentialFilterTarget,
  credentialFilterApplyInput,
} from '@/lib/credential-filter-binding';
import { CredentialFilterPreviewDetails, filterContextLabel } from './credential-filter-preview';
import { useCredentialFilterAction } from './use-credential-filter-action';
import type { useCredentialFilters } from './use-credential-filters';

export function CredentialFilters({
  agent,
  scope,
  filters,
  onWorkspaceScope,
  onChanged,
  linked = false,
  onSelectionChange,
}: {
  agent: 'claude-code' | 'cursor';
  scope: 'project' | 'user';
  filters: ReturnType<typeof useCredentialFilters>;
  onWorkspaceScope: () => void;
  onChanged: () => void;
  linked?: boolean;
  onSelectionChange?: (target: CredentialFilterTarget | null) => void;
}) {
  const target = credentialFilterTarget(agent, scope);
  const row = filters.state?.targets.find((item) => item.id === target) ?? null;
  const [open, setOpen] = useState(false);
  const [receipt, setReceipt] = useState<CredentialFilterReceipt | null>(null);
  const [uncertain, setUncertain] = useState<string | null>(null);
  const contextKey = credentialFilterContextKey(filters.workspaceId, target, filters.generation);
  const identity = `${filters.workspaceId}:${target}`;
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const focusedLink = useRef<string | null>(null);
  const focus = useRef<HTMLInputElement | null>(null),
    trigger = useRef<HTMLButtonElement | null>(null);
  const previewTrigger = useRef<HTMLButtonElement | null>(null),
    recheckTrigger = useRef<HTMLButtonElement | null>(null),
    returnPreviewFocus = useRef(false);
  const action = useCredentialFilterAction({
    open,
    contextKey,
    workspaceId: filters.workspaceId,
    row,
    onCompleted: (value) => {
      setReceipt(value);
      setUncertain(null);
      onChanged();
    },
    onUnverified: (selected) => {
      setUncertain(`${selected.workspaceId}:${selected.target}`);
      setReceipt(null);
    },
  });
  useEffect(() => {
    setOpen(false);
    setReceipt(null);
  }, [identity]);
  useEffect(() => {
    if (!onSelectionChange) return;
    if (!linked) {
      focusedLink.current = null;
      setOpen(false);
    } else if (row && !filters.loading) {
      setOpen(true);
      if (focusedLink.current !== identity) {
        focusedLink.current = identity;
        trigger.current?.scrollIntoView({ block: 'nearest' });
      }
    }
  }, [linked, row, filters.loading, onSelectionChange, identity]);
  useEffect(() => {
    if (action.preview) focus.current?.focus();
    else if (returnPreviewFocus.current) {
      returnPreviewFocus.current = false;
      (previewTrigger.current ?? recheckTrigger.current)?.focus();
    }
  }, [action.preview]);
  if (!target)
    return (
      <div className="credential-filter-row">
        <div>
          <span>Credential file filters</span>
          <span className="control-meta">Workspace only</span>
        </div>
        <button className="inline-link" onClick={onWorkspaceScope}>
          Use Workspace scope
        </button>
      </div>
    );
  const unavailable =
    !row || row.status === 'unavailable' || !filters.state?.available || Boolean(filters.error);
  const locked = filters.loading || action.busy !== null;
  const status = filters.loading
    ? 'Rechecking…'
    : unavailable
      ? 'Unavailable'
      : row.status === 'configured'
        ? 'Configured rules'
        : row.status === 'partial'
          ? 'Partial rules'
          : 'No explicit rules';
  const reason = row?.reason ?? filters.state?.reason;
  const needsRecheck = action.needsRecheck || uncertain === identity;
  const recheck = async () => {
    const selected = identity;
    const confirmed = await filters.refresh();
    if (confirmed && currentIdentity.current === selected)
      setUncertain((before) => (before === selected ? null : before));
  };
  return (
    <>
      <div className="credential-filter-row">
        <div>
          <span>Credential file filters</span>
          <Badge tone={unavailable || row?.status === 'partial' || reason ? 'orange' : 'muted'}>
            {status}
          </Badge>
        </div>
        <button
          ref={trigger}
          className="inline-link"
          disabled={!filters.workspaceId}
          onClick={() => {
            setReceipt(null);
            if (onSelectionChange) onSelectionChange(target);
            else setOpen(true);
          }}
        >
          Review filters
        </button>
      </div>
      <Dialog.Root
        open={open}
        onOpenChange={(value) => {
          if (action.busy !== 'apply') {
            setOpen(value);
            if (!value) {
              action.dismissPreview();
              onSelectionChange?.(null);
            }
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content
            className="dialog-content credential-filter-dialog"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              trigger.current?.focus({ preventScroll: true });
            }}
          >
            <div className="dialog-header">
              <Dialog.Title>Credential file filters</Dialog.Title>
              <Dialog.Description>
                {agent === 'claude-code' ? 'Claude Code' : 'Cursor'} ·{' '}
                {scope === 'user' ? 'User' : 'Workspace'} · configuration only
              </Dialog.Description>
              <Dialog.Close
                className="dialog-close icon-button"
                disabled={action.busy === 'apply'}
                aria-label="Close credential filters"
              >
                <X size={19} />
              </Dialog.Close>
            </div>
            {receipt &&
              receipt.workspaceId === filters.workspaceId &&
              receipt.target === target && (
                <div className="credential-filter-outcome" role="status">
                  <strong>
                    {receipt.status === 'configured'
                      ? 'Rules configured'
                      : receipt.status === 'undone'
                        ? 'Managed changes undone'
                        : 'No configuration change'}
                  </strong>
                  <p className="control-meta">
                    Start a fresh client session and verify its loaded settings. Blocking was not
                    tested.
                  </p>
                </div>
              )}
            {action.error && (
              <p className="control-error" role="alert">
                {action.error}
              </p>
            )}
            {!action.error && uncertain === identity && (
              <p className="control-error" role="alert">
                Completion is unknown. Recheck before another action.
              </p>
            )}
            {filters.error && (
              <p className="control-error" role="status">
                {filters.error}
              </p>
            )}
            {action.preview ? (
              <>
                <CredentialFilterPreviewDetails
                  preview={action.preview}
                  acknowledged={action.acknowledged}
                  onAcknowledge={action.acknowledge}
                  disabled={action.busy === 'apply'}
                  focusRef={focus}
                />
                <div className="credential-filter-actions">
                  <button
                    className="button primary"
                    disabled={
                      locked ||
                      needsRecheck ||
                      !credentialFilterApplyInput(action.preview, action.acknowledged)
                    }
                    onClick={() => void action.apply()}
                  >
                    {action.busy === 'apply' ? <LoaderCircle size={16} className="spin" /> : null}
                    {action.busy === 'apply'
                      ? 'Applying…'
                      : action.preview.action === 'undo-filter'
                        ? 'Undo managed filters'
                        : action.preview.operation === 'unchanged'
                          ? 'Confirm unchanged'
                          : 'Apply filters'}
                  </button>
                  <button
                    className="button"
                    disabled={locked}
                    onClick={() => {
                      returnPreviewFocus.current = true;
                      action.dismissPreview();
                    }}
                  >
                    Cancel preview
                  </button>
                </div>
              </>
            ) : (
              <>
                <Badge tone={unavailable || reason ? 'orange' : 'muted'}>{status}</Badge>
                {row && (
                  <dl className="property-list">
                    <div>
                      <dt>Source</dt>
                      <dd>
                        {CREDENTIAL_FILTER_TARGETS[target].target}
                        {row.location === 'main-checkout'
                          ? ' · main checkout'
                          : row.context === 'repository'
                            ? ' · repository root'
                            : ''}
                      </dd>
                    </div>
                    <div>
                      <dt>Effect</dt>
                      <dd>{filterContextLabel(row.context)}</dd>
                    </div>
                    <div>
                      <dt>Explicit rules</dt>
                      <dd>
                        {row.present} / {row.required} present
                      </dd>
                    </div>
                    <div>
                      <dt>Ownership</dt>
                      <dd>
                        {row.managed === null
                          ? 'Not verified'
                          : `${row.managed} Stroq-managed · ${row.unmanaged} preexisting`}
                      </dd>
                    </div>
                  </dl>
                )}
                {reason && <p className="control-meta">{CREDENTIAL_FILTER_REASONS[reason]}</p>}
                {agent === 'cursor' && (
                  <p className="control-meta">
                    Cursor already ignores common secret files by default. Missing managed rules do
                    not establish exposure.
                  </p>
                )}
                <div className="credential-filter-actions">
                  {!unavailable && (
                    <button
                      ref={previewTrigger}
                      className="button primary"
                      disabled={locked || Boolean(reason) || needsRecheck}
                      onClick={() => void action.prepare('apply-filter')}
                    >
                      {action.busy === 'preview' ? (
                        <LoaderCircle size={16} className="spin" />
                      ) : null}
                      {row?.status === 'configured' ? 'Preview existing rules' : 'Preview filters'}
                    </button>
                  )}
                  {row?.undoAvailable && !unavailable && (
                    <button
                      className="button"
                      disabled={locked || needsRecheck}
                      onClick={() => void action.prepare('undo-filter')}
                    >
                      Preview undo
                    </button>
                  )}
                  <button
                    ref={recheckTrigger}
                    className="button"
                    disabled={locked}
                    onClick={() => void recheck()}
                  >
                    <RefreshCw size={16} className={filters.loading ? 'spin' : undefined} />
                    {filters.loading ? 'Rechecking…' : 'Recheck filters'}
                  </button>
                </div>
                {filters.state && (
                  <details className="artifact-section">
                    <summary>Native limits & ownership</summary>
                    {filters.state.limitations.map((limit) => (
                      <p className="control-meta" key={limit}>
                        {limit}
                      </p>
                    ))}
                    <p className="control-meta">
                      Preexisting rules stay user-owned. A no-op does not create an undo record.
                    </p>
                  </details>
                )}
              </>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
