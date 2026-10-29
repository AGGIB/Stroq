import { describe, expect, it } from 'vitest';
import { incidentAssessmentExport } from './incident-assessment-export';
import {
  assessmentBinding,
  assessmentPreview,
  assessmentRecord,
  assessmentState,
} from './incident-assessment-fixtures';
import type { Incident } from './incidents';

function finding(): Incident {
  const binding = assessmentBinding();
  return {
    id: binding.id,
    evidenceSha: binding.evidenceSha256,
    sequence: binding.sequence,
    recordedAt: binding.recordedAt,
    kind: binding.kind,
    severity: 'high',
    title: 'Policy denied a tool call',
    categories: ['network'],
    relatedIds: [],
    secretReferences: 0,
    status: 'open',
    reviewedAt: null,
  };
}
describe('finding-scoped operator assessment exports', () => {
  it('retains exact history while exporting pending completion independently of a matching saved row', () => {
    const preview = assessmentPreview();
    const report = incidentAssessmentExport(
      assessmentState([assessmentRecord()]),
      [{ preview, startedAt: preview.createdAt }],
      [finding()],
    );
    expect(report.schema).toBe('stroq-operator-assessments-export/1');
    expect(report.records).toEqual([assessmentRecord()]);
    expect(report.completionUnknown).toBe(true);
    expect(report.pending[0]).toMatchObject({
      recordId: preview.recordId,
      incident: preview.incident,
      assessment: preview.assessment,
      reason: preview.reason,
    });
    expect(JSON.stringify(report)).not.toContain(preview.id);
    expect(Object.keys(report.pending[0]!)).not.toContain('storeRevision');
  });
  it('filters history and pending saves by full binding, never just a matching id', () => {
    const selected = { ...finding(), sequence: 13 };
    const report = incidentAssessmentExport(
      assessmentState([assessmentRecord()]),
      [{ preview: assessmentPreview(), startedAt: assessmentPreview().createdAt }],
      [selected],
    );
    expect(report.records).toEqual([]);
    expect(report.pending).toEqual([]);
    expect(report.completionUnknown).toBe(false);
  });
  it('refuses malformed private fields and marks an invalid pending projection incomplete', () => {
    const report = incidentAssessmentExport(
      { ...assessmentState([assessmentRecord()]), raw: 'PRIVATE_SECRET_NOTE' },
      [
        {
          preview: { ...assessmentPreview(), command: 'PRIVATE_COMMAND' },
          startedAt: 'PRIVATE_PATH',
        },
      ] as any,
      [finding()],
    );
    expect(report.historyStatus).toBe('unavailable');
    expect(report.records).toEqual([]);
    expect(report.pending).toEqual([]);
    expect(report.completionUnknown).toBe(true);
    expect(report.projectionIncomplete).toBe(true);
    expect(JSON.stringify(report)).not.toMatch(/PRIVATE|previewId|storeRevision/);
  });
  it('does not mutate evidence, pending candidates or history', () => {
    const state = assessmentState([assessmentRecord()]),
      pending = [{ preview: assessmentPreview(), startedAt: assessmentPreview().createdAt }],
      selected = [finding()];
    const before = JSON.stringify({ state, pending, selected });
    incidentAssessmentExport(state, pending, selected);
    expect(JSON.stringify({ state, pending, selected })).toBe(before);
  });
});
