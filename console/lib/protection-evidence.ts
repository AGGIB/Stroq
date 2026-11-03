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
  secrets: SecretScanState | null;
  workspaceId: string | null | undefined;
  /** True while the snapshots are still being fetched: a missing one is not yet a gap. */
  loading?: boolean;
}
const newest = <T extends { startedAt: string }>(jobs: readonly T[]) =>
  jobs.toSorted((a, b) => b.startedAt.localeCompare(a.startedAt));
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
  return secretRows(input).toSorted((a, b) => priority[a.tone] - priority[b.tone]);
}
