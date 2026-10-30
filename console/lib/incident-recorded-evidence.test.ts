import { describe, expect, it } from 'vitest';
import {
  EVIDENCE_LIMITATIONS,
  RECORDED_ORIGIN_KINDS,
  RECORDED_SCOPE_KINDS,
  validateIncidentRecordedEvidence,
} from './incident-recorded-evidence';
import { ACTION_LABELS } from './incident-comparison';

const hash = 'a'.repeat(64);
const collection = () => ({ status: 'recorded', values: [], omitted: 0 });
const report = () => ({
  schema: 'stroq-incident-recorded-evidence/1',
  source: 'local',
  capturedAt: '2026-10-26T10:00:00.000Z',
  binding: {
    id: `incident-${hash}`,
    evidenceSha: hash,
    sequence: 1,
    recordedAt: '2026-10-26T09:59:00.000Z',
    kind: 'policy-deny',
  },
  effect: 'deny',
  window: { truncated: false, omitted: 0 },
  classes: { status: 'recorded', values: ['shell.network'], omitted: 0 },
  scope: { status: 'not-recorded', kind: null },
  provenance: collection(),
  provenanceIncomplete: collection(),
  scan: null,
  limitations: [...EVIDENCE_LIMITATIONS],
});

describe('closed recorded incident evidence schema', () => {
  it('accepts recorded known classes, distinct empty and unavailable collections', () => {
    for (const status of ['recorded', 'not-recorded', 'unavailable']) {
      const value = report();
      value.provenance.status = status;
      expect(validateIncidentRecordedEvidence(value)).toBe(true);
    }
    const value = report();
    value.classes = { status: 'partial', values: ['shell.network'], omitted: 3 };
    expect(validateIncidentRecordedEvidence(value)).toBe(true);
  });

  it('binds exact evidence and finite original effect without inferring historical taint', () => {
    const value = report();
    expect(validateIncidentRecordedEvidence(value)).toBe(true);
    expect(validateIncidentRecordedEvidence({ ...value, effect: 'ask' })).toBe(false);
    expect(validateIncidentRecordedEvidence({ ...value, effect: 'allow' })).toBe(false);
    expect(validateIncidentRecordedEvidence({ ...value, taint: 'suspect' })).toBe(false);
    expect(
      validateIncidentRecordedEvidence({
        ...value,
        binding: { ...value.binding, id: `incident-${'b'.repeat(64)}` },
      }),
    ).toBe(false);
  });

  it('rejects unknown classes, sparse arrays, duplicates and inconsistent omissions', () => {
    const value = report();
    for (const classes of [
      { status: 'recorded', values: ['private-class'], omitted: 0 },
      { status: 'recorded', values: ['shell.network', 'shell.network'], omitted: 0 },
      { status: 'recorded', values: Array(1), omitted: 0 },
      { status: 'partial', values: [], omitted: 0 },
      { status: 'recorded', values: [], omitted: 1 },
      { status: 'not-recorded', values: ['shell.network'], omitted: 0 },
      { status: 'unavailable', values: [], omitted: 1 },
      { status: 'partial', values: [], omitted: 1_000_001 },
    ])
      expect(validateIncidentRecordedEvidence({ ...value, classes })).toBe(false);
  });

  it('accepts only finite scope kinds without custom IDs or fingerprints', () => {
    const value = report();
    expect(
      validateIncidentRecordedEvidence({ ...value, scope: { status: 'recorded', kind: 'scope' } }),
    ).toBe(true);
    for (const scope of [
      { status: 'recorded', kind: null },
      { status: 'unavailable', kind: 'policy' },
      { status: 'recorded', kind: 'custom' },
      { status: 'recorded', kind: 'hard', ruleId: 'PRIVATE' },
    ])
      expect(validateIncidentRecordedEvidence({ ...value, scope })).toBe(false);
  });

  it('bounds aggregate origin evidence and rejects impossible counts or raw strings', () => {
    const value = report();
    const provenance = {
      status: 'partial',
      values: [{ kind: 'url', count: 2, suspect: 1 }],
      omitted: 2,
    };
    expect(validateIncidentRecordedEvidence({ ...value, provenance })).toBe(true);
    for (const rows of [
      [{ kind: 'url', count: 2, suspect: 3 }],
      [{ kind: 'url', count: 0, suspect: 0 }],
      [{ kind: 'url', count: 129, suspect: 0 }],
      [{ kind: 'url', count: 2, suspect: 0, source: 'PRIVATE' }],
      [
        { kind: 'url', count: 2, suspect: 0 },
        { kind: 'url', count: 2, suspect: 0 },
      ],
      [{ kind: 'custom', count: 1, suspect: 0 }],
    ])
      expect(
        validateIncidentRecordedEvidence({ ...value, provenance: { ...provenance, values: rows } }),
      ).toBe(false);
    expect(
      validateIncidentRecordedEvidence({
        ...value,
        provenanceIncomplete: {
          status: 'recorded',
          values: [{ kind: 'digest', count: 1 }],
          omitted: 0,
        },
      }),
    ).toBe(true);
  });

  it('preserves absent trust-exemption evidence and does not call score a probability', () => {
    const value = {
      ...report(),
      binding: { ...report().binding, kind: 'content-flag' },
      effect: null,
    };
    for (const trusted of [true, false, null])
      expect(
        validateIncidentRecordedEvidence({
          ...value,
          scan: { status: 'recorded', score: 0.75, trusted },
        }),
      ).toBe(true);
    expect(
      validateIncidentRecordedEvidence({
        ...value,
        scan: { status: 'unavailable', score: null, trusted: null },
      }),
    ).toBe(true);
    for (const scan of [
      null,
      { status: 'recorded', score: 2, trusted: null },
      { status: 'unavailable', score: 0.5, trusted: null },
      { status: 'recorded', score: 0.5, trusted: 'false' },
    ])
      expect(validateIncidentRecordedEvidence({ ...value, scan })).toBe(false);
    expect(
      validateIncidentRecordedEvidence({
        ...report(),
        scan: { status: 'recorded', score: 0.5, trusted: true },
      }),
    ).toBe(false);
  });

  it('requires the complete fixed limitations and closed bounded window', () => {
    const value = report();
    expect(validateIncidentRecordedEvidence({ ...value, limitations: [] })).toBe(false);
    expect(
      validateIncidentRecordedEvidence({
        ...value,
        window: { truncated: false, omitted: 1_000_001 },
      }),
    ).toBe(false);
    expect(validateIncidentRecordedEvidence({ ...value, capturedAt: 'yesterday' })).toBe(false);
    expect(validateIncidentRecordedEvidence({ ...value, raw: 'PRIVATE' })).toBe(false);
  });

  it('requires canonical class and origin ordering as well as unique values', () => {
    const value = report();
    expect(
      validateIncidentRecordedEvidence({
        ...value,
        classes: { status: 'recorded', values: ['origin.suspect', 'shell.network'], omitted: 0 },
      }),
    ).toBe(false);
    expect(
      validateIncidentRecordedEvidence({
        ...value,
        provenance: {
          status: 'recorded',
          values: [
            { kind: 'host', count: 1, suspect: 1 },
            { kind: 'url', count: 1, suspect: 0 },
          ],
          omitted: 0,
        },
      }),
    ).toBe(false);
    expect(
      validateIncidentRecordedEvidence({
        ...value,
        provenanceIncomplete: {
          status: 'recorded',
          values: [
            { kind: 'digest', count: 1 },
            { kind: 'pkg', count: 1 },
          ],
          omitted: 0,
        },
      }),
    ).toBe(false);
  });

  it('accepts actual bounded projector output for every finite class, scope and origin kind', async () => {
    const backend = await import(new URL('../scripts/incidents-safe.mjs', import.meta.url).href);
    const privateText = 'PRIVATE_RECORDED_PROJECTION';
    const raw = {
      classes: Object.keys(ACTION_LABELS).reverse(),
      provenance: [...RECORDED_ORIGIN_KINDS].reverse().map((kind) => ({
        kind,
        suspect: true,
        at: report().capturedAt,
        source: privateText,
        tool: privateText,
        excerpt: privateText,
      })),
      provenanceIncomplete: [...RECORDED_ORIGIN_KINDS]
        .reverse()
        .map((kind) => ({ kind, excerpt: privateText })),
    };
    for (const kind of RECORDED_SCOPE_KINDS) {
      const projected = backend.projectIncidentRecordedEvidence(
        { ...raw, scope: { ruleId: privateText, kind } },
        report().binding,
        report().capturedAt,
        report().window,
      );
      expect(validateIncidentRecordedEvidence(projected)).toBe(true);
      expect(projected.classes.values).toEqual(Object.keys(ACTION_LABELS));
      expect(projected.provenance.values.map((item: { kind: string }) => item.kind)).toEqual(
        RECORDED_ORIGIN_KINDS,
      );
      expect(projected.limitations).toEqual(EVIDENCE_LIMITATIONS);
      expect(JSON.stringify(projected)).not.toContain(privateText);
    }
  });
});
