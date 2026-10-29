'use client';
import { useRef, useState } from 'react';
import Link from 'next/link';
import { Dialog } from 'radix-ui';
import { ArrowUpRight, LoaderCircle, Pause, Radar, RefreshCw, X } from 'lucide-react';
import { Badge } from '@/components/platform-ui';
import { WORKSPACE_MONITOR_LIMITATIONS } from '@/lib/workspace-monitor';
import { workspaceReviewHref } from '@/lib/workspace-review-navigation';
import { useWorkspaceMonitor } from './use-workspace-monitor';

const STATUS_LABELS = {
  disabled: 'Off',
  enabled: 'Watching',
  'in-use': 'In use',
  stopped: 'Stopped',
  'needs-review': 'Needs review',
  unavailable: 'Unavailable',
} as const;
const STATE_MESSAGES: Partial<Record<string, string>> = {
  'monitor-store-invalid': 'Saved watch state could not be verified. Checks are stopped.',
  'monitor-store-unavailable': 'Private watch storage could not be read. Checks are stopped.',
  'runtime-unavailable': 'The local analysis runtime is unavailable.',
  'context-unavailable': 'The workspace identity could not be verified.',
  'monitor-in-use': 'This workspace watch is running in another local console.',
  'history-unavailable': 'Saved workspace history could not be verified.',
  'baseline-unavailable': 'The reviewed workspace baseline could not be verified.',
};
function MonitorTime({ at }: { at: string }) {
  return <time dateTime={at}>{new Date(at).toLocaleString('en-GB')}</time>;
}
export function WorkspaceMonitor() {
  const action = useWorkspaceMonitor();
  const { state, preview } = action;
  const [open, setOpen] = useState(false);
  const [intent, setIntent] = useState<'enable' | 'pause'>('enable');
  const trigger = useRef<HTMLButtonElement | null>(null);
  const heading = useRef<HTMLHeadingElement | null>(null);
  const busy = action.busy !== null;
  const canEnable =
    !!state?.runtimeSha256 &&
    ['disabled', 'enabled', 'needs-review'].includes(state.status) &&
    !busy &&
    !action.needsRecheck;
  const needsReview = state?.status === 'needs-review';
  const canPause =
    !!state?.revision &&
    ['enabled', 'needs-review', 'in-use', 'unavailable'].includes(state.status) &&
    !busy &&
    !action.needsRecheck;
  const watching =
    !!state?.revision &&
    ['enabled', 'needs-review', 'in-use', 'unavailable'].includes(state.status);
  const prepare = (next: 'enable' | 'pause') => {
    setIntent(next);
    setOpen(true);
    void action.prepare(next);
  };
  const close = () => {
    action.invalidate();
    setOpen(false);
  };
  const status = action.needsRecheck
    ? 'Recheck required'
    : state
      ? state.status === 'enabled' && (state.activeRunId || state.lastAttempt?.status === 'running')
        ? 'Checking'
        : state.status === 'enabled' && state.lastAttempt?.status === 'skipped'
          ? 'Waiting'
          : STATUS_LABELS[state.status]
      : 'Unavailable';
  return (
    <section className="workspace-monitor" aria-label="Workspace change watch">
      <div className="workspace-monitor-heading">
        <div className="workspace-monitor-heading-main">
          <Radar size={22} aria-hidden="true" />
          <div>
            <h2>Change watch</h2>
            <p>Every 5 minutes while the local console runs</p>
          </div>
          <Badge
            tone={
              action.needsRecheck || needsReview || state?.lastAttempt?.status === 'failed'
                ? 'orange'
                : 'muted'
            }
          >
            {status}
          </Badge>
        </div>
        <div className="workspace-monitor-controls">
          <button
            className="icon-button"
            disabled={!action.workspaceId || busy}
            aria-label={action.needsRecheck ? 'Recheck saved watch state' : 'Refresh watch state'}
            onClick={action.refresh}
          >
            <RefreshCw
              size={17}
              className={action.busy === 'load' ? 'spin' : undefined}
              aria-hidden="true"
            />
          </button>
          {watching && (
            <button
              className="button small"
              disabled={!canPause}
              onClick={(event) => {
                trigger.current = event.currentTarget;
                prepare('pause');
              }}
            >
              <Pause size={16} aria-hidden="true" />
              Pause watch
            </button>
          )}
          {(!watching || needsReview) && (
            <button
              className="button small"
              disabled={!canEnable}
              onClick={(event) => {
                trigger.current = event.currentTarget;
                prepare('enable');
              }}
            >
              <Radar size={16} aria-hidden="true" />
              {needsReview ? 'Review watch' : 'Watch changes'}
            </button>
          )}
        </div>
      </div>
      {(state?.lastAttempt || state?.nextCheckAt) && (
        <div className="workspace-monitor-facts">
          {state.lastAttempt && (
            <span>
              Last attempt <MonitorTime at={state.lastAttempt.startedAt} />
              <span>
                · {state.lastAttempt.status === 'completed' ? 'Recorded' : state.lastAttempt.status}
              </span>
            </span>
          )}
          {state.nextCheckAt && (
            <span>
              Next check <MonitorTime at={state.nextCheckAt} />
            </span>
          )}
          {state.lastAttempt?.runId && (
            <Link
              className="inline-link"
              href={workspaceReviewHref(state.lastAttempt.runId, state.workspaceId)}
            >
              Open recorded check <ArrowUpRight size={15} aria-hidden="true" />
            </Link>
          )}
        </div>
      )}
      {needsReview && (
        <p className="control-meta" role="status">
          The saved watch needs a fresh review before checks resume.
        </p>
      )}
      {state && ['in-use', 'unavailable', 'stopped'].includes(state.status) && (
        <p className="control-meta" role="status">
          {state.reason && STATE_MESSAGES[state.reason]
            ? STATE_MESSAGES[state.reason]
            : state.status === 'stopped'
              ? 'This console is stopping. No future checks are scheduled.'
              : state.status === 'in-use'
                ? 'This workspace watch is running in another local console.'
                : 'Change watch is unavailable. Refresh to verify the current state.'}
        </p>
      )}
      {action.needsRecheck && (
        <p className="control-error" role="status">
          Watch change completion is unknown.{' '}
          <button className="inline-link" disabled={busy} onClick={action.refresh}>
            Recheck saved state
          </button>
        </p>
      )}
      {!open && action.error && (
        <p className="control-error" role="alert">
          {action.error}
        </p>
      )}
      {action.pollStopped && (
        <p className="control-meta" role="status">
          Live updates paused. Refresh watch state to retry.
        </p>
      )}
      <details className="workspace-monitor-limits">
        <summary>Scope & limits</summary>
        <ul>
          {WORKSPACE_MONITOR_LIMITATIONS.map((limit) => (
            <li key={limit}>{limit}</li>
          ))}
        </ul>
      </details>
      <Dialog.Root
        open={open}
        onOpenChange={(value) => {
          if (!value) close();
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
              if (trigger.current?.isConnected) trigger.current.focus();
            }}
          >
            <div className="dialog-header">
              <Dialog.Title ref={heading} tabIndex={-1}>
                {intent === 'enable' ? 'Watch workspace changes' : 'Pause change watch'}
              </Dialog.Title>
              <Dialog.Description>
                {intent === 'enable'
                  ? 'Local static checks · no provider requests'
                  : 'Saved reports remain. Accepted checks may finish.'}
              </Dialog.Description>
              <Dialog.Close
                className="dialog-close icon-button"
                aria-label="Close change watch preview"
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
                    <p className="control-meta">
                      Checks start after enabling, then run every 5 minutes. Changes require a
                      separate review.
                    </p>
                  )}
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
                          Run bounded local static checks while the console runs. No agent, command
                          or MCP server is started.
                        </span>
                      </label>
                      <label className="policy-ack">
                        <input
                          type="checkbox"
                          checked={action.ack.retention}
                          disabled={busy}
                          onChange={(event) =>
                            action.acknowledge('retention', event.target.checked)
                          }
                        />
                        <span>
                          Retain derived checks in private, unencrypted history: up to 32 attempts
                          within 8 MiB, without automatic expiry.
                        </span>
                      </label>
                    </>
                  )}
                  <p className="control-meta">
                    Preview expires <MonitorTime at={preview.expiresAt} />
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
                <button className="button subtle" onClick={close}>
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
                        (!action.ack.localChecks || !action.ack.retention))
                    }
                    onClick={async () => {
                      if (await action.apply()) close();
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
                    disabled={intent === 'pause' ? !canPause : !canEnable}
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
    </section>
  );
}
