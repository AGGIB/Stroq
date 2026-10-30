'use client';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Dialog } from 'radix-ui';
import { X } from 'lucide-react';
import { AgentGlyph } from '@/components/platform-ui';
import { usePlatform } from '@/components/platform-provider';
import { codexPathGuardLocation } from '@/lib/codex-path-guard-navigation';
import { CODEX_PATH_GUARD_MESSAGES } from '@/lib/codex-path-guard-client';
import { useCodexPathGuard } from './use-codex-path-guard';
import { CodexPathGuardDefault } from './codex-path-guard-default';
import { CodexPathGuardReview } from './codex-path-guard-review';
import { CodexPathGuardHistory } from './codex-path-guard-history';
export function CodexPathGuard() {
  const location = codexPathGuardLocation(useSearchParams()),
    { localAccess } = usePlatform();
  const [open, setOpen] = useState(location.open),
    [view, setView] = useState<'paths' | 'history'>(location.view),
    [manual, setManual] = useState(false);
  const linked = manual ? null : location,
    action = useCodexPathGuard(open && !linked?.invalid),
    trigger = useRef<HTMLButtonElement | null>(null),
    container = useRef<HTMLDivElement | null>(null),
    heading = useRef<HTMLHeadingElement | null>(null),
    completion = useRef<HTMLParagraphElement | null>(null);
  const mismatch =
    !!linked?.controlContextId &&
    !!action.state?.controlContextId &&
    linked.controlContextId !== action.state.controlContextId;
  const missing =
    !!linked?.recordId &&
    !!action.state &&
    !action.state.records.some(
      (r) => r.id === linked.recordId && r.controlContextId === linked.controlContextId,
    );
  const blocked = linked?.invalid || mismatch || missing;
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
    location.invalid,
  ]);
  useEffect(() => {
    if (action.receipt?.writeConfirmed) completion.current?.focus({ preventScroll: true });
  }, [action.receipt?.operationId, action.receipt?.writeConfirmed]);
  const close = () => {
    action.close();
    setOpen(false);
  };
  return (
    <>
      <div className="codex-path-entry">
        <div>
          <span>Credential paths</span>
          <span className="control-meta">Codex local command paths</span>
        </div>
        <button
          ref={trigger}
          className="inline-link"
          disabled={!localAccess}
          onClick={() => {
            setManual(true);
            setView('paths');
            setOpen(true);
          }}
        >
          Manage
        </button>
      </div>
      <Dialog.Root
        open={open}
        onOpenChange={(next) => {
          if (!next) close();
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content
            ref={container}
            tabIndex={-1}
            className="dialog-content codex-path-dialog"
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              (linked?.recordId ? container.current : heading.current)?.focus({
                preventScroll: true,
              });
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              if (trigger.current?.isConnected) trigger.current.focus({ preventScroll: true });
            }}
          >
            <div className="dialog-header">
              <div>
                <Dialog.Title ref={heading} tabIndex={-1}>
                  <AgentGlyph name="Codex CLI" />
                  Credential paths
                </Dialog.Title>
                <Dialog.Description className="control-meta">
                  Codex user configuration · local sandbox commands
                </Dialog.Description>
              </div>
              <button className="icon-button" onClick={close} aria-label="Close credential paths">
                <X size={20} />
              </button>
            </div>
            <div className="codex-path-body">
              <div className="codex-path-views" aria-label="Credential path views">
                <button
                  className="button"
                  aria-pressed={view === 'paths'}
                  disabled={!!action.busy}
                  onClick={() => {
                    setManual(true);
                    setView('paths');
                    action.clearPreview();
                  }}
                >
                  Paths
                </button>
                <button
                  className="button"
                  aria-pressed={view === 'history'}
                  disabled={!!action.busy}
                  onClick={() => {
                    setManual(true);
                    setView('history');
                    action.clearPreview();
                  }}
                >
                  History
                </button>
              </div>
              {blocked ? (
                <div className="codex-path-notice" role="alert">
                  <p className="control-meta">
                    {linked?.invalid
                      ? 'This credential path link is invalid.'
                      : mismatch
                        ? 'This link belongs to another Codex data directory.'
                        : 'The exact linked change is absent from this read. Earlier completion remains unverified.'}
                  </p>
                  <button
                    className="button"
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
                  {action.state?.error && (
                    <p className="control-error" role="alert">
                      {CODEX_PATH_GUARD_MESSAGES[action.state.error]}
                    </p>
                  )}
                  {action.receipt?.writeConfirmed && (
                    <p
                      className="codex-path-completion control-meta"
                      ref={completion}
                      tabIndex={-1}
                      role="status"
                    >
                      {action.receipt.record.operationStatus === 'restored'
                        ? 'Previous path rule restored and read back.'
                        : 'Path denial written and read back.'}{' '}
                      Native adoption remains unverified.
                    </p>
                  )}
                  {action.preview ? (
                    <CodexPathGuardReview action={action} />
                  ) : view === 'paths' ? (
                    <CodexPathGuardDefault action={action} />
                  ) : (
                    <CodexPathGuardHistory action={action} recordId={linked?.recordId ?? null} />
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
