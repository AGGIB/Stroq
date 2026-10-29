'use client';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Dialog } from 'radix-ui';
import { LoaderCircle, RefreshCw, X } from 'lucide-react';
import { AgentGlyph } from '@/components/platform-ui';
import { parseCodexSkillControlLocation } from '@/lib/codex-skill-control-navigation';
import { useCodexSkillSources } from './use-codex-skill-sources';
import { useCodexSkillControls } from './use-codex-skill-controls';
import { SourceReport } from './codex-skill-source-report';
import { CodexSkillControlPanel, CodexSkillSavedChanges } from './codex-skill-controls';

export function CodexSkillSources({
  compact = false,
  disabled = false,
  controlsReady = true,
}: {
  compact?: boolean;
  disabled?: boolean;
  controlsReady?: boolean;
}) {
  const action = useCodexSkillSources();
  const location = parseCodexSkillControlLocation(useSearchParams());
  const [open, setOpen] = useState(location.open);
  const [view, setView] = useState<'sources' | 'saved'>(location.open ? 'saved' : 'sources');
  const [manual, setManual] = useState(false);
  const linked = manual ? null : location;
  const controls = useCodexSkillControls(
    open && controlsReady && !action.busy && !linked?.invalid,
    action.markHistorical,
  );
  const trigger = useRef<HTMLButtonElement | null>(null),
    anchor = useRef<HTMLSpanElement | null>(null),
    heading = useRef<HTMLHeadingElement | null>(null);
  const unavailable = disabled || !action.available;
  const mismatch =
    !!linked?.controlContextId &&
    !!controls.state?.controlContextId &&
    linked.controlContextId !== controls.state.controlContextId;
  useEffect(() => {
    if (location.open) {
      setOpen(true);
      setView('saved');
      setManual(false);
    }
  }, [location.open, location.recordId, location.controlContextId, location.invalid]);
  const inspect = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (unavailable || action.busy || controls.busy) return;
    trigger.current = event.currentTarget;
    setManual(true);
    setView('sources');
    setOpen(true);
    void action.inspect();
  };
  const button = (
    <button
      className={compact ? 'inline-link' : 'button'}
      disabled={unavailable || action.busy || !!controls.busy}
      onClick={inspect}
    >
      {compact ? 'Inspect' : 'Codex sources'}
    </button>
  );
  return (
    <>
      <span
        className={compact ? 'codex-source-entry' : 'codex-source-trigger'}
        ref={anchor}
        tabIndex={-1}
      >
        {compact && <span>Skill sources</span>}
        {button}
        <button
          className={compact ? 'inline-link' : 'button'}
          aria-label="Open saved Codex changes"
          disabled={unavailable || action.busy || !!controls.busy}
          onClick={(event) => {
            if (unavailable || action.busy || controls.busy) return;
            trigger.current = event.currentTarget;
            setManual(true);
            setView('saved');
            setOpen(true);
          }}
        >
          Saved changes
        </button>
      </span>
      <Dialog.Root
        open={open}
        onOpenChange={(value) => {
          if (!value) {
            action.cancel();
            controls.cancel();
            setOpen(false);
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content
            className="dialog-content inventory-dialog codex-source-dialog"
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
                <AgentGlyph name="Codex CLI" /> Codex sources
              </Dialog.Title>
              <Dialog.Description>
                Files and user declarations · session loading unverified
              </Dialog.Description>
              <Dialog.Close
                className="dialog-close icon-button"
                aria-label="Close Codex source inspection"
              >
                <X size={18} aria-hidden="true" />
              </Dialog.Close>
            </div>
            <div className="inventory-review-body" aria-busy={action.busy || !!controls.busy}>
              <div className="codex-source-tabs" aria-label="Codex source views">
                <button
                  className="button"
                  aria-pressed={view === 'sources'}
                  onClick={() => setView('sources')}
                >
                  Sources
                </button>
                <button
                  className="button"
                  aria-pressed={view === 'saved'}
                  onClick={() => setView('saved')}
                >
                  Saved changes
                </button>
              </div>
              {linked?.invalid || mismatch ? (
                <div className="codex-skill-control-unresolved">
                  <p className="control-error" role="alert">
                    {linked?.invalid
                      ? 'The saved change link is invalid.'
                      : 'This change belongs to another Codex data directory. Reconnect that context to inspect its record.'}
                  </p>
                  <button
                    className="button"
                    onClick={() => {
                      setManual(true);
                      setView('saved');
                    }}
                  >
                    Show current saved changes
                  </button>
                </div>
              ) : (
                <>
                  <CodexSkillControlPanel action={controls} />
                  {view === 'saved' ? (
                    <CodexSkillSavedChanges
                      action={controls}
                      selectedId={linked?.recordId ?? null}
                    />
                  ) : (
                    <>
                      <div className="codex-source-refresh">
                        <button
                          className="button"
                          disabled={!action.available || action.busy || !!controls.busy}
                          onClick={() => void action.inspect()}
                        >
                          {action.busy ? (
                            <LoaderCircle size={16} className="spin" aria-hidden="true" />
                          ) : (
                            <RefreshCw size={16} aria-hidden="true" />
                          )}
                          {action.busy ? 'Inspecting…' : 'Inspect again'}
                        </button>
                      </div>
                      {action.error && (
                        <p className="control-error" role="alert">
                          {action.error}
                          {action.report ? ' Earlier evidence remains historical.' : ''}
                        </p>
                      )}
                      {action.report ? (
                        <SourceReport
                          report={action.report}
                          historical={action.historical}
                          controls={controls}
                        />
                      ) : (
                        <p className="control-meta" role="status">
                          {action.busy
                            ? 'Inspecting local source entrypoints…'
                            : action.available
                              ? 'No source evidence captured.'
                              : 'Local workspace context is unavailable.'}
                        </p>
                      )}
                    </>
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
