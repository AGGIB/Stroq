'use client';

import Link from 'next/link';
import { ArrowRight, CircleAlert } from 'lucide-react';
import { Badge, Command, Panel } from '@/components/platform-ui';
import { doctorDiagnosticNavigation, doctorSetupNavigation } from '@/lib/doctor-navigation';
import {
  doctorInstallationRows,
  doctorSetupMissing,
  type DoctorInstallationRow,
} from '@/lib/doctor-presentation';
import {
  RUN_LABELS,
  controlRunOwned,
  type ControlRun,
  type ControlState,
  type DoctorResult,
  type PolicyCheckResult,
  type GuardTestResult,
} from '@/lib/control';
import { protectionCheckOutcome } from '@/lib/protection-check-presentation';

type Tone = 'green' | 'orange' | 'red' | 'muted';
const FINDINGS: Record<string, string> = {
  'shadowed-rule': 'Shadowed rules',
  'dropped-protection': 'Missing default protections',
  'loose-default': 'Permissive default',
  'high-threshold': 'High threshold',
  'unknown-field': 'Unknown fields',
};

export function formatRunTime(value: string) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(value));
}

export function getRunOutcome(run: ControlRun | undefined): { label: string; tone: Tone } {
  if (!run) return { label: 'Not checked', tone: 'muted' };
  if (run.kind === 'protection-check') return protectionCheckOutcome(run);
  if (run.status === 'running') return { label: 'Running…', tone: 'muted' };
  if (run.status === 'failed') return { label: 'Could not complete', tone: 'red' };
  if (!run.result) return { label: 'Incomplete', tone: 'orange' };
  if (run.kind === 'doctor') {
    return { label: 'Recorded diagnostics', tone: 'muted' };
  }
  if (run.kind === 'policy-check') {
    const result = run.result as PolicyCheckResult;
    if (
      !result.loaded ||
      result.faults > 0 ||
      result.findings.some((finding) => finding.severity !== 'info' && finding.count > 0)
    )
      return { label: 'Needs attention', tone: 'orange' };
  }
  if (run.kind === 'guard-test') {
    const result = run.result as GuardTestResult;
    if (result.notJudged > 0) return { label: 'Incomplete', tone: 'orange' };
    if (result.attacksPassing > 0 || result.violations > 0)
      return { label: 'Needs attention', tone: 'orange' };
    if (result.ok && result.newInterruptions > 0)
      return { label: 'Passed with changes', tone: 'orange' };
  }
  const result = run.result as DoctorResult | PolicyCheckResult | GuardTestResult;
  return result.ok
    ? { label: 'Passed', tone: 'green' }
    : { label: 'Needs attention', tone: 'orange' };
}

function DiagnosticObservation({
  row,
  workspaceId,
  matchesCurrentRunContext,
  attention = false,
}: {
  row: DoctorInstallationRow;
  workspaceId: string | null;
  matchesCurrentRunContext: boolean;
  attention?: boolean;
}) {
  const navigation =
    row.diagnostic && row.observationIndex !== null
      ? doctorDiagnosticNavigation(row.diagnostic, row.observationIndex, {
          workspaceId,
          matchesCurrentRunContext,
        })
      : null;
  return (
    <div className={attention ? 'protection-finding' : 'protection-check'}>
      {attention && <CircleAlert size={16} aria-hidden="true" />}
      <div>
        <span>{row.label}</span>
        <div className="control-meta">
          {row.scopeLabel && `${row.scopeLabel} · `}
          {row.reason}
        </div>
        {navigation && (
          <Link className="inline-link" href={navigation.href}>
            {navigation.label} <ArrowRight size={14} aria-hidden="true" />
          </Link>
        )}
      </div>
      {!attention && (
        <Badge tone={row.attention && !row.legacy ? 'orange' : 'muted'}>
          {row.attention && !row.legacy ? 'Review' : 'Recorded'}
        </Badge>
      )}
    </div>
  );
}

