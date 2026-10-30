import { describe, expect, it } from 'vitest';
import {
  taintAt,
  taintHash,
  taintInspection,
  taintPreview,
  taintReceipt,
  taintRecord,
  taintWs,
} from './session-taint-fixtures';
import {
  sessionTaintInspectionMatches,
  sessionTaintPreviewMatches,
  sessionTaintReceiptMatches,
  sameSessionTaintRecord,
  sessionTaintConfirmRecheck,
  sessionTaintPendingWrites,
} from './session-taint-binding';
const finding = () => ({
  id: taintInspection().incident.id,
  evidenceSha: taintHash('a'),
  sequence: 12,
  recordedAt: '2026-10-24T09:00:00.000Z',
});
describe('exact stored session taint action bindings', () => {
  it('binds every finding fact and workspace without using a public activity session alias', () => {
    expect(sessionTaintInspectionMatches(taintInspection(), finding(), taintWs)).toBe(true);
    for (const change of [
      { sequence: 13 },
      { evidenceSha: taintHash('f') },
      { recordedAt: taintAt },
    ])
      expect(
        sessionTaintInspectionMatches(taintInspection(), { ...finding(), ...change }, taintWs),
      ).toBe(false);
    expect(
      sessionTaintInspectionMatches(taintInspection(), finding(), `workspace-${'b'.repeat(24)}`),
    ).toBe(false);
  });
  it('requires the exact inspected revision and all captured taint/provenance facts for a preview', () => {
    expect(sessionTaintPreviewMatches(taintPreview(), taintInspection())).toBe(true);
    for (const inspection of [
      { ...taintInspection(), revisionSha256: taintHash('9') },
      { ...taintInspection(), taint: { ...taintInspection().taint, sources: 3 } },
      { ...taintInspection(), provenance: { ...taintInspection().provenance, records: 6 } },
    ])
      expect(sessionTaintPreviewMatches({ ...taintPreview(), inspection }, taintInspection())).toBe(
        false,
      );
  });
  it('accepts historical clear even when the fresh state is unavailable or suspect again, but refuses wrong record or stale receipt', () => {
    expect(sessionTaintReceiptMatches(taintReceipt(), taintPreview(), taintAt)).toBe(true);
    expect(
      sessionTaintReceiptMatches(
        {
          ...taintReceipt(),
          record: { ...taintRecord(), current: null, error: 'session-unavailable' },
        },
        taintPreview(),
        taintAt,
      ),
    ).toBe(true);
    expect(
      sessionTaintReceiptMatches(
        { ...taintReceipt(), record: { ...taintRecord(), current: taintInspection() } },
        taintPreview(),
        taintAt,
      ),
    ).toBe(true);
    expect(
      sessionTaintReceiptMatches(taintReceipt(), taintPreview(), '2026-10-24T10:00:00.001Z'),
    ).toBe(false);
    expect(
      sessionTaintReceiptMatches(
        { ...taintReceipt(), record: { ...taintRecord(), id: taintPreview().id } },
        taintPreview(),
        taintAt,
      ),
    ).toBe(false);
    expect(
      sameSessionTaintRecord(
        { ...taintRecord(), before: { ...taintInspection(), revisionSha256: taintHash('9') } },
        taintRecord(),
      ),
    ).toBe(false);
  });
  it('only an explicit exact conclusive recheck clears a retained uncertain write', () => {
    const transport = () => {};
    const pending = sessionTaintPendingWrites(transport);
    pending.set(taintPreview().recordId, { preview: taintPreview(), startedAt: taintAt });
    const uncertain = {
      ...taintReceipt('recheck'),
      writeConfirmed: false,
      record: {
        ...taintRecord(),
        status: 'uncertain' as const,
        afterTaintSha256: null,
        preservedProvenanceSha256: null,
      },
    };
    expect(sessionTaintConfirmRecheck(transport, uncertain)).toBe(false);
    expect(pending.size).toBe(1);
    expect(sessionTaintConfirmRecheck(transport, taintReceipt())).toBe(false);
    expect(sessionTaintConfirmRecheck(transport, taintReceipt('recheck'))).toBe(true);
    expect(pending.size).toBe(0);
  });
});
