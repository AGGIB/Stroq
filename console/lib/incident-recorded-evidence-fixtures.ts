import type { Incident } from './incidents';
import { EVIDENCE_LIMITATIONS, type IncidentRecordedEvidence } from './incident-recorded-evidence';

export const recordedEvidenceAt = '2026-10-26T08:00:00.000Z';
export function recordedFinding(digit = 'a'): Incident {
  return {
    id: `incident-${digit.repeat(64)}`,
    evidenceSha: digit.repeat(64),
    sequence: 1,
    recordedAt: recordedEvidenceAt,
    kind: 'policy-deny',
    severity: 'high',
    title: 'Policy denied a tool call',
    categories: ['network'],
    relatedIds: [],
    secretReferences: 0,
    status: 'open',
    reviewedAt: null,
  };
}
export function recordedEvidence(incident = recordedFinding()): IncidentRecordedEvidence {
  const { id, evidenceSha, sequence, recordedAt, kind } = incident;
  return {
    schema: 'stroq-incident-recorded-evidence/1',
    source: 'local',
    capturedAt: recordedEvidenceAt,
    binding: { id, evidenceSha, sequence, recordedAt, kind },
    effect: kind === 'policy-deny' ? 'deny' : kind === 'policy-ask' ? 'ask' : null,
    window: { truncated: false, omitted: 0 },
    classes: { status: 'recorded', values: ['shell.network', 'origin.untrusted'], omitted: 0 },
    scope: { status: 'recorded', kind: 'policy' },
    provenance: { status: 'recorded', values: [{ kind: 'url', count: 2, suspect: 1 }], omitted: 0 },
    provenanceIncomplete: { status: 'recorded', values: [], omitted: 0 },
    scan: kind === 'content-flag' ? { status: 'recorded', score: 0.8, trusted: null } : null,
    limitations: [...EVIDENCE_LIMITATIONS],
  };
}
