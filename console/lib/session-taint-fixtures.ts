import type {
  SessionTaintInspection,
  SessionTaintPreview,
  SessionTaintRecord,
  SessionTaintReceipt,
  SessionTaintState,
} from './session-taint';
export const taintWs = `workspace-${'a'.repeat(24)}`;
export const taintAt = '2026-10-24T10:00:00.000Z';
export const taintHash = (digit: string) => digit.repeat(64);
export function taintInspection(): SessionTaintInspection {
  return {
    schema: 'stroq-session-taint-inspection/1',
    workspaceId: taintWs,
    incident: {
      id: `incident-${taintHash('a')}`,
      evidenceSha256: taintHash('a'),
      sequence: 12,
      recordedAt: '2026-10-24T09:00:00.000Z',
    },
    sessionRef: `session-${taintHash('b')}`,
    checkedAt: taintAt,
    revisionSha256: taintHash('c'),
    taint: {
      status: 'suspect',
      sources: 2,
      since: '2026-10-24T09:00:00.000Z',
      sha256: taintHash('d'),
    },
    provenance: {
      sha256: taintHash('e'),
      records: 5,
      suspect: 1,
      incomplete: false,
      digestsLost: false,
      pending: 0,
    },
  };
}
export function taintPreview(): SessionTaintPreview {
  return {
    schema: 'stroq-session-taint-preview/1',
    id: '11111111-1111-4111-8111-111111111111',
    recordId: '22222222-2222-4222-8222-222222222222',
    createdAt: taintAt,
    expiresAt: '2026-10-24T10:02:00.000Z',
    inspection: taintInspection(),
    weakensRestrictions: true,
    provenancePreserved: true,
    privateRecovery: true,
    hostEnforcement: false,
  };
}
export function taintRecord(): SessionTaintRecord {
  const before = taintInspection();
  return {
    id: taintPreview().recordId,
    revisionSha256: taintHash('f'),
    createdAt: taintAt,
    updatedAt: taintAt,
    status: 'cleared',
    before,
    afterTaintSha256: taintHash('1'),
    preservedProvenanceSha256: before.provenance.sha256,
    recoveryAvailable: true,
    current: {
      ...before,
      revisionSha256: taintHash('2'),
      taint: { status: 'clear', sources: 0, since: null, sha256: taintHash('1') },
    },
    error: null,
  };
}
export function taintReceipt(
  operation: SessionTaintReceipt['operation'] = 'clear',
): SessionTaintReceipt {
  return {
    schema: 'stroq-session-taint-receipt/1',
    operation,
    checkedAt: taintAt,
    writeConfirmed: true,
    record: taintRecord(),
  };
}
export function taintHistory(records: SessionTaintRecord[] = []): SessionTaintState {
  return {
    schema: 'stroq-session-taint/1',
    workspaceId: taintWs,
    generatedAt: taintAt,
    available: true,
    history: records.length ? 'ready' : 'missing',
    error: null,
    records,
  };
}
