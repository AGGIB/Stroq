import { describe, expect, it } from 'vitest';
import type { IncidentTaskReport } from './incident-task';
import {
  incidentTaskKey,
  incidentTaskReportMatches,
  incidentTaskHref,
} from './incident-task-binding';
const ws = `workspace-${'a'.repeat(24)}`,
  sha = 'b'.repeat(64);
const incident = {
  id: `incident-${sha}`,
  evidenceSha: sha,
  sequence: 7,
  recordedAt: '2026-10-23T01:00:00.000Z',
};
const report = {
  workspaceId: ws,
  incident: { id: incident.id, evidenceSha256: sha, sequence: 7, recordedAt: incident.recordedAt },
  status: 'matched',
  task: { id: `task-${'c'.repeat(64)}`, permitSha256: 'd'.repeat(64) },
} as IncidentTaskReport;
describe('exact finding to current permission binding', () => {
  it('fences immutable selected evidence and workspace without accepting raw selectors', () => {
    expect(incidentTaskKey(incident, ws)).toBeTruthy();
    expect(incidentTaskKey(null, ws)).toBeNull();
    expect(incidentTaskKey(incident, null)).toBeNull();
    expect(incidentTaskKey({ ...incident, id: 'private' }, ws)).toBeNull();
    expect(incidentTaskKey({ ...incident, evidenceSha: 'e'.repeat(64) }, ws)).toBeNull();
    expect(incidentTaskKey({ ...incident, sequence: 8 }, ws)).not.toBe(
      incidentTaskKey(incident, ws),
    );
  });
  it('requires selected raw SHA, sequence, time and current workspace, regardless of result status', () => {
    expect(incidentTaskReportMatches(report, incident, ws)).toBe(true);
    expect(
      incidentTaskReportMatches(
        { ...report, workspaceId: `workspace-${'e'.repeat(24)}` },
        incident,
        ws,
      ),
    ).toBe(false);
    expect(
      incidentTaskReportMatches(
        { ...report, incident: { ...report.incident, sequence: 8 } },
        incident,
        ws,
      ),
    ).toBe(false);
    expect(
      incidentTaskReportMatches(
        { ...report, incident: { ...report.incident, recordedAt: '2026-10-23T01:00:01.000Z' } },
        incident,
        ws,
      ),
    ).toBe(false);
    expect(
      incidentTaskReportMatches({ ...report, status: 'not-recorded', task: null }, incident, ws),
    ).toBe(true);
  });
  it('hands off only a matched current permit with its exact SHA and finding return reference', () => {
    const href = incidentTaskHref(report);
    const params = new URL(href!, 'http://local.test').searchParams;
    expect(params.get('task')).toBe(report.task!.id);
    expect(params.get('workspace')).toBe(ws);
    expect(params.get('permit')).toBe(report.task!.permitSha256);
    expect(params.get('incident')).toBe(incident.id);
    expect(incidentTaskHref({ ...report, status: 'permit-unavailable', task: null })).toBeNull();
  });
});
