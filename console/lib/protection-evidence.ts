import { AGENT_NAMES, type AgentId, type AgentStatusState } from './agent-status';
import { liveHref } from './live-navigation';
import type { LiveJob, LiveReport, LiveState } from './live-proof';
import { secretHref } from './secret-navigation';
import type { SecretJob, SecretReport, SecretScanState } from './secret-scan';

export interface ProtectionEvidenceRow {
  key: string;
  title: string;
  detail: string;
  context?: string;
  href: string;
  action: string;
  tone: 'muted' | 'orange' | 'red';
}
export interface ProtectionEvidenceInput {
  live: LiveState | null;
  secrets: SecretScanState | null;
  agents: AgentStatusState | null;
  workspaceId: string | null | undefined;
  /** True while the snapshots are still being fetched: a missing one is not yet a gap. */
  loading?: boolean;
}
const AGENTS = Object.keys(AGENT_NAMES) as AgentId[];
const newest = <T extends { startedAt: string }>(jobs: readonly T[]) =>
  jobs.toSorted((a, b) => b.startedAt.localeCompare(a.startedAt));
const historicalLive =
  'Historical isolated-host evidence; installed hooks and the current host version are not verified.';

function liveAttempt(job: LiveJob): Pick<ProtectionEvidenceRow, 'title' | 'detail' | 'tone'> {
  const name = AGENT_NAMES[job.agent];
  if (job.status === 'running')
    return {
      title: `${name}: live check running`,
      detail: `Started ${job.startedAt}. Isolated-host test; no completed report is available.`,
      tone: 'muted',
    };
  if (job.status !== 'completed')
    return {
      title: `${name}: latest live check ${job.status}`,
      detail: `Finished ${job.finishedAt}. No accepted live report. ${historicalLive}`,
      tone: 'orange',
    };
  return liveReport(job.agent, job.result!, job.finishedAt!);
}
function liveReport(
  agent: AgentId,
  report: LiveReport,
  checkedAt: string,
  stale = false,
): Pick<ProtectionEvidenceRow, 'title' | 'detail' | 'tone'> {
  const name = AGENT_NAMES[agent];
  if (stale)
    return {
      title: `${name}: live evidence needs a fresh check`,
      detail: `Checked ${checkedAt}. ${historicalLive} Freshness has not been established.`,
      tone: 'orange',
    };
  if (report.mode === 'stand-in')
    return {
      title: `${name}: test did not establish live blocking`,
      detail: `Checked ${checkedAt}. Historical stand-in result; no live host proof.`,
      tone: 'orange',
    };
  const passed = report.state === 'verified' && report.mode === 'live';
  const status = passed
    ? 'isolated check passed'
    : report.state === 'failed'
      ? 'isolated check failed'
      : report.state === 'inconclusive'
        ? 'isolated check inconclusive'
        : report.state === 'unsupported'
          ? 'live check unsupported'
          : 'live check not attempted';
  return {
    title: `${name}: ${status}`,
    detail: `Checked ${checkedAt}. ${historicalLive}`,
    tone: passed ? 'muted' : report.state === 'failed' ? 'red' : 'orange',
  };
}
function liveRows({
  live,
  agents,
  workspaceId,
  loading,
}: ProtectionEvidenceInput): ProtectionEvidenceRow[] {
  const base = liveHref({ workspaceId });
  if (!live && loading) return [];
  if (!live)
    return [
      {
        key: 'live-unavailable',
        title: 'Live-check evidence unavailable',
        detail:
          'Live history could not be read. Current hook configuration does not establish host blocking.',
        href: base,
        action: 'Open live checks',
        tone: 'orange',
      },
    ];
  const rows: ProtectionEvidenceRow[] = [];
  if (!live.engine.available)
    rows.push({
      key: 'live-engine',
      title: 'Live-check engine unavailable',
      detail: 'New live checks cannot start. Retained results remain historical evidence.',
      href: base,
      action: 'Open live checks',
      tone: 'orange',
    });
  if (!agents && !loading)
    rows.push({
      key: 'live-configuration',
      title: 'Agent configuration unavailable',
      detail:
        'Configured-agent coverage is unknown. Isolated-host history cannot establish current workspace protection.',
      href: base,
      action: 'Open live checks',
      tone: 'orange',
    });
  for (const id of AGENTS) {
    const current = agents?.agents.find((agent) => agent.id === id);
    const configured = current?.scopes.some((scope) => scope.state === 'present') ?? false;
    const support = live.agents.find((agent) => agent.id === id);
    // Running work for another agent must never replace this agent's last attempt.
    const attempts = newest(live.jobs.filter((job) => job.agent === id));
    const latest = attempts[0];
    const running = attempts.find((job) => job.status === 'running');
    const proof = support?.proof;
    const proofIsNewer =
      proof && latest && proof.checkedAt > (latest.finishedAt ?? latest.startedAt);
    const attempt = running ?? (proofIsNewer ? undefined : latest);
    if (!configured && !attempt && !proof) continue;
    const href = liveHref({
      workspaceId,
      ...(attempt ? { jobId: attempt.id } : { agent: id }),
    });
    const unsupported = support?.supported === false;
    const retained = proof
      ? liveReport(
          id,
          {
            ...proof.report,
            state:
              proof.state === 'verified' || proof.state === 'stale'
                ? proof.report.state
                : proof.state,
          },
          proof.checkedAt,
          proof.state === 'stale',
        )
      : null;
    let evidence: Pick<ProtectionEvidenceRow, 'title' | 'detail' | 'tone'>;
    if (attempt) evidence = liveAttempt(attempt);
    else if (retained) evidence = retained;
    else
      evidence = {
        title: `${AGENT_NAMES[id]}: live blocking not checked`,
        detail:
          'Hooks are configured; no retained isolated-host proof is available. Configuration alone does not establish blocking.',
        tone: 'orange',
      };
    if (running && proofIsNewer && retained)
      evidence = {
        ...evidence,
        detail: `${evidence.detail} Separate newer result: ${retained.title}. ${retained.detail}`,
        tone: retained.tone,
      };
    if (unsupported)
      evidence = {
        ...evidence,
        title: attempt || proof ? evidence.title : `${AGENT_NAMES[id]}: live driver unavailable`,
        detail: `${evidence.detail} A live driver is unavailable for the current platform.`,
        tone: evidence.tone === 'red' ? 'red' : 'orange',
      };
    else if (!support && configured)
      evidence = {
        ...evidence,
        detail: `${evidence.detail} Current live-driver availability is unknown.`,
        tone: evidence.tone === 'red' ? 'red' : 'orange',
      };
    rows.push({
      key: `live-${id}`,
      ...evidence,
      href,
      action: attempt ? 'Inspect attempt' : proof ? 'Inspect history' : 'Review live check',
    });
  }
  if (!rows.length)
    rows.push({
      key: 'live-never',
      title: 'No live test yet',
      detail:
        'A live test starts your real agent on a throwaway project, with your consent, to see whether it waits for Stroq. Opening this page does not start it.',
      href: base,
      action: 'Review live checks',
      tone: 'muted',
    });
  return rows;
}

