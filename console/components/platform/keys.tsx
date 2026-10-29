'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { ArrowRight, LoaderCircle, RefreshCw, Square } from 'lucide-react';
import { usePlatform } from '@/components/platform-provider';
import { Badge, EmptyState, PageHeading, Panel } from '@/components/platform-ui';
import { CopyLocalLink } from '@/components/local-link';
import {
  resolveSecretSelection,
  secretContextMatches,
  secretHref,
  secretSelection,
} from '@/lib/secret-navigation';
import {
  validateSecretScanJob,
  validateSecretScanState,
  type SecretScanJob,
  type SecretScanState,
} from '@/lib/secret-scan';
import { SecretScanDialog } from './secret-scan-dialog';
import { SecretScanResults } from './secret-scan-results';
const ERRORS: Record<string, string> = {
  'engine-unavailable': 'The local scan engine is unavailable.',
  'input-limit': 'A local input exceeded the bounded scan limits.',
  'deadline-exceeded': 'The scan reached its two-minute deadline.',
  'output-limit': 'The scan exceeded the report size limit.',
  'invalid-report': 'The engine returned an unsupported report.',
  'server-stopped': 'The server stopped before the scan finished.',
};
export function KeysPage() {
  const { localAccess, localContext, requestLocal } = usePlatform();
  const selection = secretSelection(useSearchParams());
  const workspaceId = localContext?.workspace.id ?? null;
  const canRead = localAccess && secretContextMatches(selection, workspaceId);
  const [loaded, setLoaded] = useState<{
    workspaceId: string;
    state: SecretScanState;
  } | null>(null);
  const state = canRead && loaded?.workspaceId === workspaceId ? loaded.state : null;
  const [loading, setLoading] = useState(false),
    [canceling, setCanceling] = useState(false),
    [failures, setFailures] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const active = useRef<AbortController | null>(null);
  const load = useCallback(
    async (poll = false) => {
      if (!canRead || !workspaceId) return;
      active.current?.abort();
      const controller = new AbortController();
      active.current = controller;
      const timer = setTimeout(() => controller.abort(), 15_000);
      if (!poll) setLoading(true);
      try {
        const value = await requestLocal('/api/secrets', undefined, controller.signal);
        if (!validateSecretScanState(value)) throw new Error('Unsupported credential scan state.');
        if (active.current === controller) {
          setLoaded({ workspaceId, state: value });
          setFailures(0);
          setError(null);
        }
      } catch (e) {
        if (active.current === controller) {
          setError(
            e instanceof Error && e.name !== 'AbortError'
              ? e.message
              : 'Credential scan connection timed out.',
          );
          if (poll) setFailures((n) => n + 1);
        }
      } finally {
        clearTimeout(timer);
        if (active.current === controller) setLoading(false);
      }
    },
    [canRead, workspaceId, requestLocal],
  );
  useEffect(() => {
    setLoaded(null);
    setError(null);
    setFailures(0);
    setCanceling(false);
    setLoading(false);
    if (canRead) void load();
    return () => {
      active.current?.abort();
      active.current = null;
    };
  }, [load, canRead]);
  const jobs = [...(state?.jobs ?? [])].sort(
    (a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt),
  );
  const resolved = resolveSecretSelection(selection, workspaceId, state ? jobs : null);
  const job = resolved.job;
  const running =
    resolved.status === 'selected' ? jobs.find((job) => job.status === 'running') : undefined;
  const select = (id: string | null, replace = false) => {
    const href = secretHref(id, id ? workspaceId : null);
    if (replace) window.history.replaceState(null, '', href);
    else window.history.pushState(null, '', href);
  };
  useEffect(() => {
    if (canRead && !selection.requested && job && workspaceId)
      window.history.replaceState(null, '', secretHref(job.id, workspaceId));
  }, [canRead, selection.requested, job?.id, workspaceId]);
  useEffect(() => {
    if (!canRead || !running || failures >= 3 || canceling || loading) return;
    const timer = setTimeout(() => void load(true), 1200);
    return () => clearTimeout(timer);
  }, [state, canRead, running?.id, failures, canceling, loading, load]);
  const started = (job: SecretScanJob) => {
    if (!canRead || !workspaceId) return;
    select(job.id);
    setFailures(0);
    setLoaded((current) =>
      current?.workspaceId === workspaceId
        ? { workspaceId, state: { ...current.state, jobs: [...current.state.jobs, job].slice(-8) } }
        : current,
    );
    void load();
  };
  const cancel = async () => {
    if (!canRead || !workspaceId || !running) return;
    setCanceling(true);
    setError(null);
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const value = await requestLocal(
        '/api/secrets/cancel',
        { jobId: running.id },
        controller.signal,
      );
      if (!validateSecretScanJob(value) || value.id !== running.id)
        throw new Error('Unsupported cancellation response.');
      if (active.current === controller)
        setLoaded((current) =>
          current?.workspaceId === workspaceId
            ? {
                workspaceId,
                state: {
                  ...current.state,
                  jobs: current.state.jobs.map((job) => (job.id === value.id ? value : job)),
                },
              }
            : current,
        );
    } catch (e) {
      if (active.current === controller)
        setError(
          e instanceof Error && e.name !== 'AbortError'
            ? e.message
            : 'Cancellation response timed out. Refresh to check the scan.',
        );
    } finally {
      clearTimeout(timer);
      if (active.current === controller) {
        setCanceling(false);
        setLoading(false);
      }
    }
  };
  return (
    <div className="page-stack">
      <PageHeading
        title="Secret exposure"
        actions={
          <>
            {canRead && job && workspaceId && (
              <CopyLocalLink href={secretHref(job.id, workspaceId)} />
            )}
            <button
              className="icon-button"
              aria-label="Refresh credential reports"
              disabled={!canRead || loading || canceling}
              onClick={() => void load()}
            >
              <RefreshCw size={18} className={loading ? 'spin' : undefined} />
            </button>
            <SecretScanDialog
              key={canRead ? workspaceId : 'unavailable'}
              disabled={
                !canRead ||
                !state?.engine.available ||
                jobs.some((item) => item.status === 'running') ||
                loading
              }
              onStarted={started}
              onRefresh={() => void load()}
            />
          </>
        }
      />
      {canRead && error && (
        <p className="control-error" role="alert">
          {error}
          {failures >= 3 ? ' Automatic updates paused. Use refresh to reconnect.' : ''}
        </p>
      )}
      {!localAccess ? (
        <Panel>
          <EmptyState
            title="Connect your local engine"
            description="Credential scans run on this machine after you review access."
          />
          <div className="panel-body">
            <Link href="/settings/" className="button">
              Connection settings
              <ArrowRight size={16} />
            </Link>
          </div>
        </Panel>
      ) : !canRead ? (
        <Panel>
          <EmptyState
            title={
              selection.invalid
                ? 'Invalid report link'
                : !workspaceId
                  ? 'Confirming the local workspace'
                  : 'This report belongs to another workspace'
            }
            description={
              selection.invalid
                ? 'The link needs one report ID and its workspace. Another report has not been substituted.'
                : !workspaceId
                  ? 'Reports load after the connected server identifies its workspace.'
                  : 'Open this link on its original local server, or view reports for the connected workspace.'
            }
          />
          {(selection.invalid || workspaceId) && (
            <div className="panel-body">
              <button className="button" onClick={() => select(null, true)}>
                View this workspace
                <ArrowRight size={16} />
              </button>
            </div>
          )}
        </Panel>
      ) : (
        <>
          {running && (
            <div className="overview-status" role="status">
              <LoaderCircle size={22} className="spin" />
              <div>
                <strong>Comparing recorded sessions</strong>
                <span>Credential values are not included in the report.</span>
              </div>
              <button className="button" disabled={canceling} onClick={() => void cancel()}>
                <Square size={14} />
                {canceling ? 'Cancelling…' : 'Cancel scan'}
              </button>
            </div>
          )}
          {(jobs.length > 1 || (jobs.length === 1 && resolved.status === 'missing')) && (
            <div className="secret-history">
              <label htmlFor="secret-history">Report</label>
              <select
                id="secret-history"
                className="select-field"
                value={job?.id ?? ''}
                onChange={(e) => select(e.target.value)}
              >
                {!job && (
                  <option value="" disabled>
                    Select an available report
                  </option>
                )}
                {jobs.map((item) => (
                  <option key={item.id} value={item.id}>
                    {new Date(item.startedAt).toLocaleString('en-GB')} · {item.status}
                  </option>
                ))}
              </select>
            </div>
          )}
          {resolved.status === 'missing' ? (
            <Panel>
              <EmptyState
                title="This report is no longer available"
                description="The requested report is absent from this server. Only the latest eight reports remain in memory; restarting the server clears them."
              />
              <div className="panel-body">
                <button className="button" onClick={() => select(null, true)}>
                  View available reports
                  <ArrowRight size={16} />
                </button>
              </div>
            </Panel>
          ) : job?.status === 'completed' && job.result ? (
            <SecretScanResults key={job.id} report={job.result} />
          ) : job?.status === 'failed' || job?.status === 'cancelled' ? (
            <Panel title={job.status === 'cancelled' ? 'Scan cancelled' : 'Scan did not complete'}>
              <div className="panel-body">
                <p className="muted">
                  {job.status === 'cancelled'
                    ? 'No completed report was accepted.'
                    : (ERRORS[job.error ?? ''] ??
                      'The credential comparison could not complete. No report was accepted.')}
                </p>
              </div>
            </Panel>
          ) : (
            !running && (
              <Panel>
                <EmptyState
                  title={
                    error && !state
                      ? 'Reports could not be loaded'
                      : loading || resolved.status === 'loading'
                        ? 'Loading scan reports'
                        : state?.engine.available === false
                          ? 'Local scan engine unavailable'
                          : 'Check what appears in agent sessions'
                  }
                  description={
                    error && !state
                      ? 'Refresh to reconnect. No other report has been substituted.'
                      : state?.engine.available === false
                        ? 'Build the local engine, then refresh this page.'
                        : 'Review access and start a scan. Opening this page does not read credential values or session files.'
                  }
                />
              </Panel>
            )
          )}
          <p className="control-meta">
            <Badge tone="muted">Historical evidence</Badge>Recorded routes do not prove delivery or
            live blocking. Scans make no provider requests.
          </p>
          <p className="control-meta">
            Reports stay in server memory, up to eight, until restart. Export a report to keep it.
          </p>
        </>
      )}
    </div>
  );
}
