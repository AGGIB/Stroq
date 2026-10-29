'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { ArrowLeft, ArrowRight, LoaderCircle, RefreshCw } from 'lucide-react';
import { usePlatform } from '@/components/platform-provider';
import {
  AgentGlyph,
  Badge,
  EmptyState,
  ExportButton,
  PageHeading,
  Panel,
} from '@/components/platform-ui';
import { CopyLocalLink } from '@/components/local-link';
import { AGENT_NAMES } from '@/lib/agent-status';
import {
  LIVE_JOB_LIMIT,
  updateLiveJobs,
  validateLiveState,
  type LiveJob,
  type LiveState,
} from '@/lib/live-proof';
import {
  liveHref,
  liveReadAllowed,
  liveSelection,
  resolveLiveSelection,
} from '@/lib/live-navigation';
import { LiveProofDialog } from './live-proof';
import { LiveProofResult } from './live-proof-results';

const time = (stamp: string) => new Date(stamp).toLocaleString('en-GB');

export function LiveChecksPage() {
  const params = useSearchParams();
  const selection = liveSelection(params);
  const { localAccess, localContext, requestLocal } = usePlatform();
  const workspaceId = localContext?.workspace.id ?? null;
  const canRead = localAccess && liveReadAllowed(selection, workspaceId);
  const [snapshot, setSnapshot] = useState<{ workspaceId: string; value: LiveState } | null>(null);
  const state = canRead && snapshot?.workspaceId === workspaceId ? snapshot.value : null;
  const [loading, setLoading] = useState(false);
  const [failures, setFailures] = useState(0);
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
        const value = await requestLocal('/api/live', undefined, controller.signal);
        if (!validateLiveState(value)) throw new Error('Unsupported blocking-check history.');
        if (active.current === controller) {
          setSnapshot({ workspaceId, value });
          setError(null);
          setFailures(0);
        }
      } catch {
        if (active.current === controller) {
          setError(
            'Blocking-check history could not be refreshed. Previously loaded evidence may be out of date.',
          );
          if (poll) setFailures((count) => count + 1);
        }
      } finally {
        clearTimeout(timer);
        if (active.current === controller) setLoading(false);
      }
    },
    [canRead, workspaceId, requestLocal],
  );
  useEffect(() => {
    setSnapshot(null);
    setError(null);
    setFailures(0);
    setLoading(false);
    void load();
    return () => {
      active.current?.abort();
      active.current = null;
    };
  }, [load]);
  const running = state?.jobs.some((job) => job.status === 'running');
  useEffect(() => {
    if (!canRead || !running || loading || failures >= 3) return;
    const timer = setTimeout(() => void load(true), 1500 * (failures + 1));
    return () => clearTimeout(timer);
  }, [canRead, running, loading, failures, state, load]);
  const updateJob = useCallback(
    (job: LiveJob) => {
      setSnapshot((current) =>
        current?.workspaceId === workspaceId
          ? {
              ...current,
              value: {
                ...current.value,
                jobs: updateLiveJobs(current.value.jobs, job),
              },
            }
          : current,
      );
      // Completion also changes the separate stored-proof view. Do one final read.
      if (job.status !== 'running') void load();
    },
    [workspaceId, load],
  );
  const resolved = resolveLiveSelection(selection, state, workspaceId);
  const selectedAgent =
    resolved.kind === 'job' ? resolved.job.agent : (selection.agent ?? 'claude-code');
  const jobs = [...(state?.jobs ?? [])].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const exportJob = resolved.kind === 'job' ? resolved.job : null;
  return (
    <div className="page-stack">
      <PageHeading
        title="Blocking checks"
        actions={
          <>
            <Link href="/agents/" className="button subtle">
              <ArrowLeft size={16} />
              Agents
            </Link>
            <button
              className="icon-button"
              aria-label="Refresh blocking checks"
              disabled={!canRead || loading}
              onClick={() => void load()}
            >
              <RefreshCw size={18} className={loading ? 'spin' : undefined} />
            </button>
            {canRead && (
              <LiveProofDialog
                key={selectedAgent}
                agent={selectedAgent}
                label="Run check"
                onJob={updateJob}
              />
            )}
          </>
        }
      />
      <nav className="filter-tabs hook-history-tabs" aria-label="Check history type">
        <Link href="/agents/hooks/">Stroq hook</Link>
        <Link className="is-active" aria-current="page" href="/agents/checks/">
          In-agent
        </Link>
      </nav>
      {error && (
        <p className="control-error" role="alert">
          {error}
          {failures >= 3 ? ' Automatic updates paused. Refresh to reconnect.' : ''}
        </p>
      )}
      {resolved.kind === 'invalid' || resolved.kind === 'workspace-mismatch' ? (
        <Panel>
          <EmptyState
            title={resolved.kind === 'invalid' ? 'Invalid check link' : 'Different workspace'}
            description="Open blocking-check history in this workspace to select a report."
          />
          <div className="panel-body">
            <Link href="/agents/checks/" className="button">
              Open local history
              <ArrowRight size={16} />
            </Link>
          </div>
        </Panel>
      ) : !localAccess || resolved.kind === 'disconnected' ? (
        <Panel>
          <EmptyState
            title="Connect your local engine"
            description="Use the private server link to read blocking-check history."
          />
          <div className="panel-body">
            <Link href="/settings/" className="button">
              Connection settings
              <ArrowRight size={16} />
            </Link>
          </div>
        </Panel>
      ) : (
        <>
          {resolved.kind === 'loading' && (
            <Panel>
              <EmptyState
                title={loading ? 'Loading checks' : 'Check history unavailable'}
                description="No new test is started when you open this page."
              />
            </Panel>
          )}
          {resolved.kind === 'missing-job' && (
            <Panel>
              <EmptyState
                title="This attempt is no longer retained"
                description={`The server keeps up to ${LIVE_JOB_LIMIT} attempts in memory. Restarting it clears that history. No other result has been substituted.`}
              />
            </Panel>
          )}
          {resolved.kind === 'missing-proof' && (
            <Panel>
              <EmptyState
                title="No stored proof for this agent"
                description="An isolated check requires an explicit preview and subscription consent."
              />
            </Panel>
          )}
          {resolved.kind === 'job' && (
            <Panel
              title={AGENT_NAMES[resolved.job.agent]}
              actions={
                <>
                  <CopyLocalLink href={liveHref({ jobId: resolved.job.id, workspaceId })} />
                  <ExportButton
                    filename="stroq-blocking-check.json"
                    data={() => ({
                      schema: 'stroq-blocking-check-export/1',
                      exportedAt: new Date().toISOString(),
                      workspaceId,
                      target: 'isolated-host',
                      job: exportJob && {
                        id: exportJob.id,
                        agent: exportJob.agent,
                        status: exportJob.status,
                        startedAt: exportJob.startedAt,
                        finishedAt: exportJob.finishedAt,
                        maxRequests: exportJob.maxRequests,
                        result: exportJob.result,
                      },
                    })}
                  />
                </>
              }
            >
              <div className="panel-body live-check-detail">
                <p className="control-meta">
                  <Badge tone={resolved.job.status === 'failed' ? 'orange' : 'muted'}>
                    {resolved.job.status}
                  </Badge>
                  Started {time(resolved.job.startedAt)} · limit {resolved.job.maxRequests} requests
                </p>
                {resolved.job.status === 'completed' && resolved.job.result ? (
                  <LiveProofResult report={resolved.job.result} />
                ) : resolved.job.status === 'running' ? (
                  <p className="control-meta" role="status">
                    <LoaderCircle size={18} className="spin" />
                    Check is running. Use Run check to inspect or cancel it.
                  </p>
                ) : (
                  <p className="info-note">
                    {resolved.job.status === 'cancelled'
                      ? 'This attempt was cancelled.'
                      : 'This attempt did not complete.'}{' '}
                    Blocking was not established.
                  </p>
                )}
              </div>
            </Panel>
          )}
          {resolved.kind === 'proof' && (
            <Panel title={`${AGENT_NAMES[resolved.agent]} · latest stored proof`}>
              <div className="panel-body live-check-detail">
                <p className="control-meta">
                  <Badge tone="muted">Historical: {resolved.proof.state}</Badge>Recorded{' '}
                  {time(resolved.proof.checkedAt)}. The current host version is unverified.
                </p>
                <LiveProofResult report={resolved.proof.report} />
              </div>
            </Panel>
          )}
          {state && (
            <Panel
              title="Recent attempts"
              subtitle={`Up to ${LIVE_JOB_LIMIT} attempts · this server session`}
            >
              {jobs.length ? (
                <div className="table-scroll">
                  <table className="data-table live-check-table">
                    <thead>
                      <tr>
                        <th>Agent</th>
                        <th>Started</th>
                        <th>Attempt</th>
                        <th>
                          <span className="sr-only">Open report</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {jobs.map((job) => (
                        <tr key={job.id} aria-selected={selection.jobId === job.id}>
                          <td>
                            <span className="table-agent">
                              <AgentGlyph name={AGENT_NAMES[job.agent]} />
                              {AGENT_NAMES[job.agent]}
                            </span>
                          </td>
                          <td>{time(job.startedAt)}</td>
                          <td>
                            <Badge
                              tone={
                                job.status === 'failed' || job.result?.state === 'failed'
                                  ? 'orange'
                                  : 'muted'
                              }
                            >
                              {job.status === 'completed'
                                ? (job.result?.state ?? job.status)
                                : job.status}
                            </Badge>
                          </td>
                          <td>
                            <Link
                              className="button subtle small"
                              href={liveHref({ jobId: job.id, workspaceId })}
                              aria-label={`Open ${AGENT_NAMES[job.agent]} attempt from ${time(job.startedAt)}`}
                            >
                              Open
                              <ArrowRight size={14} />
                            </Link>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <EmptyState
                  title="No attempts in this server session"
                  description="Stored proof below is separate from in-memory attempt history."
                />
              )}
            </Panel>
          )}
          {state && (
            <Panel
              title="Stored proof"
              subtitle="Latest per agent · host version has not been rechecked"
            >
              <div className="live-stored-list">
                {state.agents.map((agent) => (
                  <div key={agent.id}>
                    <span className="table-agent">
                      <AgentGlyph name={AGENT_NAMES[agent.id]} />
                      {AGENT_NAMES[agent.id]}
                    </span>
                    <p className="control-meta">
                      {agent.proof
                        ? `${time(agent.proof.checkedAt)} · ${agent.proof.state}`
                        : 'No stored check'}
                      {!agent.supported ? ' · live driver unavailable' : ''}
                    </p>
                    {agent.proof && (
                      <Link
                        href={liveHref({ agent: agent.id, workspaceId })}
                        className="button subtle small"
                      >
                        View proof
                        <ArrowRight size={14} />
                      </Link>
                    )}
                  </div>
                ))}
              </div>
            </Panel>
          )}
          <p className="control-meta">
            Isolated host checks do not establish current workspace enforcement. Opening this page
            reads existing reports only.
          </p>
        </>
      )}
    </div>
  );
}
