'use client';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Dialog } from 'radix-ui';
import { X } from 'lucide-react';
import { AgentGlyph } from '@/components/platform-ui';
import { usePlatform } from '@/components/platform-provider';
import { codexNetworkLocation } from '@/lib/codex-network-navigation';
import { CODEX_NETWORK_ERROR_MESSAGES } from '@/lib/codex-network-client';
import { useCodexNetworkControls } from './use-codex-network-controls';
import { CodexNetworkReview } from './codex-network-review';
import { CodexNetworkDefault } from './codex-network-default';
import { CodexNetworkChecks } from './codex-network-checks';
import { CodexNetworkHistory } from './codex-network-history';
export function CodexNetworkGuard() {
  const location = codexNetworkLocation(useSearchParams()),
    { localAccess, localContext } = usePlatform();
  const [open, setOpen] = useState(location.open),
    [view, setView] = useState<'default' | 'history'>(location.view),
    [manual, setManual] = useState(false),
    [checkFocus, setCheckFocus] = useState<{ jobId: string; sequence: number } | null>(null);
  const linked = manual ? null : location,
    workspaceMismatch = !!linked?.workspaceId && linked.workspaceId !== localContext?.workspace.id;
  const action = useCodexNetworkControls(open && !linked?.invalid && !workspaceMismatch);
  const trigger = useRef<HTMLButtonElement | null>(null),
    anchor = useRef<HTMLDivElement | null>(null),
    heading = useRef<HTMLHeadingElement | null>(null),
    completion = useRef<HTMLParagraphElement | null>(null);
  const contextMismatch =
    !!linked?.controlContextId &&
    !!action.guard.state?.controlContextId &&
    linked.controlContextId !== action.guard.state.controlContextId;
  const missingRecord =
    !!linked?.recordId &&
    !!action.guard.state &&
    !action.guard.state.records.some((r) => r.id === linked.recordId);
  const missingJob =
    !!linked?.jobId &&
    !!action.checks.state &&
    !action.checks.state.jobs.some(
      (j) =>
        j.id === linked.jobId &&
        j.binding.controlContextId === linked.controlContextId &&
        j.binding.workspaceId === linked.workspaceId,
    );
  const blocked =
    linked?.invalid || workspaceMismatch || contextMismatch || missingRecord || missingJob;
  useEffect(() => {
    if (location.open) {
      setOpen(true);
      setView(location.view);
      setManual(false);
    }
  }, [
    location.open,
    location.view,
    location.controlContextId,
    location.recordId,
    location.jobId,
    location.workspaceId,
    location.invalid,
  ]);
  useEffect(() => {
    if (linked?.jobId && !blocked) action.checks.selectJob(linked.jobId);
  }, [linked?.jobId, blocked, action.checks.state]);
  useEffect(() => {
    if (action.guard.receipt?.writeConfirmed) completion.current?.focus();
  }, [action.guard.receipt?.operationId, action.guard.receipt?.writeConfirmed]);
  const close = () => {
    action.close();
    setOpen(false);
  };
  const checking = !!action.checks.preview || action.checks.currentOwned;
  return (
    <>
      <div className="codex-network-entry" ref={anchor} tabIndex={-1}>
        <div>
          <span>Network guard</span>
          <span className="control-meta">Codex user default</span>
        </div>
        <button
          ref={trigger}
          className="inline-link"
          disabled={!localAccess}
          onClick={() => {
            if (!localAccess) return;
            setManual(true);
            setView('default');
            setOpen(true);
          }}
        >
          Manage
        </button>
      </div>
      <Dialog.Root
        open={open}
        onOpenChange={(value) => {
          if (!value) close();
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content
            className="dialog-content codex-network-dialog"
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              heading.current?.focus();
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              if (trigger.current?.isConnected && !trigger.current.disabled)
                trigger.current.focus();
              else anchor.current?.focus();
            }}
          >
            <div className="dialog-header">
              <Dialog.Title ref={heading} tabIndex={-1}>
                <AgentGlyph name="Codex CLI" />
                Codex network guard
              </Dialog.Title>
              <Dialog.Description>Local commands · base user setting</Dialog.Description>
              <Dialog.Close
                className="dialog-close icon-button"
                aria-label="Close Codex network guard"
              >
                <X size={18} aria-hidden="true" />
              </Dialog.Close>
            </div>
            <div className="codex-network-body" aria-busy={!!action.busy}>
              <div className="codex-network-views">
                <button
                  className="button"
                  aria-pressed={view === 'default'}
                  onClick={() => setView('default')}
                >
                  Default
                </button>
                <button
                  className="button"
                  aria-pressed={view === 'history'}
                  onClick={() => setView('history')}
                >
                  History
                </button>
              </div>
              {blocked ? (
                <div className="codex-network-notice" role="alert">
                  <p>
                    {linked?.invalid
                      ? 'This network-guard link is invalid.'
                      : workspaceMismatch || contextMismatch
                        ? 'This link belongs to another workspace or Codex data directory.'
                        : 'The exact linked record is absent from this read. Earlier completion remains unverified.'}
                  </p>
                  <button
                    className="button"
                    disabled={!!action.busy}
                    onClick={() => {
                      setManual(true);
                      setView('history');
                    }}
                  >
                    Show current history
                  </button>
                </div>
              ) : (
                <>
                  {action.error && (
                    <p className="control-error" role="alert">
                      {action.error}
                    </p>
                  )}
                  {action.guard.state?.error && (
                    <p className="control-error" role="alert">
                      {CODEX_NETWORK_ERROR_MESSAGES[action.guard.state.error]}
                    </p>
                  )}
                  {action.checks.state?.error && (
                    <p className="control-error" role="alert">
                      {CODEX_NETWORK_ERROR_MESSAGES[action.checks.state.error]}
                    </p>
                  )}
                  {action.guard.receipt?.writeConfirmed && (
                    <p
                      className="codex-network-completion control-meta"
                      ref={completion}
                      tabIndex={-1}
                      role="status"
                    >
                      {action.guard.receipt.record.operationStatus === 'restored'
                        ? 'Prior setting restored and read back.'
                        : 'Network-off setting written and read back.'}{' '}
                      Native adoption remains unverified.
                    </p>
                  )}
                  {action.guard.preview ? (
                    <CodexNetworkReview action={action} />
                  ) : view === 'default' && !checking ? (
                    <CodexNetworkDefault action={action} />
                  ) : null}
                  {!action.guard.preview && (
                    <CodexNetworkChecks
                      action={action}
                      autoFocus={!linked?.recordId}
                      focusRequest={checkFocus}
                    />
                  )}
                  {view === 'history' && !action.guard.preview && (
                    <CodexNetworkHistory
                      action={action}
                      recordId={linked?.recordId ?? null}
                      onCheck={(id) => {
                        setManual(true);
                        action.checks.selectJob(id);
                        setCheckFocus((previous) => ({
                          jobId: id,
                          sequence: (previous?.sequence ?? 0) + 1,
                        }));
                      }}
                    />
                  )}
                </>
              )}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
