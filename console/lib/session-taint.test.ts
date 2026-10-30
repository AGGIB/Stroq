import { describe, expect, it } from 'vitest';
import {
  validateSessionTaintInspection,
  validateSessionTaintPreview,
  validateSessionTaintRecord,
  validateSessionTaintReceipt,
  validateSessionTaintState,
} from './session-taint';
import {
  taintHash,
  taintHistory,
  taintInspection,
  taintPreview,
  taintReceipt,
  taintRecord,
} from './session-taint-fixtures';
describe('session taint closed public boundary', () => {
  it('accepts a measured point-in-time taint reset without deleting learned origins', () => {
    expect(validateSessionTaintInspection(taintInspection())).toBe(true);
    expect(validateSessionTaintPreview(taintPreview())).toBe(true);
    expect(validateSessionTaintRecord(taintRecord())).toBe(true);
    expect(validateSessionTaintReceipt(taintReceipt())).toBe(true);
    expect(validateSessionTaintState(taintHistory([taintRecord()]))).toBe(true);
  });
  it('rejects private fields, opaque-reference confusion, contradictory taint and unbounded facts', () => {
    const value = taintInspection();
    for (const bad of [
      { ...value, sessionId: 'private' },
      { ...value, source: '/private/path' },
      { ...value, sessionRef: 'session-1234567890abcdef' },
      { ...value, taint: { ...value.taint, sources: 0 } },
      { ...value, taint: { ...value.taint, status: 'clear' } },
      { ...value, provenance: { ...value.provenance, suspect: 6 } },
      { ...value, provenance: { ...value.provenance, pending: 1.5 } },
      { ...value, taint: { ...value.taint, tool: 'Read' } },
    ])
      expect(validateSessionTaintInspection(bad)).toBe(false);
  });
  it('rejects stale-duration, no-op, unacknowledged-effect and raw-payload previews', () => {
    const value = taintPreview();
    for (const bad of [
      { ...value, expiresAt: value.createdAt },
      { ...value, expiresAt: '2026-10-24T10:02:00.001Z' },
      { ...value, provenancePreserved: false },
      { ...value, hostEnforcement: true },
      { ...value, backup: 'private' },
      {
        ...value,
        inspection: {
          ...value.inspection,
          taint: { status: 'clear', sources: 0, since: null, sha256: null },
        },
      },
    ])
      expect(validateSessionTaintPreview(bad)).toBe(false);
    expect(
      validateSessionTaintPreview({
        ...value,
        inspection: {
          ...value.inspection,
          provenance: { ...value.inspection.provenance, pending: 1 },
        },
      }),
    ).toBe(false);
  });
  it('keeps historical reset confirmation separate from later taint or unavailable readback', () => {
    const record = taintRecord();
    expect(
      validateSessionTaintRecord({
        ...record,
        current: { ...record.before, revisionSha256: taintHash('9') },
      }),
    ).toBe(true);
    expect(
      validateSessionTaintReceipt({
        ...taintReceipt(),
        record: { ...record, current: null, error: 'session-unavailable' },
      }),
    ).toBe(true);
    for (const bad of [
      { ...record, preservedProvenanceSha256: taintHash('9') },
      { ...record, afterTaintSha256: record.before.taint.sha256 },
      { ...record, current: null },
      { ...record, current: { ...record.current, sessionRef: `session-${taintHash('9')}` } },
    ])
      expect(validateSessionTaintRecord(bad)).toBe(false);
    const later = {
      ...record,
      current: { ...record.current!, checkedAt: '2026-10-24T10:00:00.001Z' },
    };
    expect(validateSessionTaintRecord(later)).toBe(true);
    expect(validateSessionTaintReceipt({ ...taintReceipt(), record: later })).toBe(false);
    expect(validateSessionTaintState(taintHistory([later]))).toBe(false);
    expect(
      validateSessionTaintState({ ...taintHistory([later]), generatedAt: later.current.checkedAt }),
    ).toBe(true);
  });
  it('keeps a historical original-taint observation valid after later taint changes or unavailable readback', () => {
    const record = {
      ...taintRecord(),
      status: 'unchanged' as const,
      afterTaintSha256: null,
      preservedProvenanceSha256: null,
    };
    const changed = {
      ...record,
      current: {
        ...taintInspection(),
        revisionSha256: taintHash('9'),
        taint: { ...taintInspection().taint, sources: 3, sha256: taintHash('8') },
      },
    };
    const unavailable = { ...record, current: null, error: 'session-unavailable' as const };
    for (const value of [changed, unavailable]) {
      expect(validateSessionTaintRecord(value)).toBe(true);
      expect(validateSessionTaintState(taintHistory([value]))).toBe(true);
      expect(
        validateSessionTaintReceipt({
          ...taintReceipt('recheck'),
          writeConfirmed: false,
          record: value,
        }),
      ).toBe(true);
      expect(
        validateSessionTaintReceipt({
          ...taintReceipt('recheck'),
          writeConfirmed: true,
          record: value,
        }),
      ).toBe(false);
    }
    expect(validateSessionTaintRecord({ ...unavailable, error: null })).toBe(false);
    expect(validateSessionTaintRecord({ ...changed, afterTaintSha256: taintHash('7') })).toBe(
      false,
    );
    expect(
      validateSessionTaintRecord({
        ...changed,
        preservedProvenanceSha256: record.before.provenance.sha256,
      }),
    ).toBe(false);
  });
  it('refuses foreign or duplicate records and a successful receipt for an unresolved intent', () => {
    const record = taintRecord();
    expect(
      validateSessionTaintState({ ...taintHistory([record]), records: [record, record] }),
    ).toBe(false);
    expect(
      validateSessionTaintState({
        ...taintHistory([record]),
        workspaceId: `workspace-${'f'.repeat(24)}`,
      }),
    ).toBe(false);
    expect(
      validateSessionTaintState({
        ...taintHistory([record]),
        available: false,
        history: 'unavailable',
        error: 'history-unavailable',
      }),
    ).toBe(false);
    expect(
      validateSessionTaintReceipt({
        ...taintReceipt(),
        record: { ...record, status: 'uncertain' },
      }),
    ).toBe(false);
    expect(
      validateSessionTaintReceipt({
        ...taintReceipt(),
        operation: 'recheck',
        writeConfirmed: false,
        record: {
          ...record,
          status: 'uncertain',
          afterTaintSha256: null,
          preservedProvenanceSha256: null,
        },
      }),
    ).toBe(true);
    expect(validateSessionTaintRecord({ ...record, status: 'prepared' })).toBe(false);
  });
});