function secretReportRow(
  job: SecretJob,
  report: SecretReport,
  workspaceId: ProtectionEvidenceInput['workspaceId'],
): ProtectionEvidenceRow {
  const external = report.totals.external;
  const uncertain = report.totals.uncertain;
  const scope = report.scope === 'last' ? 'Latest related session' : 'Related workspace sessions';
  const coverage = report.complete
    ? 'Comparison finished within its supported scope.'
    : `Coverage incomplete: ${report.notChecked.length} reported gaps; ${report.omittedFindings} finding details omitted.`;
  let title = 'Recorded credential comparison';
  let tone: ProtectionEvidenceRow['tone'] = 'muted';
  if (external) {
    title = `${external} credentials on recorded external routes`;
    tone = 'red';
  } else if (uncertain) {
    title = `${uncertain} credentials with uncertain destinations`;
    tone = 'orange';
  } else if (!report.complete) {
    title = 'Credential comparison has coverage gaps';
    tone = 'orange';
  } else if (report.totals.modelVisible) {
    title = `${report.totals.modelVisible} credentials recorded in sessions`;
    tone = 'orange';
  } else if (!report.totals.findings) title = 'No matches in this credential comparison';
  return {
    key: `secret-report-${job.id}`,
    title,
    detail: `Checked ${report.checkedAt}. Historical transcript evidence · ${scope} · ${report.sessions.total} sessions · ${report.keys.compared} credentials compared. ${external || uncertain ? `${external} external; ${uncertain} uncertain. ` : ''}${coverage} This does not establish delivery, live blocking or that credentials stayed local.`,
    href: secretHref(job.id, workspaceId ?? null),
    action: 'Inspect report',
    tone,
  };
}
function secretRows({
  secrets,
  workspaceId,
  loading,
}: ProtectionEvidenceInput): ProtectionEvidenceRow[] {
  const base = secretHref(null, workspaceId ?? null);
  if (!secrets && loading) return [];
  if (!secrets)
    return [
      {
        key: 'secret-unavailable',
        title: 'Secret exposure evidence unavailable',
        detail:
          'Retained comparisons could not be read. No conclusion about credential exposure is available.',
        href: base,
        action: 'Open secret exposure',
        tone: 'orange',
      },
    ];
  const rows: ProtectionEvidenceRow[] = [];
  if (!secrets.engine.available)
    rows.push({
      key: 'secret-engine',
      title: 'Credential comparison engine unavailable',
      detail: 'New comparisons cannot start. Retained reports still describe historical records.',
      href: base,
      action: 'Open secret exposure',
      tone: 'orange',
    });
  const jobs = newest(secrets.jobs);
  for (const job of jobs) {
    const report = job.result;
    // Later clean/narrow/failed work cannot resolve findings or gaps in a retained report.
    if (
      job.status === 'completed' &&
      report &&
      (job === jobs[0] ||
        report.totals.external > 0 ||
        report.totals.uncertain > 0 ||
        !report.complete)
    ) {
      rows.push(secretReportRow(job, report, workspaceId));
      continue;
    }
    if (job.status === 'running' || (job === jobs[0] && job.status !== 'completed'))
      rows.push({
        key: `secret-attempt-${job.id}`,
        title:
          job.status === 'running'
            ? 'Credential comparison running'
            : job.status === 'cancelled'
              ? 'Credential comparison cancelled'
              : 'Credential comparison did not complete',
        detail: `${job.status === 'running' ? 'Started' : 'Finished'} ${job.status === 'running' ? job.startedAt : job.finishedAt}. ${job.scope === 'last' ? 'Latest related session' : 'Related workspace sessions'}. No completed report was accepted for this attempt; retained findings remain separate.`,
        href: secretHref(job.id, workspaceId ?? null),
        action: 'Inspect attempt',
        tone: job.status === 'running' ? 'muted' : 'orange',
      });
  }
  if (!jobs.some((job) => job.status === 'completed'))
    rows.push({
      key: 'secret-never',
      title: 'Check whether your agents have seen your keys',
      detail:
        'No scan has been saved yet. A scan compares your recorded agent sessions with the keys on this machine; you review what it reads and start it yourself.',
      href: base,
      action: 'Review scan access',
      tone: 'muted',
    });
  return rows;
}

/** Derives queue rows from validated snapshots; it never scans, mutates or upgrades evidence. */
export function protectionEvidenceRows(input: ProtectionEvidenceInput): ProtectionEvidenceRow[] {
  const priority = { red: 0, orange: 1, muted: 2 };
  return [...liveRows(input), ...secretRows(input)].toSorted(
    (a, b) => priority[a.tone] - priority[b.tone],
  );
}
