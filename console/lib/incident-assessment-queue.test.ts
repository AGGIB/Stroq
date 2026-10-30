import { describe, expect, it } from 'vitest';
import {
  assessmentBinding,
  assessmentId,
  assessmentRecord,
  assessmentState,
} from './incident-assessment-fixtures';
import type { Incident, IncidentsState } from './incidents';
import {
  incidentAssessmentIndex,
  assessmentForIncident,
  incidentAssessmentRows,
} from './incident-assessment-queue';

function incident(): Incident {
  const binding = assessmentBinding();
  return {
    id: binding.id,
    evidenceSha: binding.evidenceSha256,
    sequence: binding.sequence,
    recordedAt: binding.recordedAt,
    kind: binding.kind,
    severity: 'high',
    title: 'Policy denied a tool call',
    categories: ['execution'],
    relatedIds: [],
    secretReferences: 0,
    status: 'open',
    reviewedAt: null,
  };
}
function evidence(items = [incident()]): IncidentsState {
  return {
    schema: 'stroq-incidents/1',
    source: 'local',
    generatedAt: '2026-10-24T10:00:00.000Z',
    window: { kind: 'available', truncated: false, omitted: 0 },
    incidents: items,
    limitations: [],
  };
}
describe('operator assessment attention', () => {
  it('keeps unassessed exact findings in attention and links across the review filter', () => {
    const i = {
      ...incident(),
      status: 'reviewed' as const,
      reviewedAt: '2026-10-24T09:30:00.000Z',
    };
    const rows = incidentAssessmentRows(evidence([i]), assessmentState());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe('1 recorded finding needs attention');
    expect(rows[0]?.href).toBe(`/incidents/?status=all&id=${i.id}`);
    expect(rows[0]?.detail).toContain('1 unassessed');
    expect(incidentAssessmentRows(evidence([]), assessmentState())).toEqual([]);
  });
  it('omits only exact accepted-risk and false-positive assessments from assessment attention', () => {
    for (const [assessment, reason] of [
      ['accepted-risk', 'intended-workflow'],
      ['false-positive', 'incorrect-match'],
    ] as const) {
      const record = { ...assessmentRecord(), assessment, reason };
      const state = assessmentState([record]);
      expect(incidentAssessmentRows(evidence(), state)).toEqual([]);
      const newer = {
        ...incident(),
        id: `incident-${'f'.repeat(64)}`,
        evidenceSha: 'f'.repeat(64),
      };
      expect(incidentAssessmentRows(evidence([newer]), state)).toHaveLength(1);
    }
  });
  it('keeps marked issues and reopened assessments actionable even after Reviewed', () => {
    const reviewed = {
      ...incident(),
      status: 'reviewed' as const,
      reviewedAt: incident().recordedAt,
    };
    const confirmed = {
      ...assessmentRecord(),
      assessment: 'confirmed-issue' as const,
      reason: 'unintended-action' as const,
    };
    expect(
      incidentAssessmentRows(evidence([reviewed]), assessmentState([confirmed]))[0]?.detail,
    ).toContain('1 marked as issue');
    const reopened = {
      ...assessmentRecord(),
      id: assessmentId('3'),
      assessment: 'reopened' as const,
      reason: 'reassess' as const,
      previousAssessmentId: assessmentRecord().id,
    };
    expect(
      incidentAssessmentRows(
        evidence([reviewed]),
        assessmentState([assessmentRecord(), reopened]),
      )[0]?.detail,
    ).toContain('1 reopened');
  });
  it('never applies an assessment with mismatched sequence, time or kind', () => {
    const state = assessmentState([assessmentRecord()]);
    for (const patch of [
      { sequence: 13 },
      { recordedAt: '2026-10-24T09:00:01.000Z' },
      { kind: 'content-flag' as const },
    ]) {
      const i = { ...incident(), ...patch };
      expect(assessmentForIncident(incidentAssessmentIndex(state), i)).toBeNull();
      expect(incidentAssessmentRows(evidence([i]), state)).toHaveLength(1);
    }
  });
  it('unavailable or malformed history cannot mute findings or become Not assessed success', () => {
    const available = assessmentState([assessmentRecord()]);
    for (const state of [
      null,
      { ...available, privateNotes: 'private' },
      {
        ...available,
        history: 'unavailable',
        revision: null,
        records: [],
        canRecord: false,
        error: 'history-unavailable',
      },
    ]) {
      const rows = incidentAssessmentRows(evidence(), state);
      expect(rows.map((row) => row.key)).toEqual(['incident-assessment-history', 'incidents']);
      expect(rows[0]?.title).toBe('Operator assessments unavailable');
      expect(rows[1]?.detail).toContain('1 assessment unavailable');
      expect(rows[1]?.detail).not.toContain('1 unassessed');
    }
  });
  it('full retained history remains useful but recording capacity is explicit', () => {
    const state = {
      ...assessmentState([assessmentRecord()]),
      canRecord: false,
      error: 'store-full',
    };
    const rows = incidentAssessmentRows(evidence(), state);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe('Assessment history is full');
  });
  it('neither mutates source evidence nor counts assessments outside the captured window', () => {
    const state = assessmentState([assessmentRecord()]),
      source = evidence();
    const before = JSON.stringify({ state, source });
    incidentAssessmentRows(source, state);
    expect(JSON.stringify({ state, source })).toBe(before);
    expect(incidentAssessmentRows(evidence([]), state)).toEqual([]);
  });
  it('an unconfirmed save remains actionable even when an ordinary GET contains the candidate', () => {
    const rows = incidentAssessmentRows(
      evidence(),
      assessmentState([assessmentRecord()]),
      new Set([incident().id]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail).toContain('1 save unconfirmed');
    expect(rows[0]?.href).toContain(incident().id);
  });
  it('opens an uncertain save before a newer unassessed event so its exact recheck is immediately reachable', () => {
    const newer = {
      ...incident(),
      id: `incident-${'f'.repeat(64)}`,
      evidenceSha: 'f'.repeat(64),
      sequence: 13,
    };
    const rows = incidentAssessmentRows(
      evidence([newer, incident()]),
      assessmentState([assessmentRecord()]),
      new Set([incident().id]),
    );
    expect(rows[0]?.href).toBe(`/incidents/?status=all&id=${incident().id}`);
  });
});
