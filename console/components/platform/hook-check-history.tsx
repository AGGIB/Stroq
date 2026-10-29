'use client';
import { useRef } from 'react';
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
import { AGENT_NAMES, type AgentId } from '@/lib/agent-status';
import type { HookCheckJob } from '@/lib/hook-checks';
import {
  hookCheckHref,
  parseHookCheckNavigation,
  resolveHookCheckNavigation,
} from '@/lib/hook-check-navigation';
import { useHookCheckHistory } from './use-hook-check-history';
import { HookCheckDialog } from './hook-check-dialog';
import {
  HookCheckBindingDetails,
  HookCheckResult,
  HOOK_CHECK_REASONS,
  hookCheckTime,
} from './hook-check-results';

const outcome = (job: HookCheckJob) =>
  job.status === 'completed'
    ? job.result?.status === 'passed'
      ? 'Probes matched'
      : job.result?.status === 'failed'
        ? 'Hook mismatch'
        : 'Needs review'
    : job.status === 'failed'
      ? 'Incomplete'
      : job.status === 'cancelled'
        ? 'Cancelled'
        : 'Running';

export function HookCheckHistoryPage() {
  const params = useSearchParams();
  const navigation = parseHookCheckNavigation(params.toString());
  const { localAccess, localContext, requestLocal } = usePlatform();
  const workspaceId = localAccess ? (localContext?.workspace.id ?? null) : null;
  const enabled =
    navigation.kind !== 'invalid' &&
    workspaceId !== null &&
    (navigation.kind === 'overview' ||
      ((navigation.kind === 'selection' || navigation.kind === 'job') &&
        navigation.workspaceId === workspaceId));
  const history = useHookCheckHistory({ enabled });
  const state = enabled && history.state?.workspaceId === workspaceId ? history.state : null;
  const resolved = resolveHookCheckNavigation(navigation, workspaceId, state);
  const selection =
    resolved.status === 'selection' || resolved.status === 'job' ? resolved.selection : null;
  const job = resolved.status === 'job' ? resolved.job : null;
  const awaitingAttempt = history.busy && resolved.status === 'missing-run';
  const jobs =
    state?.jobs
      .filter(
        (item) =>
          item.binding.workspaceId === workspaceId &&
          (!selection ||
            (item.binding.agent === selection.agent && item.binding.scope === selection.scope)),
      )
      .toSorted((a, b) => b.startedAt.localeCompare(a.startedAt)) ?? [];
  const current = useRef({ state, navigationKey: params.toString(), localContext, requestLocal });
  current.current = { state, navigationKey: params.toString(), localContext, requestLocal };
  const getReport = () =>
    current.current.state === state &&
    current.current.navigationKey === params.toString() &&
    current.current.localContext === localContext &&
    current.current.requestLocal === requestLocal &&
    job
      ? job
      : null;
  const choose = (agent: AgentId | null, scope: 'project' | 'user') => {
    if (!agent || !workspaceId) return;
    const href = hookCheckHref({ workspaceId, agent, scope });
    if (href) window.history.pushState(null, '', href);
  };
  const unavailable =
    !workspaceId ||
    [
      'invalid',
      'foreign-workspace',
      'context-unavailable',
      'missing-run',
      'history-unavailable',
    ].includes(resolved.status);
  return (
    <div className="page-stack">
      <PageHeading
        title="Stroq hook checks"
        actions={
          <>
            <Link className="button subtle" href="/agents/">
              <ArrowLeft size={16} aria-hidden="true" />
              Agents
            </Link>
            <button
              className="icon-button"
              aria-label="Refresh hook-check history"
              disabled={!enabled || history.busy}
              onClick={history.refresh}
            >
              <RefreshCw
                size={18}
                className={history.busy ? 'spin' : undefined}
                aria-hidden="true"
              />
            </button>
          </>
        }
      />
      <nav className="filter-tabs hook-history-tabs" aria-label="Check history type">
        <Link className="is-active" aria-current="page" href="/agents/hooks/">
          Stroq hook
        </Link>
        <Link href="/agents/checks/">In-agent</Link>
      </nav>
      {history.error && enabled && (
        <p className="control-error" role="alert">
          {history.error}
        </p>
      )}
      {awaitingAttempt ? (
        <Panel>
          <div className="control-empty" role="status">
            <LoaderCircle size={24} className="spin" aria-hidden="true" />
            <p>Reading recorded attempt…</p>
          </div>
        </Panel>
      ) : unavailable ? (
        <Panel>
          <EmptyState
            title={
              resolved.status === 'invalid'
                ? 'Invalid hook-check link'
                : resolved.status === 'foreign-workspace'
                  ? 'Different workspace'
                  : resolved.status === 'missing-run'
                    ? 'This attempt is unavailable'
                    : resolved.status === 'history-unavailable'
                      ? 'Hook-check history unavailable'
                      : 'Connect your local engine'
            }
            description={
              resolved.status === 'missing-run'
                ? 'No other result has been substituted.'
                : resolved.status === 'foreign-workspace'
                  ? 'Open current hook checks to choose this workspace.'
                  : resolved.status === 'history-unavailable'
                    ? 'No empty or completed history was inferred.'
                    : resolved.status === 'invalid'
                      ? 'Select a supported agent, source or exact attempt.'
                      : 'Open the private local server link to read recorded checks.'
            }
          />
          <div className="panel-body">
            <Link className="button" href={workspaceId ? '/agents/hooks/' : '/settings/'}>
              {workspaceId ? 'Open current hook checks' : 'Connection settings'}
              <ArrowRight size={16} aria-hidden="true" />
            </Link>
          </div>
        </Panel>
      ) : (
        <>
          <Panel title={selection?.sourceSha256 ? 'Captured hook source' : 'Test Stroq hook'}>
            <div className="panel-body hook-history-controls">
              <div className="hook-history-selects">
                <div>
                  <label htmlFor="hook-history-agent">Agent</label>
                  <select
                    className="select-field"
                    id="hook-history-agent"
                    value={selection?.agent ?? ''}
                    disabled={!state || history.busy}
                    onChange={(event) =>
                      choose(event.target.value as AgentId, selection?.scope ?? 'project')
                    }
                  >
                    <option value="" disabled>
                      Choose agent
                    </option>
                    {Object.entries(AGENT_NAMES).map(([id, name]) => (
                      <option value={id} key={id}>
                        {name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="hook-history-scope">Hook source</label>
                  <select
                    className="select-field"
                    id="hook-history-scope"
                    value={selection?.scope ?? 'project'}
                    disabled={!selection || history.busy}
                    onChange={(event) =>
                      choose(selection?.agent ?? null, event.target.value as 'project' | 'user')
                    }
                  >
                    <option value="project">Workspace source</option>
                    <option value="user">User source</option>
                  </select>
                </div>
              </div>
              {state && !state.engine.available && (
                <p className="control-error" role="status">
                  The local Stroq runtime is unavailable.
                </p>
              )}
              {selection &&
                state?.agents.find((item) => item.id === selection.agent)?.supported === false && (
                  <p className="control-meta">
                    Offline hook checks are unavailable on this platform.
                  </p>
                )}
              {selection &&
                state?.engine.available &&
                state.agents.find((item) => item.id === selection.agent)?.supported && (
                  <HookCheckDialog
                    agent={selection.agent}
                    scope={selection.scope}
                    expectedWorkspaceId={selection.workspaceId}
                    expectedSourceSha256={selection.sourceSha256}
                    selectedJobId={job?.id}
                    label={job ? 'Open test controls' : 'Test Stroq hook'}
                    onChanged={history.refresh}
                  />
                )}
              <p className="control-meta">
                Two isolated probes with no provider requests. Agent enforcement is not tested.
              </p>
              {selection?.sourceSha256 && (
                <details className="live-details">
                  <summary>Setup receipt source</summary>
                  <code className="inventory-digest">{selection.sourceSha256}</code>
                  <p className="control-meta">
                    A fresh preview must match this source before a test can start.
                  </p>
                  <Link className="inline-link" href="/agents/">
                    Review current Agents <ArrowRight size={14} aria-hidden="true" />
                  </Link>
                </details>
              )}
            </div>
          </Panel>
          {job && (
            <Panel
              title="Recorded attempt"
              actions={
                <ExportButton
                  data={getReport}
                  label="Export result"
                  filename="stroq-hook-check.json"
                />
              }
            >
              <div className="panel-body">
                <div className="setup-preview-heading">
                  <AgentGlyph name={AGENT_NAMES[job.binding.agent]} />
                  <strong>{AGENT_NAMES[job.binding.agent]}</strong>
                  <Badge>
                    {job.binding.scope === 'user' ? 'User hook source' : 'Workspace hook source'}
                  </Badge>
                </div>
                {job.status === 'completed' ? (
                  <HookCheckResult job={job} />
                ) : (
                  <>
                    <div className="hook-history-status">
                      <Badge tone={job.status === 'running' ? 'muted' : 'orange'}>
                        {outcome(job)}
                      </Badge>
                      <time dateTime={job.finishedAt ?? job.startedAt}>
                        {hookCheckTime(job.finishedAt ?? job.startedAt)}
                      </time>
                    </div>
                    {job.status === 'running' ? (
                      <p className="control-meta">
                        <LoaderCircle size={16} className="spin" aria-hidden="true" /> Two isolated
                        probes are running. Open test controls to cancel.
                      </p>
                    ) : (
                      <p className="control-error">
                        {HOOK_CHECK_REASONS[job.error ?? 'hook-check-failed']}
                      </p>
                    )}
                    <HookCheckBindingDetails binding={job.binding} />
                  </>
                )}
              </div>
            </Panel>
          )}
          <Panel
            title="Recorded attempts"
            subtitle={
              state?.history.status === 'error'
                ? 'Retained history unavailable; loaded attempts remain captured evidence.'
                : state?.history.status === 'disabled'
                  ? 'Retained for this server session only.'
                  : undefined
            }
          >
            <div className="panel-body">
              {!state ? (
                <div className="control-empty" role="status">
                  {history.busy ? (
                    <>
                      <LoaderCircle size={24} className="spin" aria-hidden="true" />
                      <p>Reading hook-check history…</p>
                    </>
                  ) : (
                    <p>Hook-check history unavailable. Refresh to retry.</p>
                  )}
                </div>
              ) : jobs.length === 0 ? (
                <EmptyState
                  title={
                    state.history.status === 'error'
                      ? 'Retained history unavailable'
                      : 'No recorded hook checks'
                  }
                  description={
                    state.history.status === 'error'
                      ? 'Missing attempts cannot be ruled out.'
                      : 'Choose an agent and source to preview your first test.'
                  }
                />
              ) : (
                <div className="hook-history-list">
                  {jobs.map((attempt) => {
                    const href = hookCheckHref({
                      workspaceId: attempt.binding.workspaceId,
                      jobId: attempt.id,
                    });
                    return href ? (
                      <Link
                        className={`hook-history-row ${job?.id === attempt.id ? 'is-active' : ''}`}
                        href={href}
                        key={attempt.id}
                        aria-current={job?.id === attempt.id ? 'page' : undefined}
                      >
                        <AgentGlyph name={AGENT_NAMES[attempt.binding.agent]} />
                        <span>
                          <strong>{AGENT_NAMES[attempt.binding.agent]}</strong>
                          <small>
                            {attempt.binding.scope === 'user' ? 'User source' : 'Workspace source'}{' '}
                            · {hookCheckTime(attempt.startedAt)}
                          </small>
                        </span>
                        <Badge
                          tone={
                            attempt.status === 'completed' && attempt.result?.status === 'failed'
                              ? 'red'
                              : attempt.status === 'completed' &&
                                  attempt.result?.status === 'passed'
                                ? 'muted'
                                : attempt.status === 'running'
                                  ? 'muted'
                                  : 'orange'
                          }
                        >
                          {outcome(attempt)}
                        </Badge>
                        <ArrowRight size={16} aria-hidden="true" />
                      </Link>
                    ) : null;
                  })}
                </div>
              )}
            </div>
          </Panel>
        </>
      )}
    </div>
  );
}
