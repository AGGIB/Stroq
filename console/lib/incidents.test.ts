import { describe, it, expect } from 'vitest';
import { validateIncident, validateIncidents, validateJournalVerification } from './incidents';
const incident = {
  id: `incident-${'a'.repeat(64)}`,
  evidenceSha: 'b'.repeat(64),
  recordedAt: '2026-10-23T01:00:00.000Z',
  sequence: 12,
  kind: 'policy-deny',
  severity: 'high',
  title: 'Policy denied a tool call',
  categories: ['execution'],
  relatedIds: [],
  secretReferences: 0,
  status: 'open',
  reviewedAt: null,
};
describe('incident evidence boundary', () => {
  it('accepts policy intent without accepting a forged host-blocked claim', () => {
    expect(validateIncident(incident)).toBe(true);
    expect(validateIncident({ ...incident, hostBlocked: true })).toBe(false);
    expect(validateIncident({ ...incident, title: 'Agent stopped an attack' })).toBe(false);
    expect(validateIncident({ ...incident, raw: 'private command' })).toBe(false);
  });
  it('requires manual review timestamps and preserves refused/incomplete reads', () => {
    expect(validateIncident({ ...incident, status: 'reviewed' })).toBe(false);
    expect(
      validateIncidents({
        schema: 'stroq-incidents/1',
        source: 'local',
        generatedAt: incident.recordedAt,
        window: { kind: 'refused', truncated: false, omitted: 0 },
        incidents: [],
        limitations: ['Journal could not be read.'],
      }),
    ).toBe(true);
  });
  it('requires full digest and counts for consistent chain evidence', () => {
    const value = {
      schema: 'stroq-journal-verification/1',
      source: 'local',
      status: 'consistent',
      verifiedAt: incident.recordedAt,
      journalSha: 'c'.repeat(64),
      count: 12,
      brokenAt: null,
      limitations: ['Consistency does not establish authenticity.'],
    };
    expect(validateJournalVerification(value)).toBe(true);
    expect(validateJournalVerification({ ...value, journalSha: null })).toBe(false);
    expect(validateJournalVerification({ ...value, brokenAt: 4 })).toBe(false);
  });
});
