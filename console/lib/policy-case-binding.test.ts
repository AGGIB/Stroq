import { describe, expect, it } from 'vitest';
import {
  COMPARISON_LIMITATIONS,
  validateIncidentComparison,
  type IncidentComparison,
} from './incident-comparison';
import {
  CASE_LIMITATIONS,
  validatePolicyCaseReceipt,
  validatePolicyCases,
  type PolicyCase,
  type PolicyCaseReceipt,
  type PolicyCasesState,
} from './policy-cases';
import {
  capturedStoreMatchesComparison,
  caseMatchesComparison,
  removedReceiptMatches,
  saveReceiptMatches,
} from './policy-case-binding';

const workspace = 'workspace-' + 'a'.repeat(24);
const other = 'workspace-' + 'b'.repeat(24);
const sha = 'c'.repeat(64);
const comparison: IncidentComparison = {
  schema: 'stroq-incident-comparison/1',
  source: 'local',
  incidentId: `incident-${sha}`,
  evidenceSha: sha,
  comparedAt: '2026-10-23T12:00:00.000Z',
  currentPolicy: { source: 'file', semanticSha: 'd'.repeat(64), rawSha: 'e'.repeat(64), rules: 2 },
  previousEffect: 'ask',
  classes: ['shell.network', 'mcp.call'],
  scopeRecorded: false,
  scenarios: [
    { taint: 'none', effect: 'allow', matchedRule: null },
    { taint: 'suspect', effect: 'deny', matchedRule: null },
  ],
  relation: 'changed',
  limitations: [...COMPARISON_LIMITATIONS],
};
const record: PolicyCase = {
  id: 'case-' + 'f'.repeat(64),
  createdAt: '2026-10-23T12:01:00.000Z',
  source: { incidentId: comparison.incidentId, evidenceSha: sha, workspaceId: workspace },
  classes: ['mcp.call', 'shell.network'],
  expected: [
    { taint: 'none', effect: 'allow' },
    { taint: 'suspect', effect: 'deny' },
  ],
};
const receipt: PolicyCaseReceipt = {
  schema: 'stroq-policy-case-receipt/1',
  status: 'saved',
  caseId: record.id,
  revision: '1'.repeat(64),
  completedAt: '2026-10-23T12:01:00.000Z',
  workspaceId: workspace,
  record,
  hostEnforcement: false,
};
const state: PolicyCasesState = {
  schema: 'stroq-policy-cases/1',
  source: 'local',
  workspaceId: workspace,
  generatedAt: '2026-10-23T12:00:00.000Z',
  revision: null,
  cases: [],
  report: {
    policy: {
      source: comparison.currentPolicy.source,
      semanticSha: comparison.currentPolicy.semanticSha,
      rawSha: comparison.currentPolicy.rawSha,
    },
    total: 0,
    passed: 0,
    failed: 0,
    results: [],
    hostEnforcement: false,
  },
  limitations: [...CASE_LIMITATIONS],
};

describe('saved policy check consent binding', () => {
  it('binds a save to both policy revisions and the selected workspace', () => {
    expect(validateIncidentComparison(comparison)).toBe(true);
    expect(validatePolicyCases(state)).toBe(true);
    expect(validatePolicyCaseReceipt(receipt)).toBe(true);
    expect(capturedStoreMatchesComparison(state, comparison, workspace)).toBe(true);
    expect(capturedStoreMatchesComparison(state, comparison, other)).toBe(false);
    expect(
      capturedStoreMatchesComparison(
        {
          ...state,
          report: { ...state.report, policy: { ...state.report.policy, rawSha: '2'.repeat(64) } },
        },
        comparison,
        workspace,
      ),
    ).toBe(false);
    expect(
      capturedStoreMatchesComparison(
        {
          ...state,
          report: {
            ...state.report,
            policy: { ...state.report.policy, semanticSha: '2'.repeat(64) },
          },
        },
        comparison,
        workspace,
      ),
    ).toBe(false);
  });
  it('compares the complete class set and both exact expected outcomes', () => {
    expect(caseMatchesComparison(record, comparison)).toBe(true);
    expect(caseMatchesComparison({ ...record, classes: ['shell.network'] }, comparison)).toBe(
      false,
    );
    expect(
      caseMatchesComparison(
        {
          ...record,
          expected: [
            { taint: 'none', effect: 'allow' },
            { taint: 'suspect', effect: 'ask' },
          ],
        },
        comparison,
      ),
    ).toBe(false);
    expect(caseMatchesComparison(record, { ...comparison, classes: [] })).toBe(false);
  });
  it('requires a newly saved receipt to retain the exact event and source context', () => {
    expect(saveReceiptMatches(receipt, comparison, workspace)).toBe(true);
    expect(saveReceiptMatches({ ...receipt, workspaceId: other }, comparison, workspace)).toBe(
      false,
    );
    expect(
      saveReceiptMatches({ ...receipt, caseId: 'case-' + '2'.repeat(64) }, comparison, workspace),
    ).toBe(false);
    expect(
      saveReceiptMatches(
        { ...receipt, record: { ...record, source: { ...record.source, workspaceId: other } } },
        comparison,
        workspace,
      ),
    ).toBe(false);
    expect(
      saveReceiptMatches(
        {
          ...receipt,
          record: {
            ...record,
            source: {
              ...record.source,
              incidentId: 'incident-' + '2'.repeat(64),
              evidenceSha: '2'.repeat(64),
            },
          },
        },
        comparison,
        workspace,
      ),
    ).toBe(false);
  });
  it('accepts unchanged global checks with their first source preserved, but no altered expectations', () => {
    const existing = {
      ...record,
      source: {
        incidentId: 'incident-' + '2'.repeat(64),
        evidenceSha: '2'.repeat(64),
        workspaceId: other,
      },
    };
    expect(
      saveReceiptMatches(
        { ...receipt, status: 'unchanged', record: existing },
        comparison,
        workspace,
      ),
    ).toBe(true);
    expect(
      saveReceiptMatches(
        { ...receipt, status: 'unchanged', record: { ...existing, classes: ['mcp.call'] } },
        comparison,
        workspace,
      ),
    ).toBe(false);
  });
  it('accepts removal only for its exact case and current context, without a retained record', () => {
    const removed: PolicyCaseReceipt = { ...receipt, status: 'removed', record: null };
    expect(removedReceiptMatches(removed, record.id, workspace)).toBe(true);
    expect(removedReceiptMatches(removed, record.id, other)).toBe(false);
    expect(removedReceiptMatches(removed, 'case-' + '2'.repeat(64), workspace)).toBe(false);
    expect(removedReceiptMatches(receipt, record.id, workspace)).toBe(false);
  });
});
