import type { Incident } from './incidents';
import type { IncidentTaskReport } from './incident-task';
import { stamp } from './local-guards';
import { taskLockHref } from './task-lock-navigation';
type SelectedFinding = Pick<Incident, 'id' | 'evidenceSha' | 'sequence' | 'recordedAt'>;
export function incidentTaskKey(incident: SelectedFinding | null, workspaceId: string | null) {
  if (
    !incident ||
    !workspaceId ||
    !/^workspace-[a-f0-9]{24}$/.test(workspaceId) ||
    !/^[a-f0-9]{64}$/.test(incident.evidenceSha) ||
    incident.id !== `incident-${incident.evidenceSha}` ||
    !Number.isSafeInteger(incident.sequence) ||
    incident.sequence < 1 ||
    !stamp(incident.recordedAt)
  )
    return null;
  return JSON.stringify([
    workspaceId,
    incident.id,
    incident.evidenceSha,
    incident.sequence,
    incident.recordedAt,
  ]);
}
export function incidentTaskReportMatches(
  report: IncidentTaskReport,
  incident: SelectedFinding,
  workspaceId: string,
) {
  return (
    report.workspaceId === workspaceId &&
    report.incident.id === incident.id &&
    report.incident.evidenceSha256 === incident.evidenceSha &&
    report.incident.sequence === incident.sequence &&
    report.incident.recordedAt === incident.recordedAt
  );
}
export function incidentTaskHref(report: IncidentTaskReport) {
  return report.status === 'matched' && report.task !== null
    ? taskLockHref(report.task.id, report.workspaceId, {
        permitSha256: report.task.permitSha256,
        incidentId: report.incident.id,
      })
    : null;
}
