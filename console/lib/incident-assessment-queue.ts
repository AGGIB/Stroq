import type { Incident, IncidentsState } from './incidents';
import {
  sameIncidentAssessmentBinding,
  validateIncidentAssessmentState,
  type IncidentAssessmentRecord,
} from './incident-assessments';
import { incidentHref } from './incident-navigation';
import type { ProtectionEvidenceRow } from './protection-evidence';

/** One validated journal snapshot, indexed once for the current bounded finding window. */
export function incidentAssessmentIndex(state: unknown) {
  if (!validateIncidentAssessmentState(state) || state.history === 'unavailable') return null;
  const latest = new Map<string, IncidentAssessmentRecord>();
  for (const record of state.records) latest.set(record.incident.id, record);
  return latest;
}
export function assessmentForIncident(
  index: Map<string, IncidentAssessmentRecord> | null,
  incident: Incident,
) {
  const record = index?.get(incident.id);
  return record &&
    sameIncidentAssessmentBinding(record.incident, {
      id: incident.id,
      evidenceSha256: incident.evidenceSha,
      sequence: incident.sequence,
      recordedAt: incident.recordedAt,
      kind: incident.kind,
    })
    ? record
    : null;
}
export function incidentAssessmentRows(
  incidents: IncidentsState | null,
  assessments: unknown,
  unconfirmed: ReadonlySet<string> = new Set(),
): ProtectionEvidenceRow[] {
  const index = incidentAssessmentIndex(assessments);
  const rows: ProtectionEvidenceRow[] = [];
  if (!index)
    rows.push({
      key: 'incident-assessment-history',
      title: 'Operator assessments unavailable',
      detail:
        'Local assessment history could not be verified. Captured findings remain in attention; no assessment or remediation was inferred.',
      href: incidentHref(null, 'all'),
      action: 'Inspect assessments',
      tone: 'orange',
    });
  else if (validateIncidentAssessmentState(assessments) && !assessments.canRecord)
    rows.push({
      key: 'incident-assessment-capacity',
      title: 'Assessment history is full',
      detail:
        'Earlier assessments remain readable. New assessments cannot be recorded within the local retention bound.',
      href: incidentHref(null, 'all'),
      action: 'Inspect history',
      tone: 'orange',
    });
  const pending = (incidents?.incidents ?? []).flatMap((incident) => {
    const record = assessmentForIncident(index, incident);
    const unknown = unconfirmed.has(incident.id);
    return !unknown && record && ['false-positive', 'accepted-risk'].includes(record.assessment)
      ? []
      : [{ incident, record: unknown ? null : record, unknown }];
  });
  if (!pending.length) return rows;
  const count = pending.length;
  const unassessed = pending.filter((item) => !item.record && !item.unknown).length;
  const missing = index
    ? `${unassessed} unassessed`
    : `${unassessed} ${unassessed === 1 ? 'assessment' : 'assessments'} unavailable`;
  const unknown = pending.filter((item) => item.unknown).length;
  const issues = pending.filter((item) => item.record?.assessment === 'confirmed-issue').length;
  const reopened = pending.filter((item) => item.record?.assessment === 'reopened').length;
  const next =
    pending.find((item) => item.unknown) ??
    pending.find((item) => item.record?.assessment === 'confirmed-issue') ??
    pending.find((item) => item.record?.assessment === 'reopened') ??
    pending[0]!;
  rows.push({
    key: 'incidents',
    title: `${count} recorded ${count === 1 ? 'finding needs' : 'findings need'} attention`,
    detail: `${missing} · ${issues} marked as issue · ${reopened} reopened${unknown ? ` · ${unknown} save unconfirmed` : ''} in the captured journal window. Reviewed is separate. Operator assessments do not establish remediation or host blocking.`,
    href: incidentHref(next.incident.id, 'all'),
    action: 'Investigate',
    tone: 'orange',
  });
  return rows;
}
