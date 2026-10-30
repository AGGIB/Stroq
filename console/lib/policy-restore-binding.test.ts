import { governanceRestoreDiff } from './mcp-governance-fixtures';
import { describe, expect, it } from 'vitest';
import {
  validatePolicyHistoryState,
  validatePolicyRestorePreview,
  type PolicyHistoryEntry,
  type PolicyHistoryState,
  type PolicyRestorePreview,
  type PolicyRestoreReceipt,
} from './policy-history';
import {
  policyRestorePreviewMatches,
  policyRestoreReceiptMatches,
  policyRestoreApplyInput,
} from './policy-restore-binding';
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  otherId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  sha = 'a'.repeat(64),
  current = 'b'.repeat(64),
  candidate = 'c'.repeat(64),
  runtime = 'd'.repeat(64),
  at = '2026-10-24T01:00:00.000Z',
  expiry = '2026-10-24T01:10:00.000Z',
  now = Date.parse(at);
function fixture() {
  const entry: PolicyHistoryEntry = {
    id,
    recordedAt: at,
    beforeRawSha: sha,
    afterRawSha: current,
    afterPolicyFingerprint: current,
    recordSha256: sha,
    recovery: 'backup',
  };
  const state: PolicyHistoryState = {
    schema: 'stroq-policy-history/1',
    scope: 'stroq-home',
    runtimeSha256: runtime,
    currentRawSha: current,
    currentPolicyFingerprint: current,
    currentValid: true,
    history: { status: 'ready', limited: false },
    entries: [entry],
    restoreAvailable: true,
  };
  const preview: PolicyRestorePreview = {
    schema: 'stroq-policy-restore-preview/2',
    mcpGovernance: governanceRestoreDiff(),
    previewId: otherId,
    expiresAt: expiry,
    entryId: id,
    recordSha256: sha,
    runtimeSha256: runtime,
    expectedRawSha: current,
    currentPolicyFingerprint: current,
    candidateRawSha: sha,
    candidateFingerprint: candidate,
    target: 'backup',
    scope: 'stroq-home',
    hostEnforcement: false,
    settings: {
      current: { defaultEffect: 'deny', threshold: 0.7, rules: 12 },
      candidate: { defaultEffect: 'ask', threshold: 0.4, rules: 8 },
    },
    check: { ok: true, loaded: true, faults: 0, findings: [] },
    simulation: {
      ok: true,
      replayed: { attack: 36, ordinary: 75, cases: 0 },
      attacksPassing: 0,
      newInterruptions: 0,
      relieved: 0,
      violations: 0,
      notJudged: 0,
    },
    regressions: { revision: null, total: 0, passed: 0, failed: 0, results: [] },
    interruptions: [],
    interruptionsTruncated: false,
    decisions: [],
    blockers: [],
  };
  const receipt: PolicyRestoreReceipt = {
    schema: 'stroq-policy-restore-receipt/1',
    restored: true,
    entryId: id,
    receiptId: otherId,
    restoredAt: at,
    target: 'backup',
    scope: 'stroq-home',
    hostEnforcement: false,
    policyFingerprint: candidate,
    rawSha: sha,
    backupId: otherId,
    runtimeSha256: runtime,
  };
  return { entry, state, preview, receipt };
}
const ack = { sharedScope: true, reducedProtection: true, backup: true, interruptions: false };
describe('tested policy restore source and consent binding', () => {
  it('binds the exact retained record and current raw/semantic/runtime source', () => {
    const { entry, state, preview } = fixture();
    expect(validatePolicyHistoryState(state)).toBe(true);
    expect(validatePolicyRestorePreview(preview)).toBe(true);
    expect(policyRestorePreviewMatches(preview, state, entry, now)).toBe(true);
    for (const value of [
      { ...preview, entryId: otherId },
      { ...preview, recordSha256: current },
      { ...preview, expectedRawSha: sha },
      { ...preview, currentPolicyFingerprint: sha },
      { ...preview, runtimeSha256: sha },
      { ...preview, candidateRawSha: current },
      { ...preview, expiresAt: at },
    ])
      expect(policyRestorePreviewMatches(value, state, entry, now)).toBe(false);
  });
  it('requires each acknowledgement independently and sends only the opaque approved plan', () => {
    const { preview } = fixture();
    for (const name of ['sharedScope', 'reducedProtection', 'backup'] as const)
      expect(policyRestoreApplyInput(preview, { ...ack, [name]: false }, now)).toBeNull();
    expect(policyRestoreApplyInput(preview, ack, now)).toEqual({
      previewId: otherId,
      entryId: id,
      recordSha256: sha,
      expectedRawSha: current,
      candidateFingerprint: candidate,
      acknowledgeSharedScope: true,
      acknowledgeReducedProtection: true,
      acknowledgeBackup: true,
      acknowledgeInterruptions: false,
    });
  });
  it('does not bypass failed checks/saved cases or preview expiry', () => {
    const { preview } = fixture();
    expect(
      policyRestoreApplyInput(
        {
          ...preview,
          blockers: ['attacks-allowed'],
          simulation: { ...preview.simulation, ok: false, attacksPassing: 1 },
        },
        ack,
        now,
      ),
    ).toBeNull();
    expect(policyRestoreApplyInput(preview, ack, Date.parse(expiry))).toBeNull();
  });
  it('requires interruption consent only when its real count is positive', () => {
    const { preview } = fixture();
    preview.simulation.newInterruptions = 1;
    preview.interruptions = [{ label: 'Read a source file', step: 1, from: 'allow', to: 'deny' }];
    expect(validatePolicyRestorePreview(preview)).toBe(true);
    expect(policyRestoreApplyInput(preview, ack, now)).toBeNull();
    expect(policyRestoreApplyInput(preview, { ...ack, interruptions: true }, now)).not.toBeNull();
  });
  it('preserves absent-current and CURRENT-default semantics without inventing retained historical bytes', () => {
    const { entry, state, preview, receipt } = fixture();
    state.currentRawSha = null;
    preview.expectedRawSha = null;
    receipt.backupId = null;
    expect(policyRestorePreviewMatches(preview, state, entry, now)).toBe(true);
    expect(policyRestoreReceiptMatches(receipt, preview)).toBe(true);
    entry.beforeRawSha = null;
    entry.recovery = 'current-default';
    preview.target = 'current-default';
    preview.candidateRawSha = null;
    receipt.target = 'current-default';
    receipt.rawSha = null;
    expect(policyRestorePreviewMatches(preview, state, entry, now)).toBe(true);
    expect(policyRestoreReceiptMatches(receipt, preview)).toBe(true);
  });
  it('rejects unrelated receipts and impossible recovery metadata instead of displaying success', () => {
    const { preview, receipt } = fixture();
    expect(policyRestoreReceiptMatches(receipt, preview)).toBe(true);
    for (const value of [
      { ...receipt, entryId: otherId },
      { ...receipt, runtimeSha256: sha },
      { ...receipt, policyFingerprint: current },
      { ...receipt, rawSha: current },
      { ...receipt, backupId: null },
      { ...receipt, rawText: 'private' },
    ])
      expect(policyRestoreReceiptMatches(value, preview)).toBe(false);
  });
});
