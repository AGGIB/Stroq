'use client';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Dialog } from 'radix-ui';
import { X } from 'lucide-react';
import { usePlatform } from '@/components/platform-provider';
import { mcpGovernanceLocation } from '@/lib/mcp-governance-navigation';
import { MCP_GOVERNANCE_ERROR_MESSAGES } from '@/lib/mcp-governance-client';
import { useMcpGovernance } from './use-mcp-governance';
import { McpGovernanceCapturePanel } from './mcp-governance-capture';
import { McpGovernanceReview } from './mcp-governance-review';
import { McpGovernanceHistory } from './mcp-governance-history';
import { McpGovernanceBlock } from './mcp-governance-block';
export function McpGovernanceControls() {
  const location = mcpGovernanceLocation(useSearchParams()),
    { localAccess } = usePlatform();
  const [open, setOpen] = useState(location.open),
    [view, setView] = useState<'capture' | 'history'>(location.view),
    [draft, setDraft] = useState<'deny-all' | null>(location.draft),
    [manual, setManual] = useState(false);
  const linked = manual ? null : location,
    action = useMcpGovernance(open && !linked?.invalid),
    trigger = useRef<HTMLButtonElement | null>(null),
    heading = useRef<HTMLHeadingElement | null>(null),
    container = useRef<HTMLDivElement | null>(null),
    completion = useRef<HTMLParagraphElement | null>(null);
  const mismatch =
    !!linked?.contextId && !!action.state?.contextId && linked.contextId !== action.state.contextId;
  const workspaceMismatch =
    !!linked?.workspaceId && !!action.workspaceId && linked.workspaceId !== action.workspaceId;
  const missing =
    !!linked?.operationId &&
    !!action.state &&
    !action.state.records.some(
      (r) =>
        r.operationId === linked.operationId &&
        r.binding.contextId === linked.contextId &&
        r.binding.workspaceId === linked.workspaceId,
    );
  const blocked = linked?.invalid || mismatch || workspaceMismatch || missing;
  useEffect(() => {
    if (location.open) {
      setOpen(true);
      setView(location.view);
      setDraft(location.draft);
      setManual(false);
    }
  }, [
    location.open,
    location.view,
    location.draft,
    location.contextId,
    location.workspaceId,
    location.operationId,
    location.invalid,
  ]);
  useEffect(() => {
    if (action.completion && action.completion.record.status !== 'unknown')
      completion.current?.focus({ preventScroll: true });
  }, [action.completion?.operationId, action.completion?.record.status]);
  const close = () => {
    action.close();
    setOpen(false);
  };
  return (
    <>
      <button
        ref={trigger}
        className="button"
        disabled={!localAccess}
        onClick={() => {
          setManual(true);
          setView('capture');
          setDraft(null);
          setOpen(true);
        }}
      >
        Govern MCP calls
      </button>
      <Dialog.Root
        open={open}
        onOpenChange={(next) => {
          if (!next) close();
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content
            className="dialog-content mcp-governance-dialog"
            ref={container}
            tabIndex={-1}
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              (linked?.operationId ? container.current : heading.current)?.focus({
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
                  {draft === 'deny-all' ? 'Block MCP calls' : 'Govern MCP calls'}
                </Dialog.Title>
                <Dialog.Description className="control-meta">
                  Reported identities · Stroq hook and proxy boundary
                </Dialog.Description>
              </div>
              <button className="icon-button" onClick={close} aria-label="Close MCP governance">
                <X size={20} />
              </button>
            </div>
            <div className="mcp-governance-body">
              <nav className="mcp-governance-views" aria-label="MCP governance views">
                {(['capture', 'history'] as const).map((v) => (
                  <button
                    key={v}
                    className="button"
                    aria-pressed={view === v}
                    disabled={!!action.busy}
                    onClick={() => {
                      setManual(true);
                      setView(v);
                      action.clearPreview();
                    }}
                  >
                    {v === 'capture'
                      ? draft === 'deny-all'
                        ? 'Block calls'
                        : 'Select identities'
                      : 'History'}
                  </button>
                ))}
              </nav>
              {blocked ? (
                <div className="mcp-governance-notice" role="alert">
                  <p>
                    {linked?.invalid
                      ? 'This MCP governance link is invalid.'
                      : workspaceMismatch
                        ? 'This operation belongs to another workspace. Open that workspace to inspect the exact operation.'
                        : mismatch
                          ? 'This link belongs to another Stroq home.'
                          : 'The exact linked operation is absent from this read. Earlier completion remains unverified.'}
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
                      {MCP_GOVERNANCE_ERROR_MESSAGES[action.state.error]}
                    </p>
                  )}
                  {action.completion && action.completion.record.status !== 'unknown' && (
                    <p
                      ref={completion}
                      tabIndex={-1}
                      className="mcp-governance-completion"
                      role="status"
                    >
                      {action.completion.writeConfirmed
                        ? 'Policy write confirmed. Host adoption remains unverified.'
                        : 'This exact operation did not publish a policy write.'}
                    </p>
                  )}
                  {action.pending.length > 0 && view !== 'history' && (
                    <div className="mcp-governance-notice">
                      <strong>
                        {action.busy === 'apply'
                          ? 'Applying · awaiting confirmation'
                          : `Earlier completion unknown · ${action.pending.length}`}
                      </strong>
                      <button
                        className="inline-link"
                        onClick={() => {
                          setManual(true);
                          setView('history');
                          action.clearPreview();
                        }}
                      >
                        Review saved operations
                      </button>
                    </div>
                  )}
                  {view === 'history' ? (
                    <McpGovernanceHistory action={action} operationId={linked?.operationId} />
                  ) : action.preview ? (
                    <McpGovernanceReview action={action} />
                  ) : draft === 'deny-all' ? (
                    <McpGovernanceBlock
                      action={action}
                      onManage={() => {
                        setDraft(null);
                        setManual(true);
                        action.clearPreview();
                      }}
                    />
                  ) : (
                    <McpGovernanceCapturePanel action={action} />
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
