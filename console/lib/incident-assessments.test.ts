import { describe, expect, it } from 'vitest';
import {
  INCIDENT_ASSESSMENT_LABELS,
  INCIDENT_ASSESSMENT_REASONS,
  INCIDENT_ASSESSMENT_REASON_DECISIONS,
  assessmentReasonMatches,
  incidentAssessmentMatchesPreview,
  latestIncidentAssessment,
  sameIncidentAssessmentBinding,
  validateIncidentAssessmentBinding,
  validateIncidentAssessmentRecord,
  validateIncidentAssessmentState,
  validateIncidentAssessmentPreview,
  validateIncidentAssessmentReceipt,
} from './incident-assessments';
import {
  assessmentAt,
  assessmentBinding,
  assessmentHash,
  assessmentId,
  assessmentPreview,
  assessmentReceipt,
  assessmentRecord,
  assessmentState,
} from './incident-assessment-fixtures';

describe('incident assessments closed public boundary', () => {
  it('accepts the finite metadata contract without adding workspace attribution or protection effects', () => {
    expect(validateIncidentAssessmentBinding(assessmentBinding())).toBe(true);
    expect(validateIncidentAssessmentRecord(assessmentRecord())).toBe(true);
    expect(validateIncidentAssessmentState(assessmentState())).toBe(true);
    expect(validateIncidentAssessmentState(assessmentState([assessmentRecord()]))).toBe(true);
    expect(validateIncidentAssessmentPreview(assessmentPreview())).toBe(true);
    expect(validateIncidentAssessmentReceipt(assessmentReceipt())).toBe(true);
    expect(incidentAssessmentMatchesPreview(assessmentRecord(), assessmentPreview())).toBe(true);
  });
  it('closes every finite assessment/reason pair and labels assessments as operator judgements', () => {
    expect(INCIDENT_ASSESSMENT_LABELS['confirmed-issue']).toBe('Marked as issue');
    for (const [reason, decision] of Object.entries(INCIDENT_ASSESSMENT_REASON_DECISIONS)) {
      expect(assessmentReasonMatches(decision, reason)).toBe(true);
      expect(
        INCIDENT_ASSESSMENT_REASONS[reason as keyof typeof INCIDENT_ASSESSMENT_REASONS],
      ).toBeTruthy();
      for (const other of Object.keys(INCIDENT_ASSESSMENT_LABELS).filter((v) => v !== decision))
        expect(assessmentReasonMatches(other, reason)).toBe(false);
    }
    for (const pair of [
      ['safe', 'benign-content'],
      ['false-positive', 'controlled-test'],
      ['reopened', 'insufficient-data'],
      ['toString', '__proto__'],
    ])
      expect(assessmentReasonMatches(...(pair as [string, string]))).toBe(false);
  });
  it('refuses raw/private fields, malformed identities and noncanonical times without inferring source clock authority', () => {
    const binding = assessmentBinding(),
      record = assessmentRecord();
    for (const bad of [
      { ...binding, workspaceId: 'workspace-guessed' },
      { ...binding, sessionId: 'raw' },
      { ...binding, id: `incident-${assessmentHash('b')}` },
      { ...binding, sequence: 0 },
      { ...binding, sequence: Number.MAX_SAFE_INTEGER + 1 },
      { ...binding, sequence: 1.5 },
      { ...binding, recordedAt: '2026-10-24T09:00:00Z' },
      { ...binding, kind: 'allow' },
      { ...binding, evidenceSha256: 'A'.repeat(64) },
    ])
      expect(validateIncidentAssessmentBinding(bad)).toBe(false);
    for (const bad of [
      { ...record, note: 'private' },
      { ...record, actor: 'authenticated' },
      { ...record, id: 'record-2' },
      { ...record, previousAssessmentId: record.id },
      { ...record, assessment: 'false-positive' },
      { ...record, assessment: 'reopened', reason: 'reassess' },
      { ...record, assessedAt: '2026-10-24T10:00:00Z' },
      { ...record, incident: { ...binding, command: 'raw' } },
    ])
      expect(validateIncidentAssessmentRecord(bad)).toBe(false);
    expect(
      validateIncidentAssessmentRecord({
        ...record,
        incident: { ...binding, recordedAt: '2026-10-24T10:05:00.000Z' },
      }),
    ).toBe(true);
  });
  it('validates append order and per-finding previous links without sorting or dropping earlier decisions', () => {
    const a = assessmentRecord();
    const b = {
      ...a,
      id: assessmentId('3'),
      assessment: 'reopened' as const,
      reason: 'reassess' as const,
      previousAssessmentId: a.id,
    };
    const c = {
      ...a,
      id: assessmentId('4'),
      assessment: 'confirmed-issue' as const,
      reason: 'unintended-action' as const,
      previousAssessmentId: b.id,
    };
    expect(validateIncidentAssessmentState(assessmentState([a, b, c]))).toBe(true);
    for (const records of [
      [a, a],
      [b],
      [a, c],
      [a, b, { ...b, id: assessmentId('5'), previousAssessmentId: b.id }],
      [a, { ...a, id: assessmentId('3'), previousAssessmentId: a.id }],
      [a, { ...b, incident: { ...b.incident, sequence: 13 } }],
      [a, { ...b, incident: { ...b.incident, kind: 'content-flag' as const } }],
      [a, { ...b, assessedAt: '2026-10-24T09:59:59.999Z' }],
      [a, { ...b, assessedAt: '2026-10-24T10:00:00.001Z' }],
    ])
      expect(validateIncidentAssessmentState(assessmentState(records))).toBe(false);
  });
  it('keeps independent incident chains exact even when timestamps tie or journal sequences arrive out of order', () => {
    const a = assessmentRecord();
    const other = {
      ...a,
      id: assessmentId('3'),
      incident: {
        ...a.incident,
        id: `incident-${assessmentHash('c')}`,
        evidenceSha256: assessmentHash('c'),
        sequence: 3,
      },
    };
    const b = {
      ...a,
      id: assessmentId('4'),
      assessment: 'reopened' as const,
      reason: 'new-evidence' as const,
      previousAssessmentId: a.id,
    };
    expect(validateIncidentAssessmentState(assessmentState([a, other, b]))).toBe(true);
    expect(
      validateIncidentAssessmentState(
        assessmentState([a, { ...other, previousAssessmentId: a.id }]),
      ),
    ).toBe(false);
    expect(latestIncidentAssessment([a, other, b], a.incident)).toEqual(b);
    expect(latestIncidentAssessment([a, other], { ...a.incident, sequence: 99 })).toBe(null);
    expect(
      sameIncidentAssessmentBinding(a.incident, { ...a.incident, recordedAt: assessmentAt }),
    ).toBe(false);
  });
  it('retains full history when full and refuses unavailable/missing/ready contradictions and over-limit arrays', () => {
    const ready = assessmentState([assessmentRecord()]);
    expect(
      validateIncidentAssessmentState({ ...ready, canRecord: false, error: 'store-full' }),
    ).toBe(true);
    expect(
      validateIncidentAssessmentState({
        ...assessmentState(),
        history: 'unavailable',
        canRecord: false,
        error: 'history-unavailable',
      }),
    ).toBe(true);
    for (const bad of [
      { ...ready, scope: 'workspace' },
      { ...ready, revision: null },
      { ...ready, history: 'missing', revision: null },
      {
        ...ready,
        history: 'unavailable',
        revision: null,
        canRecord: false,
        error: 'history-unavailable',
      },
      { ...ready, canRecord: true, error: 'store-full' },
      { ...ready, canRecord: false },
      { ...ready, canRecord: false, error: 'history-unavailable' },
      { ...assessmentState(), revision: assessmentHash('b') },
      { ...assessmentState(), history: 'unavailable', canRecord: true, error: null },
      { ...ready, error: 'new-error' },
      { ...ready, canRecord: false, error: 'runtime-unavailable' },
      { ...ready, records: Array(513).fill(assessmentRecord()) },
      { ...ready, originalBytes: 'raw' },
    ])
      expect(validateIncidentAssessmentState(bad)).toBe(false);
  });
  it('keeps an actual 512-event chain but refuses new admission, overflow, holes and reordered history', () => {
    const id = (index: number) =>
      `${index.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`;
    const records = Array.from({ length: 512 }, (_, index) => ({
      ...assessmentRecord(),
      id: id(index + 1),
      assessment: index % 2 ? ('confirmed-issue' as const) : ('accepted-risk' as const),
      reason: index % 2 ? ('unintended-action' as const) : ('intended-workflow' as const),
      previousAssessmentId: index ? id(index) : null,
    }));
    const full = { ...assessmentState(records), canRecord: false, error: 'store-full' };
    expect(validateIncidentAssessmentState(full)).toBe(true);
    expect(validateIncidentAssessmentState({ ...full, canRecord: true, error: null })).toBe(false);
    expect(
      validateIncidentAssessmentState({
        ...full,
        records: [
          ...records,
          {
            ...assessmentRecord(),
            id: id(513),
            previousAssessmentId: id(512),
          },
        ],
      }),
    ).toBe(false);
    expect(validateIncidentAssessmentState(assessmentState(Array(1)))).toBe(false);
    expect(
      validateIncidentAssessmentState({
        ...full,
        records: [records[1], records[0], ...records.slice(2)],
      }),
    ).toBe(false);
  });
  it('requires exactly two-minute previews with exact binding and a valid previous assessment shape', () => {
    const value = assessmentPreview();
    for (const bad of [
      { ...value, expiresAt: value.createdAt },
      { ...value, expiresAt: '2026-10-24T10:02:00.001Z' },
      { ...value, id: value.recordId },
      { ...value, previousAssessmentId: value.recordId },
      { ...value, storeRevision: null, previousAssessmentId: assessmentId('3') },
      { ...value, assessment: 'reopened', reason: 'new-evidence' },
      { ...value, rawEvidence: '{}' },
      { ...value, incident: { ...value.incident, rule: 'raw' } },
      { ...value, storeRevision: 'not-a-hash' },
    ])
      expect(validateIncidentAssessmentPreview(bad)).toBe(false);
    expect(
      validateIncidentAssessmentPreview({
        ...value,
        incident: { ...value.incident, recordedAt: '2026-10-24T10:05:00.000Z' },
      }),
    ).toBe(true);
    expect(
      validateIncidentAssessmentPreview({
        ...value,
        storeRevision: assessmentHash('b'),
        previousAssessmentId: assessmentId('3'),
        assessment: 'reopened',
        reason: 'new-evidence',
      }),
    ).toBe(true);
  });
  it('accepts point-in-time absence only for an explicit recheck and correlates recorded receipts exactly', () => {
    const value = assessmentReceipt();
    expect(
      validateIncidentAssessmentReceipt({
        ...value,
        operation: 'recheck',
        status: 'not-present',
        record: null,
        revision: null,
      }),
    ).toBe(true);
    for (const bad of [
      { ...value, status: 'not-present', record: null },
      { ...value, record: null },
      { ...value, revision: null },
      { ...value, recordId: assessmentId('3') },
      { ...value, expectedEvidenceSha: assessmentHash('c') },
      { ...value, checkedAt: '2026-10-24T09:59:59.999Z' },
      { ...value, operation: 'recheck', status: 'not-present' },
      { ...value, operation: 'recheck', status: 'not-present', record: null, revision: 'invalid' },
      { ...value, neverWritten: true },
    ])
      expect(validateIncidentAssessmentReceipt(bad)).toBe(false);
  });
  it('matches a pending preview using all immutable fields and the permitted publication interval', () => {
    const value = assessmentRecord(),
      preview = assessmentPreview();
    for (const record of [
      { ...value, id: assessmentId('3') },
      { ...value, incident: { ...value.incident, sequence: 13 } },
      { ...value, incident: { ...value.incident, kind: 'policy-ask' as const } },
      { ...value, reason: 'controlled-test' as const },
      { ...value, previousAssessmentId: assessmentId('4') },
      { ...value, assessedAt: '2026-10-24T09:59:59.999Z' },
      { ...value, assessedAt: '2026-10-24T10:02:00.001Z' },
    ])
      expect(incidentAssessmentMatchesPreview(record, preview)).toBe(false);
    expect(
      incidentAssessmentMatchesPreview({ ...value, assessedAt: preview.expiresAt }, preview),
    ).toBe(true);
  });
});
