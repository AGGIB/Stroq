import type {
  IncidentAssessmentBinding,
  IncidentAssessmentPreview,
  IncidentAssessmentReceipt,
  IncidentAssessmentRecord,
  IncidentAssessmentState,
} from './incident-assessments';
export const assessmentAt = '2026-10-24T10:00:00.000Z';
export const assessmentHash = (digit: string) => digit.repeat(64);
export const assessmentId = (digit: string) =>
  `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
export function assessmentBinding(): IncidentAssessmentBinding {
  return {
    id: `incident-${assessmentHash('a')}`,
    evidenceSha256: assessmentHash('a'),
    sequence: 12,
    recordedAt: '2026-10-24T09:00:00.000Z',
    kind: 'policy-deny',
  };
}
export function assessmentRecord(): IncidentAssessmentRecord {
  return {
    id: assessmentId('2'),
    incident: assessmentBinding(),
    assessment: 'accepted-risk',
    reason: 'intended-workflow',
    assessedAt: assessmentAt,
    previousAssessmentId: null,
  };
}
export function assessmentState(records: IncidentAssessmentRecord[] = []): IncidentAssessmentState {
  return {
    schema: 'stroq-incident-assessments/1',
    scope: 'local-journal',
    generatedAt: assessmentAt,
    history: records.length ? 'ready' : 'missing',
    revision: records.length ? assessmentHash('b') : null,
    records,
    canRecord: true,
    error: null,
  };
}
export function assessmentPreview(): IncidentAssessmentPreview {
  return {
    schema: 'stroq-incident-assessment-preview/1',
    id: assessmentId('1'),
    recordId: assessmentId('2'),
    createdAt: assessmentAt,
    expiresAt: '2026-10-24T10:02:00.000Z',
    incident: assessmentBinding(),
    assessment: 'accepted-risk',
    reason: 'intended-workflow',
    previousAssessmentId: null,
    storeRevision: null,
  };
}
export function assessmentReceipt(
  operation: IncidentAssessmentReceipt['operation'] = 'record',
): IncidentAssessmentReceipt {
  return {
    schema: 'stroq-incident-assessment-receipt/1',
    operation,
    checkedAt: assessmentAt,
    status: 'recorded',
    recordId: assessmentRecord().id,
    expectedEvidenceSha: assessmentHash('a'),
    revision: assessmentHash('b'),
    record: assessmentRecord(),
  };
}
