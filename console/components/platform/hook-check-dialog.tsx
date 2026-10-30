'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Dialog } from 'radix-ui';
import { FlaskConical, LoaderCircle, Play, RefreshCw, Square, X } from 'lucide-react';
import { AgentGlyph, Badge } from '@/components/platform-ui';
import { AGENT_NAMES, type AgentId } from '@/lib/agent-status';
import type { HookCheckScope } from '@/lib/hook-checks';
import { useHookChecks } from './use-hook-checks';
import { hookCheckHref } from '@/lib/hook-check-navigation';
import {
  HookCheckResult,
  HookCheckBindingDetails,
  HOOK_CHECK_REASONS,
  hookCheckTime,
} from './hook-check-results';

export function HookCheckDialog({
  agent,
  scope,
  generation = 0,
  expectedWorkspaceId,
  expectedSourceSha256,
  selectedJobId,
  label = 'Test Stroq hook',
  onChanged,
}: {
  agent: AgentId;
  scope: HookCheckScope;
  generation?: number;
  expectedWorkspaceId?: string;
  expectedSourceSha256?: string;
  selectedJobId?: string;
  label?: string;
  onChanged?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const heading = useRef<HTMLHeadingElement | null>(null);
  const action = useHookChecks({
    open,
    agent,
    scope,
    generation,
    expectedWorkspaceId,
    expectedSourceSha256,
    selectedJobId,
  });
  const preview = action.preview;
  const job = action.job;
  const support = action.state?.agents.find((item) => item.id === agent);
  const running = action.state?.jobs.find((item) => item.status === 'running');
  const working = action.busy !== null && action.busy !== 'poll';
  const disabled =
    working || action.needsRecheck || action.sourceMismatch || action.contextMismatch || action.gap;
  const resultHref = job
    ? hookCheckHref({ workspaceId: job.binding.workspaceId, jobId: job.id })
    : null;
  const close = () => {
    action.invalidate();
    setOpen(false);
    onChanged?.();
  };
  useEffect(() => {
    if (preview || (job && job.status !== 'running')) heading.current?.focus();
  }, [preview, job]);
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(value) => {
        if (value) setOpen(true);
        else close();
      }}
    >
      <Dialog.Trigger asChild>
        <button ref={trigger} className="button small">
          <FlaskConical size={15} aria-hidden="true" />
          {label}
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          className="dialog-content setup-dialog live-dialog"
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
              Test Stroq hook
            </Dialog.Title>
            <Dialog.Description>Offline · no provider requests</Dialog.Description>
            <Dialog.Close
              className="dialog-close icon-button"
              aria-label="Close offline hook check"
            >
              <X size={18} />
            </Dialog.Close>
          </div>
          <div className="setup-body">
            <div className="setup-preview-heading">
              <AgentGlyph name={AGENT_NAMES[agent]} />
              <strong>{AGENT_NAMES[agent]}</strong>
              <Badge tone="muted">
                {scope === 'user' ? 'User hook source' : 'Workspace hook source'}
              </Badge>
            </div>
            {action.error && (
              <p className="control-error" role="alert">
                {action.error}
              </p>
            )}
            {(action.sourceMismatch || action.contextMismatch) && (
              <p className="control-error" role="alert">
                {action.contextMismatch
                  ? 'This link belongs to another workspace.'
                  : 'The hook source differs from the setup receipt. This handoff cannot start a test.'}{' '}
                <Link className="inline-link" href="/agents/" onClick={close}>
                  Open current Agents
                </Link>
              </p>
            )}
            {action.needsRecheck && (
              <p className="control-meta" role="status">
                Completion is unknown. Recheck history before another test.
              </p>
            )}
            {(action.missingSelection || action.gap) && (
              <p className="control-error">
                This attempt is no longer retained. No other result has been substituted.
              </p>
            )}
            {!action.workspaceId ? (
              <p className="muted">Use the private server link to connect your local engine.</p>
            ) : action.busy === 'load' || action.busy === 'recheck' ? (
              <p className="control-meta" role="status">
                <LoaderCircle size={18} className="spin" aria-hidden="true" />
                Reading hook-check history…
              </p>
            ) : (
              <>
                {action.state && !action.state.engine.available && (
                  <p className="control-error">The local Stroq runtime is unavailable.</p>
                )}
                {support && !support.supported && (
                  <p className="control-error">
                    Offline hook checks are unavailable on this platform.
                  </p>
                )}
                {action.state?.history.status === 'disabled' && (
                  <p className="control-meta">
                    Attempts are retained for this server session only.
                  </p>
                )}
                {preview && (
                  <div className="live-preview">
                    <div className="live-result-heading">
                      <strong>2 hook probes</strong>
                      <Badge tone="muted">Preview</Badge>
                    </div>
                    {preview.canStart && preview.binding ? (
                      <>
                        <p className="control-meta">
                          An ordinary action and an encoded fetch, in isolated temporary files
                        </p>
                        <p className="control-meta">
                          Uses the captured Stroq policy. No agent or probe command is launched.
                        </p>
                        <HookCheckBindingDetails binding={preview.binding} />
                      </>
                    ) : (
                      <p className="control-error">
                        {preview.reason
                          ? HOOK_CHECK_REASONS[preview.reason]
                          : 'This hook cannot be tested in the selected scope.'}
                      </p>
                    )}
                  </div>
                )}
                {job?.status === 'running' && (
                  <div className="control-empty" role="status">
                    <LoaderCircle size={26} className="spin" aria-hidden="true" />
                    <h3>Testing hook responses</h3>
                    <p>2 isolated probes · 0 provider requests</p>
                    <p className="control-meta">
                      Closing keeps the test running. Cancel to stop it.
                    </p>
                  </div>
                )}
                {job?.status === 'completed' && <HookCheckResult job={job} />}
                {job && (job.status === 'failed' || job.status === 'cancelled') && (
                  <div className="live-history">
                    <strong>
                      {job.status === 'cancelled' ? 'Hook test cancelled' : 'Hook test incomplete'}
                    </strong>
                    <p className="control-error">
                      {HOOK_CHECK_REASONS[job.error ?? 'hook-check-failed']}
                    </p>
                    <p className="control-meta">
                      Recorded {hookCheckTime(job.finishedAt!)} · agent enforcement not tested.
                    </p>
                    <HookCheckBindingDetails binding={job.binding} />
                  </div>
                )}
                {running && (!job || job.id !== running.id) && (
                  <p className="control-meta" role="status">
                    A hook check is running
                    {running.binding.agent !== agent || running.binding.scope !== scope
                      ? ' in another agent or scope'
                      : ''}
                    .
                    {action.jobs.some((item) => item.id === running.id) && (
                      <button
                        className="inline-link"
                        disabled={working}
                        onClick={() => action.selectJob(running)}
                      >
                        Inspect running test
                      </button>
                    )}
                  </p>
                )}
                {action.jobs.length > 0 && (
                  <details className="setup-next">
                    <summary>Recent attempts · {action.jobs.length}</summary>
                    <ul>
                      {action.jobs.map((attempt) => (
                        <li key={attempt.id}>
                          <button
                            className="inline-link"
                            disabled={working}
                            aria-pressed={job?.id === attempt.id}
                            onClick={() => action.selectJob(attempt)}
                          >
                            {hookCheckTime(attempt.startedAt)} ·{' '}
                            {attempt.status === 'completed'
                              ? attempt.result?.status === 'passed'
                                ? 'Probes matched'
                                : 'Needs review'
                              : attempt.status}
                          </button>
                        </li>
                      ))}
                    </ul>
                    <p className="control-meta">
                      Captured results for this agent and scope. They do not establish current agent
                      enforcement.
                    </p>
                  </details>
                )}
              </>
            )}
            <div className="dialog-footer">
              {resultHref && (
                <Link className="button subtle" href={resultHref} onClick={close}>
                  Open recorded result
                </Link>
              )}
              <button
                className="button subtle"
                disabled={!action.workspaceId || working}
                onClick={action.refresh}
              >
                <RefreshCw size={15} aria-hidden="true" />
                {action.needsRecheck || action.pollFailures >= 3
                  ? 'Recheck history'
                  : 'Refresh history'}
              </button>
              {job?.status === 'running' ? (
                <button className="button" disabled={disabled} onClick={() => void action.cancel()}>
                  <Square size={15} aria-hidden="true" />
                  Cancel test
                </button>
              ) : preview?.canStart ? (
                <button
                  className="button primary"
                  disabled={disabled}
                  onClick={() => void action.start()}
                >
                  {action.busy === 'start' ? (
                    <LoaderCircle size={16} className="spin" aria-hidden="true" />
                  ) : (
                    <Play size={16} aria-hidden="true" />
                  )}
                  Start offline test
                </button>
              ) : (
                <button
                  className="button primary"
                  disabled={
                    disabled ||
                    !action.state?.engine.available ||
                    !support?.supported ||
                    Boolean(running)
                  }
                  onClick={() => void action.prepare()}
                >
                  {action.busy === 'preview' ? (
                    <LoaderCircle size={16} className="spin" aria-hidden="true" />
                  ) : (
                    <FlaskConical size={16} aria-hidden="true" />
                  )}
                  Preview hook test
                </button>
              )}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
