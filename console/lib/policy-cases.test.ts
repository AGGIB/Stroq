import { describe, it, expect } from 'vitest';
import {
  CASE_LIMITATIONS,
  validatePolicyCases,
  validatePolicyCaseReceipt,
  validatePolicyCaseRegressions,
} from './policy-cases';
const row = {
  id: 'case-' + 'a'.repeat(64),
  createdAt: '2026-10-23T00:00:00.000Z',
  source: {
    incidentId: 'incident-' + 'b'.repeat(64),
    evidenceSha: 'b'.repeat(64),
    workspaceId: 'workspace-' + 'c'.repeat(24),
  },
  classes: ['mcp.call', 'shell.network'],
  expected: [
    { taint: 'none', effect: 'allow' },
    { taint: 'suspect', effect: 'deny' },
  ],
};
const result = {
  caseId: row.id,
  passed: true,
  scenarios: [
    { taint: 'none', expected: 'allow', actual: 'allow' },
    { taint: 'suspect', expected: 'deny', actual: 'deny' },
  ],
};
const state = {
  schema: 'stroq-policy-cases/1',
  source: 'local',
  workspaceId: row.source.workspaceId,
  generatedAt: row.createdAt,
  revision: 'd'.repeat(64),
  cases: [row],
  report: {
    policy: { source: 'built-in', semanticSha: 'e'.repeat(64), rawSha: null },
    total: 1,
    passed: 1,
    failed: 0,
    results: [result],
    hostEnforcement: false,
  },
  limitations: [...CASE_LIMITATIONS],
};
describe('saved policy-case public boundary', () => {
  it('keeps successful empty state distinct from unverifiable data', () => {
    expect(validatePolicyCases(state)).toBe(true);
    expect(
      validatePolicyCases({
        ...state,
        revision: null,
        cases: [],
        report: { ...state.report, total: 0, passed: 0, failed: 0, results: [] },
      }),
    ).toBe(true);
    expect(validatePolicyCases({ ...state, report: null })).toBe(false);
    expect(validatePolicyCases({ ...state, revision: null })).toBe(false);
  });
  it('rejects fabricated pass counts, changed expectations and duplicate class combinations', () => {
    expect(validatePolicyCases({ ...state, report: { ...state.report, passed: 0 } })).toBe(false);
    expect(
      validatePolicyCases({
        ...state,
        report: {
          ...state.report,
          results: [
            {
              ...result,
              scenarios: [{ taint: 'none', expected: 'deny', actual: 'deny' }, result.scenarios[1]],
            },
          ],
        },
      }),
    ).toBe(false);
    expect(
      validatePolicyCases({ ...state, cases: [row, { ...row, id: 'case-' + 'f'.repeat(64) }] }),
    ).toBe(false);
  });
  it('rejects raw text, unsupported classes, contradictory scope and altered limits', () => {
    for (const record of [
      { ...row, command: 'PRIVATE_COMMAND' },
      { ...row, classes: ['PRIVATE_CLASS'] },
      { ...row, classes: [] },
      { ...row, source: { ...row.source, raw: 'PRIVATE_SOURCE' } },
    ])
      expect(validatePolicyCases({ ...state, cases: [record] })).toBe(false);
    expect(
      validatePolicyCases({ ...state, report: { ...state.report, hostEnforcement: true } }),
    ).toBe(false);
    expect(validatePolicyCases({ ...state, limitations: [] })).toBe(false);
  });
  it('requires both exact fixed taint scenarios and binds saved/remove receipts', () => {
    const receipt = {
      schema: 'stroq-policy-case-receipt/1',
      status: 'saved',
      caseId: row.id,
      revision: state.revision,
      completedAt: row.createdAt,
      workspaceId: state.workspaceId,
      record: row,
      hostEnforcement: false,
    };
    expect(validatePolicyCaseReceipt(receipt)).toBe(true);
    expect(validatePolicyCaseReceipt({ ...receipt, status: 'removed', record: null })).toBe(true);
    expect(validatePolicyCaseReceipt({ ...receipt, status: 'removed' })).toBe(false);
    expect(validatePolicyCaseReceipt({ ...receipt, caseId: 'case-' + 'f'.repeat(64) })).toBe(false);
    expect(
      validatePolicyCaseRegressions({
        revision: state.revision,
        total: 1,
        passed: 1,
        failed: 0,
        results: [result],
      }),
    ).toBe(true);
    expect(
      validatePolicyCaseRegressions({
        revision: state.revision,
        total: 1,
        passed: 1,
        failed: 0,
        results: [{ ...result, scenarios: [result.scenarios[0]] }],
      }),
    ).toBe(false);
  });
});
