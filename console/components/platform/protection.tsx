'use client';

import { Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  ArrowRight,
  CircleAlert,
  ClipboardCheck,
  FlaskConical,
  FolderSearch,
  LoaderCircle,
  RefreshCw,
  Settings2,
  ShieldCheck,
} from 'lucide-react';
import { useControl } from '@/components/control-provider';
import { usePlatform } from '@/components/platform-provider';
import { ProtectionQueue } from './protection-queue';
import { PostureStrip } from './posture-strip';
import { ProtectionVerdict } from './protection-verdict';
import { LiveProofDialog } from './live-proof';
import { ProtectionCheckReport } from './protection-check-report';
import {
  protectionRunHref,
  protectionRunReadAllowed,
  protectionRunSelection,
  protectionStageTarget,
} from '@/lib/protection-check-navigation';
import {
  formatRunTime,
  getRunOutcome,
  History,
  InstallationResult,
  PolicyResult,
  ScenariosResult,
} from './protection-results';
import { Badge, EmptyState, PageHeading, Panel } from '@/components/platform-ui';
import type { LiveJob } from '@/lib/live-proof';
import { mcpGovernanceHref } from '@/lib/mcp-governance-navigation';
import {
  RUN_ERRORS,
  RUN_LABELS,
  latestContextRun,
  controlRunOwned,
  runMatchesContext,
  type ControlRun,
  type DoctorResult,
  type PolicyCheckResult,
  type GuardTestResult,
} from '@/lib/control';

type CheckKind = 'doctor' | 'policy-check' | 'guard-test';
const KINDS: readonly CheckKind[] = ['doctor', 'policy-check', 'guard-test'];
const ACTIONS: Record<CheckKind, string> = {
  doctor: 'Check installation',
  'policy-check': 'Validate policy',
  'guard-test': 'Test policy',
};
const TITLES: Record<CheckKind, string> = {
  doctor: 'Installation',
  'policy-check': 'Policy validation',
  'guard-test': 'Policy scenarios',
};
const ICONS = { doctor: Settings2, 'policy-check': ClipboardCheck, 'guard-test': FlaskConical };
function RunFrame({
  kind,
  run,
  latest,
  matchesContext,
  owned,
  busy,
  enabled,
  onRun,
  children,
}: {
  kind: CheckKind;
  run?: ControlRun;
  latest: boolean;
  matchesContext: boolean;
  owned: boolean;
  busy: boolean;
  enabled: boolean;
  onRun: (kind: CheckKind) => void;
  children: ReactNode;
}) {
  const unverified = run?.status === 'running' && !owned;
  const state = unverified
      ? { label: 'State unverified', tone: 'muted' as const }
      : getRunOutcome(run),
    Icon = ICONS[kind];
  return (
    <section
      id={`protection-${kind}`}
      className="panel protection-result"
      tabIndex={-1}
      aria-label={TITLES[kind]}
    >
      <div className="panel-heading">
        <div className="protection-result-header">
          <Icon size={20} aria-hidden="true" />
          <h2>{TITLES[kind]}</h2>
        </div>
        <Badge tone={run && !matchesContext ? 'muted' : state.tone}>
          {run && !matchesContext && !unverified ? 'Historical result' : state.label}
        </Badge>
      </div>
      <div className="panel-body">
        <div className="control-meta">
          <span>{kind === 'guard-test' ? 'Simulation' : 'Configuration'}</span>
          {run ? (
            <time dateTime={run.finishedAt ?? run.startedAt}>
              {formatRunTime(run.finishedAt ?? run.startedAt)} UTC
            </time>
          ) : (
            <span>No run yet</span>
          )}
          {!latest && <Badge tone="muted">Earlier run</Badge>}
          {run && !matchesContext && (
            <span>Current context is not established by this report.</span>
          )}
        </div>
        {kind === 'doctor' && run?.status === 'completed' && (
          <p className="control-meta">Run again to read current setup.</p>
        )}
        {unverified ? (
          <p className="control-meta" role="status">
            Unfinished recorded attempt · active owner unverified.
          </p>
        ) : run?.status === 'running' ? (
          <div className="control-empty" role="status">
            <LoaderCircle className="spin" size={22} aria-hidden="true" />
            <p>{ACTIONS[kind]} in progress…</p>
          </div>
        ) : run?.status === 'failed' ? (
          <div className="control-error" role="alert">
            <CircleAlert size={18} aria-hidden="true" />
            <p>{RUN_ERRORS[run.error ?? 'engine-failed'] ?? RUN_ERRORS['engine-failed']}</p>
          </div>
        ) : run?.status === 'completed' ? (
          children
        ) : (
          <p className="control-empty">
            {kind === 'doctor'
              ? 'Check the local runtime, rules and hook setup.'
              : kind === 'policy-check'
                ? 'Validate the policy your engine resolves.'
                : 'Replay attack and ordinary-work scenarios.'}
          </p>
        )}
        <div className="protection-actions">
          <button
            className="button subtle small"
            disabled={!enabled || busy}
            onClick={() => onRun(kind)}
          >
            {run?.status === 'running' && owned ? (
              <LoaderCircle size={15} className="spin" aria-hidden="true" />
            ) : (
              <Icon size={15} aria-hidden="true" />
            )}
            {ACTIONS[kind]}
          </button>
        </div>
      </div>
    </section>
  );
}

