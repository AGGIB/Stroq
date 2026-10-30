'use client';
import { useRef } from 'react';
import { Dialog } from 'radix-ui';
import { LoaderCircle, X } from 'lucide-react';
import type { useInventoryMonitor } from './use-inventory-monitor';

export function InventoryMonitorPreview({
  action,
  open,
  intent,
  onClose,
  onReturnFocus,
}: {
  action: ReturnType<typeof useInventoryMonitor>;
  open: boolean;
  intent: 'enable' | 'pause';
  onClose: () => void;
  onReturnFocus: () => void;
}) {
  const heading = useRef<HTMLHeadingElement | null>(null),
    busy = action.busy !== null,
    preview = action.preview;
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          className="dialog-content workspace-monitor-dialog"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            heading.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            onReturnFocus();
          }}
        >
          <div className="dialog-header">
            <Dialog.Title ref={heading} tabIndex={-1}>
              {intent === 'enable' ? 'Watch skills & MCP changes' : 'Pause inventory watch'}
            </Dialog.Title>
            <Dialog.Description>
              {intent === 'enable'
                ? 'Fixed project and user sources · local static checks'
                : 'Saved captures remain. An accepted check may finish.'}
            </Dialog.Description>
            <Dialog.Close
              className="dialog-close icon-button"
              aria-label="Close inventory watch preview"
            >
              <X size={18} aria-hidden="true" />
            </Dialog.Close>
          </div>
          <div className="setup-body">
            {action.busy === 'preview' && (
              <p className="control-meta" role="status">
                <LoaderCircle size={18} className="spin" aria-hidden="true" />
                Preparing watch preview…
              </p>
            )}
            {preview && (
              <>
                {preview.action === 'enable' && (
                  <>
                    <label className="policy-ack">
                      <input
                        type="checkbox"
                        checked={action.ack.localChecks}
                        disabled={busy}
                        onChange={(event) =>
                          action.acknowledge('localChecks', event.target.checked)
                        }
                      />
                      <span>
                        Run bounded static checks every 5 minutes while the local console runs. No
                        skills, MCP servers or providers are started.
                      </span>
                    </label>
                    <label className="policy-ack">
                      <input
                        type="checkbox"
                        checked={action.ack.userSources}
                        disabled={busy}
                        onChange={(event) =>
                          action.acknowledge('userSources', event.target.checked)
                        }
                      />
                      <span>
                        Read the six fixed project and personal skill sources and supported MCP
                        configuration. Personal sources are shared across workspaces.
                      </span>
                    </label>
                    <label className="policy-ack">
                      <input
                        type="checkbox"
                        checked={action.ack.retention}
                        disabled={busy}
                        onChange={(event) => action.acknowledge('retention', event.target.checked)}
                      />
                      <span>
                        Retain derived metadata locally, unencrypted: up to 16 observed versions
                        within 8 MiB. Older history may be evicted.
                      </span>
                    </label>
                  </>
                )}
                <p className="control-meta">
                  Preview expires{' '}
                  <time dateTime={preview.expiresAt}>
                    {new Date(preview.expiresAt).toLocaleTimeString('en-GB')}
                  </time>
                  .
                </p>
              </>
            )}
            {action.error && (
              <p className="control-error" role="alert">
                {action.error}
              </p>
            )}
            {action.needsRecheck && (
              <p className="control-error" role="status">
                Completion is unknown. Recheck the saved watch state.
              </p>
            )}
            <div className="dialog-footer">
              <button className="button subtle" onClick={onClose}>
                Close
              </button>
              {action.needsRecheck ? (
                <button className="button" disabled={busy} onClick={action.refresh}>
                  Recheck saved state
                </button>
              ) : preview ? (
                <button
                  className="button primary"
                  disabled={
                    busy ||
                    (preview.action === 'enable' &&
                      (!action.ack.localChecks || !action.ack.userSources || !action.ack.retention))
                  }
                  onClick={async () => {
                    if (await action.apply()) onClose();
                  }}
                >
                  {action.busy === 'apply' && (
                    <LoaderCircle size={16} className="spin" aria-hidden="true" />
                  )}
                  {preview.action === 'enable' ? 'Enable watch' : 'Pause watch'}
                </button>
              ) : (
                <button
                  className="button"
                  disabled={busy}
                  onClick={() => void action.prepare(intent)}
                >
                  Prepare fresh preview
                </button>
              )}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
