import type { Incident } from './incidents';
import { stamp } from './local-guards';
import {
  sameIncidentAssessmentBinding,
  validateIncidentAssessmentPreview,
  validateIncidentAssessmentState,
  type IncidentAssessmentBinding,
  type IncidentAssessmentPreview,
} from './incident-assessments';

type PendingAssessment = { preview: IncidentAssessmentPreview; startedAt: string };
const binding = (incident: Incident): IncidentAssessmentBinding => ({
  id: incident.id,
  evidenceSha256: incident.evidenceSha,
  sequence: incident.sequence,
  recordedAt: incident.recordedAt,
  kind: incident.kind,
});

/** Export annotations for selected exact findings, never the one-use save capability. */
export function incidentAssessmentExport(
  snapshot: unknown,
  unresolved: readonly PendingAssessment[],
  incidents: readonly Incident[],
) {
  const state = validateIncidentAssessmentState(snapshot) ? snapshot : null;
  const selected = incidents.map(binding);
  const matches = (candidate: IncidentAssessmentBinding) =>
    selected.some((value) => sameIncidentAssessmentBinding(candidate, value));
  let omitted = 0;
  const pending = unresolved.flatMap((write) => {
    if (!validateIncidentAssessmentPreview(write?.preview) || !stamp(write?.startedAt)) {
      omitted++;
      return [];
    }
    const preview = write.preview;
    if (!matches(preview.incident)) return [];
    return [
      {
        recordId: preview.recordId,
        incident: preview.incident,
        assessment: preview.assessment,
        reason: preview.reason,
        previousAssessmentId: preview.previousAssessmentId,
        startedAt: write.startedAt,
      },
    ];
  });
  return {
    schema: 'stroq-operator-assessments-export/1' as const,
    scope: 'selected-findings-in-local-journal' as const,
    capturedAt: state?.generatedAt ?? null,
    historyStatus: state?.history ?? 'unavailable',
    historyRevision: state?.revision ?? null,
    records: state?.records.filter((record) => matches(record.incident)) ?? [],
    pending,
    completionUnknown: pending.length > 0 || omitted > 0,
    projectionIncomplete: omitted > 0,
  };
}