function ProtectionPageContent() {
  const { ready, loading, error, control, runs, busy, needsRecheck, refresh, start, cancel } =
    useControl();
  const { localAccess, localContext } = usePlatform();
  const router = useRouter();
  const selection = protectionRunSelection(useSearchParams());
  const workspaceId = localAccess ? (localContext?.workspace.id ?? null) : null;
  const selectionAllowed = protectionRunReadAllowed(selection, workspaceId);
  const diagnosticWorkspaceId =
    localAccess && control?.workspaceId === localContext?.workspace.id
      ? (localContext?.workspace.id ?? null)
      : null;
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const cancelling = useRef<string | null>(null);
  const [liveUpdate, setLiveUpdate] = useState('');
  const recordLiveJob = useCallback((job: LiveJob) => setLiveUpdate(`${job.id}:${job.status}`), []);
  useEffect(() => {
    void refresh(false);
  }, [refresh]);
  const checks = runs
    .filter((run) => run.kind !== 'content-scan')
    .toSorted((a, b) => b.startedAt.localeCompare(a.startedAt));
  const enabled = ready && control?.engine.available === true;
  const canRun = enabled && control?.history.status !== 'error';
  const running = runs.find((run) => controlRunOwned(run, control));
  const connecting = loading || (ready && control === null && error === null);
  async function runCheck(kind: CheckKind | 'protection-check') {
    const run = await start({ kind });
    if (run && workspaceId) router.push(protectionRunHref(run.id, workspaceId));
  }
  function selectRun(run: ControlRun) {
    if (!workspaceId) return;
    router.push(protectionRunHref(run.id, workspaceId));
    requestAnimationFrame(() =>
      document
        .getElementById(
          run.kind === 'protection-check' ? 'protection-check' : `protection-${run.kind}`,
        )
        ?.focus({ preventScroll: false }),
    );
  }
  const requestedRun =
    selectionAllowed && selection.runId
      ? checks.find((run) => run.id === selection.runId)
      : undefined;
  const parent = selection.requested
    ? requestedRun?.kind === 'protection-check'
      ? requestedRun
      : undefined
    : checks.find((run) => run.kind === 'protection-check');
  useEffect(() => {
    if (!selectionAllowed || !selection.runId || requestedRun?.kind !== 'protection-check') return;
    const target = protectionStageTarget(window.location.hash);
    if (!target) return;
    const frame = requestAnimationFrame(() => {
      const stage = document.getElementById(target);
      stage?.querySelector('details')?.setAttribute('open', '');
      stage?.focus({ preventScroll: false });
    });
    return () => cancelAnimationFrame(frame);
  }, [selectionAllowed, selection.runId, requestedRun?.id, requestedRun?.kind]);
  const queueKey = `${liveUpdate}:${checks
    .filter((run) => run.kind === 'protection-check' && run.status !== 'running')
    .map((run) => `${run.id}:${run.status}:${run.finishedAt}`)
    .join(',')}`;
  async function cancelParent() {
    if (!parent || cancelling.current) return;
    cancelling.current = parent.id;
    setCancellingId(parent.id);
    await cancel(parent.id);
    if (cancelling.current === parent.id) {
      cancelling.current = null;
      setCancellingId(null);
    }
  }
  const byKind = Object.fromEntries(
    KINDS.map((kind) => [
      kind,
      (requestedRun?.kind === kind ? requestedRun : undefined) ??
        latestContextRun(checks, kind, control?.context),
    ]),
  ) as Partial<Record<CheckKind, ControlRun>>;
  return (
    <div className="page-stack">
      <PageHeading
        title="Protection"
        actions={
          <>
            <Link className="button" href={mcpGovernanceHref({ draft: 'deny-all' })}>
              <ShieldCheck size={17} aria-hidden="true" />
              Block MCP calls
            </Link>
            <Link className="button" href="/protection/workspace/">
              <FolderSearch size={17} aria-hidden="true" />
              Workspace review
            </Link>
            <button
              className="icon-button"
              aria-label={needsRecheck ? 'Recheck recorded checks' : 'Refresh local checks'}
              disabled={loading}
              onClick={() => void refresh()}
            >
              <RefreshCw size={17} className={loading ? 'spin' : undefined} aria-hidden="true" />
            </button>
            <button
              className="button primary"
              disabled={!canRun || busy || !selectionAllowed}
              onClick={() => void runCheck('protection-check')}
            >
              <ShieldCheck size={17} aria-hidden="true" />
              Run protection check
            </button>
          </>
        }
      />
      {error && (
        <div className="control-error" role="alert">
          <CircleAlert size={18} aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}
      {!ready || !control ? (
        <Panel>
          <div className="control-empty">
            {connecting ? (
              <>
                <LoaderCircle size={26} className="spin" aria-hidden="true" />
                <p role="status">Connecting to the local engine…</p>
              </>
            ) : (
              <>
                <EmptyState
                  title={ready ? 'Local checks unavailable' : 'Connect your local engine'}
                  description={
                    ready
                      ? 'Refresh to retry the local connection.'
                      : 'Open the private link printed by the local server.'
                  }
                />
                <Link className="button" href="/settings/">
                  Connection settings <ArrowRight size={16} aria-hidden="true" />
                </Link>
              </>
            )}
          </div>
        </Panel>
      ) : (
        <>
          <ProtectionVerdict />
          <PostureStrip />
          <ProtectionQueue refreshKey={queueKey} />
          <section className="protection-checks" aria-labelledby="protection-checks-title">
            <h2 id="protection-checks-title" className="protection-checks-title">
              Checks
            </h2>
            <p className="protection-checks-hint">
              Run these after you connect an agent or change a policy. They read local configuration
              and run made-up scenarios; nothing is sent to a provider.
            </p>
            <div className="protection-status">
              <div className="protection-status-main">
                <ShieldCheck size={20} aria-hidden="true" />
                <strong>Local engine</strong>
                <span className="mono muted">
                  {control?.engine.version ? `v${control.engine.version}` : 'Version unavailable'}
                </span>
              </div>
              <Badge tone={enabled ? 'green' : 'orange'}>
                {enabled ? 'Available' : 'Unavailable'}
              </Badge>
            </div>
            {!enabled && (
              <div className="control-error" role="alert">
                Build the local Stroq engine, then restart the server.
              </div>
            )}
            {(control.context.policySha256 === null || control.context.runtimeSha256 === null) && (
              <p className="control-error" role="status">
                Current policy or engine fingerprints are unavailable. Recorded checks remain
                historical.
              </p>
            )}
            <div className="control-run-state" role="status" aria-live="polite">
              {running
                ? `${RUN_LABELS[running.kind]} running…`
                : checks.length
                  ? 'Checks reflect their recorded time. Re-run after configuration changes.'
                  : 'Run a check to collect local evidence.'}
            </div>
            {control.history.status === 'error' && (
              <div className="control-error" role="alert">
                Saved check history is unavailable. Check local storage, then restart the server.
              </div>
            )}
            {selection.requested && (!selectionAllowed || !requestedRun) && (
              <Panel>
                <EmptyState
                  title={selection.invalid ? 'Invalid check link' : 'Selected check unavailable'}
                  description={
                    !selectionAllowed
                      ? 'The selected check does not belong to this connection.'
                      : 'This exact check is not in the retained history.'
                  }
                />
                <Link className="button" href="/protection/">
                  Open current checks
                </Link>
              </Panel>
            )}
            {parent && (
              <details
                className="control-check-details"
                open={
                  selection.requested ||
                  (parent.status === 'running' && controlRunOwned(parent, control))
                }
              >
                <summary>Recorded protection check</summary>
                <ProtectionCheckReport
                  run={parent}
                  workspaceId={diagnosticWorkspaceId}
                  matchesContext={runMatchesContext(parent, control.context)}
                  owned={controlRunOwned(parent, control)}
                  canCancel={
                    parent.status === 'running' &&
                    parent.id === control.activeProtectionCheckId &&
                    !needsRecheck &&
                    diagnosticWorkspaceId !== null
                  }
                  cancelling={cancellingId === parent.id}
                  onCancel={() => void cancelParent()}
                />
              </details>
            )}
            {!selection.requested && !parent && (
              <Panel>
                <div className="panel-body">
                  <p>Check installation, policy behavior and workspace startup in one local run.</p>
                  <p className="control-meta">No provider requests. Settings stay unchanged.</p>
                  <button
                    className="button"
                    disabled={!canRun || busy || !selectionAllowed}
                    onClick={() => void runCheck('protection-check')}
                  >
                    <ShieldCheck size={17} aria-hidden="true" />
                    Run protection check
                  </button>
                </div>
              </Panel>
            )}
            <details
              className="control-check-details"
              open={!!requestedRun && requestedRun.kind !== 'protection-check'}
            >
              <summary>Individual checks</summary>
              <div className="protection-grid">
                {KINDS.map((kind) => {
                  const run = byKind[kind];
                  return (
                    <RunFrame
                      key={kind}
                      kind={kind}
                      run={run}
                      latest={checks.find((check) => check.kind === kind)?.id === run?.id}
                      matchesContext={runMatchesContext(run, control.context)}
                      owned={
                        run
                          ? controlRunOwned(
                              checks.find((source) => source.id === run.id) ?? run,
                              control,
                            )
                          : false
                      }
                      busy={busy}
                      enabled={canRun}
                      onRun={(next) => void runCheck(next)}
                    >
                      {kind === 'doctor' && run?.result ? (
                        <InstallationResult
                          result={run.result as DoctorResult}
                          workspaceId={diagnosticWorkspaceId}
                          matchesCurrentRunContext={runMatchesContext(run, control.context)}
                        />
                      ) : kind === 'policy-check' && run?.result ? (
                        <PolicyResult result={run.result as PolicyCheckResult} />
                      ) : kind === 'guard-test' && run?.result ? (
                        <ScenariosResult result={run.result as GuardTestResult} />
                      ) : null}
                    </RunFrame>
                  );
                })}
              </div>
            </details>
            <Panel title="Live blocking test" actions={<LiveProofDialog onJob={recordLiveJob} />}>
              <div className="panel-body">
                <p className="muted">
                  Real allow, deny and control checks in a temporary project. Uses your agent
                  subscription after confirmation.
                </p>
              </div>
            </Panel>
            <History runs={checks} onSelect={selectRun} control={control} />
          </section>
        </>
      )}
    </div>
  );
}
export function ProtectionPage() {
  return (
    <Suspense
      fallback={
        <div className="control-empty" role="status">
          Reading local checks…
        </div>
      }
    >
      <ProtectionPageContent />
    </Suspense>
  );
}