export function InstallationResult({
  result,
  workspaceId = null,
  matchesCurrentRunContext = false,
}: {
  result: DoctorResult;
  workspaceId?: string | null;
  matchesCurrentRunContext?: boolean;
}) {
  const rows = doctorInstallationRows(result);
  const attention = rows.filter((row) => row.attention);
  const setupMissing = doctorSetupMissing(result);
  const setupNavigation = setupMissing
    ? doctorSetupNavigation({ workspaceId, matchesCurrentRunContext })
    : null;
  const reviewCount = attention.length + (setupMissing ? 1 : 0);
  const legacy = rows.some((row) => row.legacy);
  const indexIssue = attention.some((row) => row.diagnostic?.kind === 'secret-index');
  const localGuidance = attention.some(
    (row) =>
      !row.diagnostic ||
      row.observationIndex === null ||
      !doctorDiagnosticNavigation(row.diagnostic, row.observationIndex, {
        workspaceId,
        matchesCurrentRunContext,
      }),
  );
  return (
    <>
      <div className="protection-metric">
        <strong>{result.total}</strong>
        <span>
          checks recorded
          {reviewCount > 0
            ? ` · ${reviewCount} observation${reviewCount === 1 ? '' : 's'} to review`
            : ''}
        </span>
      </div>
      {setupMissing && (
        <div className="protection-findings">
          <div className="protection-finding">
            <CircleAlert size={16} aria-hidden="true" />
            <div>
              <span>No agent registration was recorded</span>
              {setupNavigation && (
                <div>
                  <Link className="inline-link" href={setupNavigation.href}>
                    {setupNavigation.label} <ArrowRight size={14} aria-hidden="true" />
                  </Link>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      {attention.length > 0 && (
        <div className="protection-findings">
          {attention.map((row) => (
            <DiagnosticObservation
              key={row.id}
              row={row}
              workspaceId={workspaceId}
              matchesCurrentRunContext={matchesCurrentRunContext}
              attention
            />
          ))}
        </div>
      )}
      <details className="control-check-details">
        <summary>View {result.total} checks</summary>
        <div className="protection-checks">
          {rows.map((row) => (
            <DiagnosticObservation
              key={row.id}
              row={row}
              workspaceId={workspaceId}
              matchesCurrentRunContext={matchesCurrentRunContext}
            />
          ))}
        </div>
        {legacy && (
          <p className="control-meta">
            Reason and scope are unavailable in this recorded report. Run installation diagnostics
            again for typed details.
          </p>
        )}
      </details>
      {localGuidance && (
        <details className="context-note">
          <summary>Local diagnostic guidance</summary>
          {indexIssue && (
            <p className="control-meta">
              Inspect index coverage and source readability. This report does not rebuild the secret
              index.
            </p>
          )}
          <Command command="stroq doctor --json --all" />
        </details>
      )}
    </>
  );
}

export function PolicyResult({ result }: { result: PolicyCheckResult }) {
  return (
    <>
      <dl className="property-list">
        <div>
          <dt>Source</dt>
          <dd>{result.policySource === 'default' ? 'Bundled default' : 'Local policy file'}</dd>
        </div>
        <div>
          <dt>Rules</dt>
          <dd className="mono">{result.rules ?? '—'}</dd>
        </div>
        <div>
          <dt>Unmatched actions</dt>
          <dd>{result.defaultEffect ?? '—'}</dd>
        </div>
        <div>
          <dt>Threshold</dt>
          <dd className="mono">{result.threshold ?? '—'}</dd>
        </div>
      </dl>
      {!result.loaded && <p className="control-error">Policy could not be loaded.</p>}
      {(result.faults > 0 || result.findings.length > 0) && (
        <div className="protection-findings">
          {result.faults > 0 && (
            <div className="protection-finding">
              <span>Policy faults</span>
              <Badge tone="red">{result.faults}</Badge>
            </div>
          )}
          {result.findings.map((finding) => (
            <div className="protection-finding" key={`${finding.kind}-${finding.severity}`}>
              <span>{FINDINGS[finding.kind] ?? finding.kind}</span>
              <Badge
                tone={
                  finding.severity === 'error'
                    ? 'red'
                    : finding.severity === 'warning'
                      ? 'orange'
                      : 'muted'
                }
              >
                {finding.count}
              </Badge>
            </div>
          ))}
        </div>
      )}
      {!result.ok && (
        <details className="context-note">
          <summary>Inspect the full report</summary>
          <Command command="stroq policy check --json" />
        </details>
      )}
    </>
  );
}

export function ScenariosResult({ result }: { result: GuardTestResult }) {
  const total = result.replayed.attack + result.replayed.ordinary + result.replayed.cases;
  return (
    <>
      <div className="protection-metric">
        <strong>{total.toLocaleString('en-GB')}</strong>
        <span>scenarios replayed</span>
      </div>
      <p className="control-meta">
        {result.replayed.attack} attack · {result.replayed.ordinary} ordinary
        {result.replayed.cases > 0 ? ` · ${result.replayed.cases} custom` : ''}
      </p>
      <dl className="property-list">
        <div>
          <dt>Attacks allowed</dt>
          <dd>
            <Badge tone={result.attacksPassing > 0 ? 'red' : 'muted'}>
              {result.attacksPassing}
            </Badge>
          </dd>
        </div>
        <div>
          <dt>Unjudged scenarios</dt>
          <dd>
            <Badge tone={result.notJudged > 0 ? 'orange' : 'muted'}>{result.notJudged}</Badge>
          </dd>
        </div>
        <div>
          <dt>Unmet expectations</dt>
          <dd className="mono">{result.violations}</dd>
        </div>
        <div>
          <dt>New interruptions</dt>
          <dd className="mono">{result.newInterruptions}</dd>
        </div>
        <div>
          <dt>Interruptions removed</dt>
          <dd className="mono">{result.relieved}</dd>
        </div>
      </dl>
      <p className="control-meta">Policy behavior only. Live host blocking is not tested.</p>
      {(!result.ok ||
        result.notJudged > 0 ||
        result.attacksPassing > 0 ||
        result.violations > 0 ||
        result.newInterruptions > 0) && (
        <details className="context-note">
          <summary>Inspect the full comparison</summary>
          <Command command="stroq policy test --json" />
        </details>
      )}
    </>
  );
}

export function History({
  runs,
  onSelect,
  control,
}: {
  runs: ControlRun[];
  onSelect: (run: ControlRun) => void;
  control: ControlState | null;
}) {
  if (!runs.length) return null;
  return (
    <Panel title="Check history" subtitle="Latest local checks" className="protection-history">
      <div className="table-wrap" role="region" aria-label="Security check history" tabIndex={0}>
        <table className="data-table">
          <thead>
            <tr>
              <th>Check</th>
              <th>Evidence</th>
              <th>Result</th>
              <th>Started · UTC</th>
              <th aria-label="Inspect" />
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => {
              const state =
                run.status === 'running' && !controlRunOwned(run, control)
                  ? { label: 'State unverified', tone: 'muted' as const }
                  : getRunOutcome(run);
              return (
                <tr key={run.id}>
                  <td>
                    <button className="table-main disclosure-row" onClick={() => onSelect(run)}>
                      {RUN_LABELS[run.kind]}
                    </button>
                  </td>
                  <td>
                    {run.kind === 'protection-check'
                      ? 'Local checks'
                      : run.kind === 'guard-test'
                        ? 'Simulation'
                        : 'Configuration'}
                  </td>
                  <td>
                    <Badge tone={state.tone}>{state.label}</Badge>
                  </td>
                  <td className="mono muted">{formatRunTime(run.startedAt)}</td>
                  <td>
                    <button
                      className="icon-button"
                      aria-label={`Inspect ${RUN_LABELS[run.kind]} from ${formatRunTime(run.startedAt)} UTC`}
                      onClick={() => onSelect(run)}
                    >
                      <ArrowRight size={16} aria-hidden="true" />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
