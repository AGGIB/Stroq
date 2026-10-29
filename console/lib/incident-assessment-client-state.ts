import type { Incident } from './incidents';
import {
  INCIDENT_ASSESSMENT_ERROR_MESSAGES,
  validateIncidentAssessmentBinding,
  type IncidentAssessmentBinding,
  type IncidentAssessmentDecision,
  type IncidentAssessmentReason,
  type IncidentAssessmentPreview,
} from './incident-assessments';
type Choice = {
  assessment: IncidentAssessmentDecision | null;
  reason: IncidentAssessmentReason | null;
};
type PendingWrite = { preview: IncidentAssessmentPreview; startedAt: string };
const uncertain = new WeakMap<object, Map<string, PendingWrite>>();
export const PENDING_LIMIT = 8;
export function pendingWrites(transport: object) {
  let pending = uncertain.get(transport);
  if (!pending) {
    pending = new Map();
    uncertain.set(transport, pending);
  }
  return pending;
}
export function incidentAssessmentPendingWrites(
  transport: object,
): ReadonlyMap<string, PendingWrite> {
  return new Map(
    [...(uncertain.get(transport) ?? [])].map(([id, write]) => [
      id,
      { ...write, preview: { ...write.preview, incident: { ...write.preview.incident } } },
    ]),
  );
}
export const emptyChoice = (): Choice => ({ assessment: null, reason: null });
export const UNKNOWN = 'Save unconfirmed. Recheck this assessment before saving again.';
export function bindingFor(incident: Incident | null): IncidentAssessmentBinding | null {
  if (!incident) return null;
  const binding = {
    id: incident.id,
    evidenceSha256: incident.evidenceSha,
    sequence: incident.sequence,
    recordedAt: incident.recordedAt,
    kind: incident.kind,
  };
  return validateIncidentAssessmentBinding(binding) ? binding : null;
}
export function finiteMessage(error: unknown, fallback: string) {
  return error instanceof Error &&
    Object.values(INCIDENT_ASSESSMENT_ERROR_MESSAGES).includes(error.message)
    ? error.message
    : fallback;
}
