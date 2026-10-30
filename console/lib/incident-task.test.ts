import { describe, expect, it } from 'vitest';
import {
  INCIDENT_TASK_LIMITATIONS,
  validateIncidentTaskReport,
  type IncidentTaskReport,
} from './incident-task';

const sha = 'a'.repeat(64);
const at = '2026-10-23T00:00:00.000Z';
function report(): IncidentTaskReport {
  return {
    schema: 'stroq-incident-task/1',
    workspaceId: `workspace-${'b'.repeat(24)}`,
    incident: { id: `incident-${sha}`, evidenceSha256: sha, sequence: 1, recordedAt: at },
    checkedAt: at,
    currentPolicySha256: sha,
    status: 'matched',
    journal: { status: 'verified', sha256: sha },
    relation: 'task-id-only',
    historicalPermitRelation: 'not-recorded',
    sessionRelation: 'matches',
    task: {
      id: `task-${sha}`,
      permitSha256: sha,
      profile: 'code',
      policySha256: sha,
      issuedAt: at,
      expiresAt: '2026-10-23T01:00:00.000Z',
      declaredMode: 'hook-only',
      eligibility: 'eligible',
      standing: 'present',
      policyRelation: 'matches-current',
      scope: {
        tools: ['Read'],
        shell: 'denied',
        read: { allow: [], deny: [] },
        write: { allow: [], deny: [] },
        net: { mode: 'none' },
        mcp: [],
      },
      evidence: {
        status: 'verified',
        journalSha256: sha,
        counts: {
          calls: 0,
          allowed: 0,
          denied: 0,
          asks: 0,
          hostReported: 0,
          hostFailure: 0,
          unconfirmed: 0,
        },
        lastGate: null,
      },
    },
    limitations: INCIDENT_TASK_LIMITATIONS,
  };
}

describe('incident to current permission boundary', () => {
  it('accepts an explicit ID-only current capture, including an ended permit', () => {
    expect(validateIncidentTaskReport(report())).toBe(true);
    const value = report();
    value.task!.standing = 'ended';
    value.sessionRelation = 'unavailable';
    expect(validateIncidentTaskReport(value)).toBe(true);
  });
  it('rejects raw signing, session and command data at every boundary', () => {
    expect(validateIncidentTaskReport({ ...report(), sessionId: 'private' })).toBe(false);
    expect(
      validateIncidentTaskReport({
        ...report(),
        incident: { ...report().incident, command: 'private' },
      }),
    ).toBe(false);
    expect(
      validateIncidentTaskReport({ ...report(), task: { ...report().task, nonce: 'private' } }),
    ).toBe(false);
  });
  it('requires exact incident ID, evidence SHA, sequence and canonical times', () => {
    const value = report();
    value.incident.id = `incident-${'c'.repeat(64)}`;
    expect(validateIncidentTaskReport(value)).toBe(false);
    expect(
      validateIncidentTaskReport({ ...report(), incident: { ...report().incident, sequence: 0 } }),
    ).toBe(false);
    expect(
      validateIncidentTaskReport({
        ...report(),
        incident: { ...report().incident, recordedAt: '2026-10-23' },
      }),
    ).toBe(false);
  });
  it('cannot convert current metadata into a historical revision or session match', () => {
    expect(validateIncidentTaskReport({ ...report(), historicalPermitRelation: 'matches' })).toBe(
      false,
    );
    expect(validateIncidentTaskReport({ ...report(), sessionRelation: 'differs' })).toBe(false);
    expect(validateIncidentTaskReport({ ...report(), relation: 'same-permit' })).toBe(false);
  });
  it('binds matched evidence and policy/eligibility to the actual capture', () => {
    expect(
      validateIncidentTaskReport({
        ...report(),
        journal: { status: 'verified', sha256: 'c'.repeat(64) },
      }),
    ).toBe(false);
    expect(validateIncidentTaskReport({ ...report(), checkedAt: '2026-10-24T00:00:00.000Z' })).toBe(
      false,
    );
    expect(validateIncidentTaskReport({ ...report(), currentPolicySha256: null })).toBe(false);
    const value = report();
    value.currentPolicySha256 = null;
    value.task!.policyRelation = 'unavailable';
    value.checkedAt = '2026-10-24T00:00:00.000Z';
    value.task!.eligibility = 'expired';
    expect(validateIncidentTaskReport(value)).toBe(true);
  });
  it('does not hand off a current permit that contradicts the event time', () => {
    const value = report();
    value.incident.recordedAt = '2026-10-22T23:58:59.999Z';
    expect(validateIncidentTaskReport(value)).toBe(false);
    value.incident.recordedAt = '2026-10-22T23:59:00.000Z';
    expect(validateIncidentTaskReport(value)).toBe(true);
    value.incident.recordedAt = value.task!.expiresAt;
    expect(validateIncidentTaskReport(value)).toBe(false);
  });
  it('requires explicit unavailable evidence and never invents a task from failed capture', () => {
    for (const status of ['missing', 'broken', 'limit', 'unavailable'] as const) {
      const value = {
        ...report(),
        status: 'evidence-unavailable',
        journal: { status, sha256: null },
        relation: 'none',
        sessionRelation: 'unavailable',
        task: null,
      };
      expect(validateIncidentTaskReport(value)).toBe(true);
      expect(validateIncidentTaskReport({ ...value, task: report().task })).toBe(false);
    }
    expect(
      validateIncidentTaskReport({
        ...report(),
        status: 'evidence-unavailable',
        task: null,
        relation: 'none',
      }),
    ).toBe(false);
  });
  it('keeps nonmatches distinct and requires full journal evidence for each', () => {
    for (const status of [
      'not-recorded',
      'invalid-reference',
      'permit-unavailable',
      'different-workspace',
      'session-mismatch',
      'time-mismatch',
    ] as const) {
      const value = {
        ...report(),
        status,
        task: null,
        relation: 'none',
        sessionRelation: status === 'session-mismatch' ? 'differs' : 'unavailable',
      };
      expect(validateIncidentTaskReport(value)).toBe(true);
      expect(
        validateIncidentTaskReport({ ...value, journal: { status: 'broken', sha256: sha } }),
      ).toBe(false);
    }
  });
  it('requires fixed limitations and rejects missing or contradictory proof', () => {
    expect(validateIncidentTaskReport({ ...report(), limitations: [] })).toBe(false);
    expect(
      validateIncidentTaskReport({ ...report(), journal: { status: 'verified', sha256: null } }),
    ).toBe(false);
    const value = report();
    value.task!.evidence = { status: 'broken', journalSha256: sha, counts: null, lastGate: null };
    expect(validateIncidentTaskReport(value)).toBe(false);
  });
});
