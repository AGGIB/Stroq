import { describe, expect, it } from 'vitest';
import { ACTION_CLASSES } from '../../packages/core/src/types';
import {
  ACTION_LABELS,
  COMPARISON_LIMITATIONS,
  validateIncidentComparison,
} from './incident-comparison';
const fixture = () => ({
  schema: 'stroq-incident-comparison/1',
  source: 'local',
  incidentId: `incident-${'a'.repeat(64)}`,
  evidenceSha: 'a'.repeat(64),
  comparedAt: '2026-10-23T09:00:00.000Z',
  currentPolicy: { source: 'built-in', semanticSha: 'b'.repeat(64), rawSha: null, rules: 15 },
  previousEffect: 'deny',
  classes: ['shell.network'],
  scopeRecorded: false,
  scenarios: [
    { taint: 'none', effect: 'allow', matchedRule: null },
    {
      taint: 'suspect',
      effect: 'deny',
      matchedRule: { index: 3, classes: ['shell.network'], taint: 'suspect' },
    },
  ],
  relation: 'mixed',
  limitations: [...COMPARISON_LIMITATIONS],
});
describe('current policy comparison boundary', () => {
  it('labels exactly the engine action classes without inventing new classifications', () => {
    expect(Object.keys(ACTION_LABELS).sort()).toEqual([...ACTION_CLASSES].sort());
    expect(validateIncidentComparison(fixture())).toBe(true);
  });
  it('rejects raw or claimed remediation metadata at every boundary', () => {
    for (const field of ['command', 'sessionId', 'hostBlocked', 'remediated', 'oldTaint'])
      expect(validateIncidentComparison({ ...fixture(), [field]: 'private' })).toBe(false);
    expect(
      validateIncidentComparison({
        ...fixture(),
        currentPolicy: { ...fixture().currentPolicy, path: '/private' },
      }),
    ).toBe(false);
    const value = fixture();
    value.scenarios[1]!.matchedRule = {
      ...value.scenarios[1]!.matchedRule!,
      reason: 'private reason',
    } as never;
    expect(validateIncidentComparison(value)).toBe(false);
  });
  it('binds exact evidence and requires a captured current policy revision', () => {
    expect(
      validateIncidentComparison({ ...fixture(), incidentId: `incident-${'c'.repeat(64)}` }),
    ).toBe(false);
    expect(
      validateIncidentComparison({
        ...fixture(),
        currentPolicy: { ...fixture().currentPolicy, semanticSha: null },
      }),
    ).toBe(false);
    expect(
      validateIncidentComparison({
        ...fixture(),
        currentPolicy: { ...fixture().currentPolicy, source: 'file' },
      }),
    ).toBe(false);
    expect(
      validateIncidentComparison({
        ...fixture(),
        currentPolicy: { ...fixture().currentPolicy, source: 'file', rawSha: 'c'.repeat(64) },
      }),
    ).toBe(true);
  });
  it('requires both taint assumptions and a truthful relation to the recorded effect', () => {
    expect(
      validateIncidentComparison({ ...fixture(), scenarios: fixture().scenarios.slice(0, 1) }),
    ).toBe(false);
    expect(
      validateIncidentComparison({ ...fixture(), scenarios: fixture().scenarios.toReversed() }),
    ).toBe(false);
    expect(validateIncidentComparison({ ...fixture(), relation: 'matchesRecorded' })).toBe(false);
    expect(validateIncidentComparison({ ...fixture(), relation: 'changed' })).toBe(false);
    expect(validateIncidentComparison({ ...fixture(), previousEffect: 'allow' })).toBe(false);
  });
  it('does not silently narrow unknown or duplicated recorded classes', () => {
    expect(
      validateIncidentComparison({
        ...fixture(),
        classes: ['shell.network', 'private-secret-label'],
      }),
    ).toBe(false);
    expect(
      validateIncidentComparison({ ...fixture(), classes: ['shell.network', 'shell.network'] }),
    ).toBe(false);
    expect(validateIncidentComparison({ ...fixture(), classes: undefined })).toBe(false);
  });
  it('bounds rule ordinals and requires a known matching predicate', () => {
    for (const rule of [
      { index: 15, classes: ['shell.network'], taint: 'suspect' },
      { index: -1, classes: ['shell.network'], taint: 'suspect' },
      { index: 3, classes: ['fs.secrets'], taint: 'suspect' },
      { index: 3, classes: [], taint: 'suspect' },
      { index: 3, classes: ['shell.network'], taint: 'none' },
    ]) {
      const value = fixture();
      value.scenarios[1]!.matchedRule = rule;
      expect(validateIncidentComparison(value)).toBe(false);
    }
  });
  it('accepts explicit empty classes as default-only scenarios, with original context still unknown', () => {
    const scenarios = ['none', 'suspect'].map((taint) => ({
      taint,
      effect: 'allow',
      matchedRule: null,
    }));
    expect(
      validateIncidentComparison({
        ...fixture(),
        classes: [],
        scenarios,
        relation: 'changed',
        currentPolicy: { ...fixture().currentPolicy, rules: 0 },
      }),
    ).toBe(true);
  });
  it('requires the full fixed limitations and allows the scope-presence flag without claiming a replay', () => {
    expect(validateIncidentComparison({ ...fixture(), scopeRecorded: true })).toBe(true);
    expect(validateIncidentComparison({ ...fixture(), limitations: [] })).toBe(false);
    expect(
      validateIncidentComparison({
        ...fixture(),
        limitations: [...COMPARISON_LIMITATIONS, 'arbitrary policy reason'],
      }),
    ).toBe(false);
  });
});
