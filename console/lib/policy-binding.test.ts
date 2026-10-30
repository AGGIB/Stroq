import { describe, expect, it } from 'vitest';
import { policyApplyInput, policyPreviewMatches, policyReceiptMatches } from './policy-binding';
import type { PolicyState, PolicyPreview } from './policy-control';
const state: PolicyState = {
  schema: 'stroq-policy/1',
  source: 'default',
  expectedRawSha: null,
  policyFingerprint: 'a'.repeat(64),
  defaultEffect: 'allow',
  threshold: 0.6,
  rules: [],
  check: { ok: true, loaded: true, faults: 0, findings: [] },
  editable: true,
};
const preview: PolicyPreview = {
  previewId: '12345678-1234-1234-1234-123456789abc',
  expiresAt: '2099-01-01T00:00:00.000Z',
  expectedRawSha: null,
  candidateFingerprint: 'b'.repeat(64),
  currentPolicyFingerprint: 'a'.repeat(64),
  changes: [
    { field: 'class-deny', actionClass: 'shell.network', from: 'current-policy', to: 'deny' },
  ],
  check: state.check,
  simulation: {
    ok: true,
    replayed: { attack: 36, ordinary: 75, cases: 0 },
    attacksPassing: 0,
    newInterruptions: 0,
    relieved: 0,
    violations: 0,
    notJudged: 0,
  },
  blockers: [],
  requiresInterruptionAcknowledgement: false,
  interruptions: [],
  interruptionsTruncated: false,
  regressions: { revision: null, total: 0, passed: 0, failed: 0, results: [] },
  actionControl: {
    classes: ['shell.network'],
    removedRules: 0,
    narrowedRules: 0,
    taint: 'any',
    scope: 'stroq-home',
    hostEnforcement: false,
  },
};
describe('policy request and receipt bindings', () => {
  it('binds a class preview to the source policy and exact requested controls', () => {
    expect(policyPreviewMatches(preview, state, { denyActionClasses: ['shell.network'] })).toBe(
      true,
    );
    expect(policyPreviewMatches(preview, state, { denyActionClasses: ['mcp.call'] })).toBe(false);
    expect(
      policyPreviewMatches({ ...preview, currentPolicyFingerprint: 'c'.repeat(64) }, state, {
        denyActionClasses: ['shell.network'],
      }),
    ).toBe(false);
    expect(
      policyPreviewMatches({ ...preview, expectedRawSha: 'd'.repeat(64) }, state, {
        denyActionClasses: ['shell.network'],
      }),
    ).toBe(false);
  });
  it('requires independent shared-scope consent and refuses expired or blocked previews', () => {
    expect(policyApplyInput(preview, false, false)).toBe(null);
    expect(policyApplyInput(preview, false, true)?.acknowledgeActionScope).toBe(true);
    expect(policyApplyInput({ ...preview, expiresAt: '2000-01-01T00:00:00Z' }, true, true)).toBe(
      null,
    );
    expect(policyApplyInput({ ...preview, blockers: ['policy-findings'] }, true, true)).toBe(null);
    expect(
      policyApplyInput(
        {
          ...preview,
          regressions: {
            revision: 'c'.repeat(64),
            total: 1,
            passed: 0,
            failed: 1,
            results: [],
          },
        },
        true,
        true,
      ),
    ).toBe(null);
    expect(
      policyApplyInput(
        {
          ...preview,
          requiresInterruptionAcknowledgement: true,
          simulation: { ...preview.simulation, newInterruptions: 1 },
        },
        false,
        true,
      ),
    ).toBe(null);
  });
  it('accepts only the applied candidate and correct private-backup relation', () => {
    const receipt = {
      applied: true,
      receiptId: '12345678-1234-1234-1234-123456789abc',
      appliedAt: '2026-10-23T00:00:00.000Z',
      policyFingerprint: preview.candidateFingerprint,
      rawSha: 'c'.repeat(64),
      backupId: null,
    };
    expect(policyReceiptMatches(receipt, preview)).toBe(true);
    expect(policyReceiptMatches({ ...receipt, policyFingerprint: 'd'.repeat(64) }, preview)).toBe(
      false,
    );
    expect(policyReceiptMatches({ ...receipt, backupId: receipt.receiptId }, preview)).toBe(false);
    expect(
      policyReceiptMatches(
        { ...receipt, backupId: receipt.receiptId },
        { ...preview, expectedRawSha: 'd'.repeat(64) },
      ),
    ).toBe(true);
    expect(
      policyReceiptMatches(
        { ...receipt, backupId: 'wrong' },
        { ...preview, expectedRawSha: 'd'.repeat(64) },
      ),
    ).toBe(false);
  });
});
