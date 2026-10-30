'use client';
import { useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { Dialog } from 'radix-ui';
import { LoaderCircle, Play, ShieldCheck, Square, X } from 'lucide-react';
import { usePlatform } from '@/components/platform-provider';
import { Badge } from '@/components/platform-ui';
import { AGENT_NAMES } from '@/lib/agent-status';
import {
  validateLiveState,
  validateLivePreview,
  validateLiveJob,
  latestLiveJob,
  type LiveAgent,
  type LiveState,
  type LivePreview,
  type LiveJob,
} from '@/lib/live-proof';
import { LiveProofResult } from './live-proof-results';
const REASONS: Record<string, string> = {
  'platform-unmeasured': 'This agent has no measured driver on this operating system.',
  'driver-unavailable': 'A live driver is not available for this agent.',
  'host-not-found': 'The agent could not be found or its version could not be read.',
  'engine-unavailable': 'Build the local Stroq engine to run this check.',
};
export function LiveProofDialog({
  agent = 'claude-code',
  label = 'Test blocking',
  onJob,
}: {
  agent?: LiveAgent;
  label?: string;
  onJob?: (job: LiveJob) => void;
}) {
  const { localAccess, requestLocal } = usePlatform();
  const [open, setOpen] = useState(false),
    [selected, setSelected] = useState<LiveAgent>(agent),
    [budget, setBudget] = useState(3),
    [ack, setAck] = useState(false);
  const [state, setState] = useState<LiveState | null>(null),
    [preview, setPreview] = useState<LivePreview | null>(null),
    [job, setJob] = useState<LiveJob | null>(null);
  const [busy, setBusy] = useState<'load' | 'preview' | 'start' | 'cancel' | null>(null),
    [error, setError] = useState<string | null>(null),
    [pollFailures, setPollFailures] = useState(0);
  const mounted = useRef(true);
  const id = useId();
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!open || !localAccess) return;
    let active = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    setBusy('load');
    setError(null);
    void requestLocal('/api/live', undefined, controller.signal)
      .then((value) => {
        if (!validateLiveState(value)) throw new Error('Unsupported live-test state.');
        if (active) {
          setState(value);
          setJob(latestLiveJob(value.jobs, selected));
          setPollFailures(0);
        }
      })
      .catch((e) => {
        if (active)
          setError(
            e instanceof Error && e.name !== 'AbortError'
              ? e.message
              : 'Live-test connection timed out.',
          );
      })
      .finally(() => {
        clearTimeout(timer);
        if (active) setBusy(null);
      });
    return () => {
      active = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, localAccess, requestLocal]);
  useEffect(() => {
    if (!open || job?.status !== 'running' || pollFailures >= 3) return;
    const controller = new AbortController();
    let active = true;
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const timer = setTimeout(
      () => {
        void requestLocal(`/api/live/jobs/${job.id}`, undefined, controller.signal)
          .then((value) => {
            if (!validateLiveJob(value)) throw new Error('Unsupported live-test report.');
            if (active) {
              setJob(value);
              onJob?.(value);
              setPollFailures(0);
            }
          })
          .catch((e) => {
            if (active) {
              setError(
                e instanceof Error && e.name !== 'AbortError'
                  ? e.message
                  : 'Connection timed out. The test may still be running.',
              );
              setPollFailures((n) => n + 1);
            }
          });
      },
      1500 * (pollFailures + 1),
    );
    return () => {
      active = false;
      clearTimeout(timer);
      clearTimeout(timeout);
      controller.abort();
    };
  }, [open, job, pollFailures, requestLocal, onJob]);
  const execute = async (action: 'preview' | 'start' | 'cancel') => {
    if (busy) return;
    setBusy(action);
    setError(null);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25_000);
    try {
      const input =
        action === 'preview'
          ? { agent: selected, maxRequests: budget }
          : action === 'start'
            ? {
                previewId: preview?.id,
                acknowledgeSubscriptionUsage: true,
                maxRequests: preview?.maxRequests,
              }
            : { jobId: job?.id };
      const value = await requestLocal(`/api/live/${action}`, input, controller.signal);
      if (action === 'preview') {
        if (!validateLivePreview(value))
          throw new Error('Unsupported preview. A test cannot be started.');
        if (mounted.current) {
          setPreview(value);
          setAck(false);
          setJob(null);
        }
      } else {
        if (!validateLiveJob(value))
          throw new Error(
            'The acknowledgement could not be verified. Reopen the dialog before retrying.',
          );
        if (mounted.current) {
          setJob(value);
          onJob?.(value);
          setPreview(null);
          setPollFailures(0);
        }
      }
    } catch (e) {
      if (mounted.current)
        setError(
          e instanceof Error && e.name !== 'AbortError'
            ? e.message
            : 'No acknowledgement received. Reopen the dialog to check whether the test is running.',
        );
    } finally {
      clearTimeout(timer);
      if (mounted.current) setBusy(null);
    }
  };
  const activeJob = job?.status === 'running';
  const support = state?.agents.find((a) => a.id === selected);
  const reset = () => {
    setPreview(null);
    setAck(false);
    setJob(null);
    setError(null);
  };
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(value) => {
        if (!busy) {
          if (value) reset();
          setOpen(value);
        }
      }}
    >
      <Dialog.Trigger asChild>
        <button className="button subtle small">
          <ShieldCheck size={15} aria-hidden="true" />
          {label}
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content live-dialog">
          <div className="dialog-header">
            <Dialog.Title>Test real blocking</Dialog.Title>
            <Dialog.Description>Isolated host check · temporary project</Dialog.Description>
            <Dialog.Close
              className="dialog-close icon-button"
              aria-label="Close blocking test"
              disabled={Boolean(busy)}
            >
              <X size={18} />
            </Dialog.Close>
          </div>
          {error && (
            <p className="control-error" role="alert">
              {error}
            </p>
          )}
          {!localAccess ? (
            <p className="muted">Open the private server link to connect your local engine.</p>
          ) : (
            <>
              {!activeJob && (
                <div className="setup-selects">
                  <div>
                    <label htmlFor={`${id}-agent`}>Agent</label>
                    <select
                      className="select-field"
                      id={`${id}-agent`}
                      value={selected}
                      disabled={Boolean(busy)}
                      onChange={(e) => {
                        setSelected(e.target.value as LiveAgent);
                        reset();
                        setJob(latestLiveJob(state?.jobs ?? [], e.target.value as LiveAgent));
                      }}
                    >
                      {Object.entries(AGENT_NAMES).map(([key, name]) => (
                        <option key={key} value={key}>
                          {name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label htmlFor={`${id}-budget`}>Request limit</label>
                    <select
                      className="select-field"
                      id={`${id}-budget`}
                      value={budget}
                      disabled={Boolean(busy)}
                      onChange={(e) => {
                        setBudget(Number(e.target.value));
                        reset();
                      }}
                    >
                      {[3, 4, 5, 6].map((n) => (
                        <option key={n} value={n}>
                          Up to {n} requests
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              )}
              {busy === 'load' && (
                <div className="control-empty">
                  <LoaderCircle className="spin" size={25} />
                  <p>Reading test support…</p>
                </div>
              )}
              {support && !support.supported && (
                <p className="info-note">
                  {REASONS[support.reason ?? ''] ?? 'This agent cannot be tested on this machine.'}
                </p>
              )}
              {!preview && !job && support?.proof && (
                <div className="live-history">
                  <div className="live-result-heading">
                    <strong>Historical isolated check</strong>
                    <Badge tone="muted">{support.proof.state}</Badge>
                  </div>
                  <p className="control-meta">
                    {new Date(support.proof.checkedAt).toLocaleString('en-GB')} · host version has
                    not been rechecked
                  </p>
                  <LiveProofResult report={support.proof.report} />
                </div>
              )}
              {preview && (
                <div className="live-preview">
                  <Badge tone="muted">Preview · no inference requested</Badge>
                  <dl className="property-list">
                    <div>
                      <dt>Host</dt>
                      <dd>
                        {AGENT_NAMES[preview.agent]} {preview.hostVersion ?? 'version unknown'}
                      </dd>
                    </div>
                    <div>
                      <dt>Scope</dt>
                      <dd>Temporary isolated project</dd>
                    </div>
                    <div>
                      <dt>Checks</dt>
                      <dd>
                        Allow, deny, unguarded control
                        {preview.disclosure.optionalSecretEgress ? ', secret egress' : ''}
                      </dd>
                    </div>
                    <div>
                      <dt>Subscription usage</dt>
                      <dd>Up to {preview.maxRequests} real requests</dd>
                    </div>
                  </dl>
                  {!preview.canStart && (
                    <p className="control-error">
                      {REASONS[preview.reason ?? ''] ??
                        'This test cannot start with the current environment.'}
                    </p>
                  )}
                  {preview.canStart && (
                    <p className="control-meta">
                      {preview.agent === 'codex'
                        ? 'Codex runs fixed probes without its sandbox and bypasses hook trust. Pay-as-you-go credits are not detected; user instructions or skills may still reach the host.'
                        : 'Claude Code may record the run in its own files.'}{' '}
                      The temporary test folder is removed afterward.
                    </p>
                  )}
                  {preview.canStart && (
                    <label className="policy-ack">
                      <input
                        type="checkbox"
                        checked={ack}
                        onChange={(e) => setAck(e.target.checked)}
                        disabled={Boolean(busy)}
                      />
                      <span>
                        I agree to use my agent subscription for up to {preview.maxRequests}{' '}
                        requests to the agent provider.
                      </span>
                    </label>
                  )}
                </div>
              )}
              {activeJob && (
                <div className="control-empty" role="status">
                  <LoaderCircle className="spin" size={28} />
                  <h3>Testing {AGENT_NAMES[job.agent]}</h3>
                  <p>Up to {job.maxRequests} requests · allow, deny and control evidence</p>
                  <p>Closing this dialog keeps the test running. Cancel to stop it.</p>
                  {pollFailures >= 3 && (
                    <button
                      className="button"
                      onClick={() => {
                        setPollFailures(0);
                        setError(null);
                      }}
                    >
                      Reconnect
                    </button>
                  )}
                </div>
              )}
              {job?.status === 'completed' && job.result && (
                <>
                  <p className="control-meta">
                    Result recorded {new Date(job.finishedAt!).toLocaleString('en-GB')}
                  </p>
                  <LiveProofResult report={job.result} />
                </>
              )}
              {job && ['failed', 'cancelled'].includes(job.status) && (
                <p className="control-error">
                  {job.status === 'cancelled'
                    ? 'Test cancelled. Blocking was not established.'
                    : 'The test did not complete. Blocking was not established.'}
                </p>
              )}
              <div className="dialog-footer">
                <Link
                  href="/agents/checks/"
                  className="button subtle"
                  aria-disabled={Boolean(busy)}
                  tabIndex={busy ? -1 : undefined}
                  onClick={(event) => {
                    if (busy) event.preventDefault();
                    else setOpen(false);
                  }}
                >
                  Check history
                </Link>
                {activeJob ? (
                  <button
                    className="button"
                    disabled={Boolean(busy)}
                    onClick={() => void execute('cancel')}
                  >
                    <Square size={14} />
                    Cancel test
                  </button>
                ) : preview?.canStart ? (
                  <button
                    className="button primary"
                    disabled={Boolean(busy) || !ack}
                    onClick={() => void execute('start')}
                  >
                    {busy ? <LoaderCircle className="spin" size={16} /> : <Play size={16} />}Start
                    live check
                  </button>
                ) : (
                  <button
                    className="button primary"
                    disabled={Boolean(busy) || !state?.engine.available || !support?.supported}
                    onClick={() => void execute('preview')}
                  >
                    {busy ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />}
                    Preview live check
                  </button>
                )}
              </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
