import { describe, expect, it } from 'vitest';
import {
  CASE_LIMITATIONS,
  validatePolicyCases,
  type PolicyCase,
  type PolicyCasesState,
} from './policy-cases';
import { policyCaseRows } from './policy-cases-queue';

const workspaceId = 'workspace-' + 'a'.repeat(24);
const other = 'workspace-' + 'b'.repeat(24);
const record: PolicyCase = {
  id: 'case-' + 'c'.repeat(64),
  createdAt: '2026-10-23T12:00:00.000Z',
  source: {
    incidentId: 'incident-' + 'd'.repeat(64),
    evidenceSha: 'd'.repeat(64),
    workspaceId: other,
  },
  classes: ['mcp.call'],
  expected: [
    { taint: 'none', effect: 'allow' },
    { taint: 'suspect', effect: 'deny' },
  ],
};
function state(failed = false, empty = false): PolicyCasesState {
  return {
    schema: 'stroq-policy-cases/1',
    source: 'local',
    workspaceId,
    generatedAt: '2026-10-23T12:00:00.000Z',
    revision: empty ? null : 'e'.repeat(64),
    cases: empty ? [] : [record],
    report: {
      policy: { source: 'built-in', semanticSha: 'f'.repeat(64), rawSha: null },
      total: empty ? 0 : 1,
      passed: empty || failed ? 0 : 1,
      failed: failed && !empty ? 1 : 0,
      results: empty
        ? []
        : [
            {
              caseId: record.id,
              passed: !failed,
              scenarios: [
                { taint: 'none', expected: 'allow', actual: 'allow' },
                { taint: 'suspect', expected: 'deny', actual: failed ? 'ask' : 'deny' },
              ],
            },
          ],
      hostEnforcement: false,
    },
    limitations: [...CASE_LIMITATIONS],
  };
}
describe('saved policy checks in the protection queue', () => {
  it('keeps matching cases and an explicitly empty successful store quiet', () => {
    expect(validatePolicyCases(state())).toBe(true);
    expect(validatePolicyCases(state(false, true))).toBe(true);
    expect(policyCaseRows(state(), workspaceId)).toEqual([]);
    expect(policyCaseRows(state(false, true), workspaceId)).toEqual([]);
  });
  it('shows one expected-decision attention row with case counts and separate taint contexts', () => {
    const snapshot = state(true);
    expect(validatePolicyCases(snapshot)).toBe(true);
    const rows = policyCaseRows(snapshot, workspaceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      key: 'policy-cases-failed',
      tone: 'orange',
      href: '/policies/checks/',
      action: 'Review checks',
    });
    expect(rows[0]?.title).toContain('1');
    expect(rows[0]?.detail).toContain('2 session contexts per check');
    expect(rows[0]?.detail).toContain(snapshot.generatedAt);
    expect(rows[0]?.title).not.toMatch(/attack|breach|protected|blocked/i);
  });
  it('returns one fixed unverified gap for missing evidence or missing context', () => {
    expect(policyCaseRows(null, workspaceId)).toHaveLength(1);
    expect(policyCaseRows(state(), null)).toEqual(policyCaseRows(null, workspaceId));
    expect(policyCaseRows(null, workspaceId)[0]).toMatchObject({
      key: 'policy-cases-unavailable',
      tone: 'orange',
      href: '/policies/checks/',
    });
  });
  it('does not inspect a foreign report, even though checks themselves apply across workspaces', () => {
    const snapshot = { ...state(true), workspaceId: other };
    Object.defineProperty(snapshot, 'report', {
      get() {
        throw new Error('Foreign envelope must not be inspected');
      },
    });
    expect(policyCaseRows(snapshot, workspaceId)).toEqual(policyCaseRows(null, workspaceId));
  });
  it('keeps keys and links stable without advancing or changing the captured evidence', () => {
    const snapshot = state(true),
      before = JSON.stringify(snapshot);
    const first = policyCaseRows(snapshot, workspaceId)[0];
    const later = policyCaseRows(
      { ...snapshot, generatedAt: '2026-10-23T13:00:00.000Z' },
      workspaceId,
    )[0];
    expect(later?.key).toBe(first?.key);
    expect(later?.href).toBe(first?.href);
    expect(JSON.stringify(snapshot)).toBe(before);
  });
});
