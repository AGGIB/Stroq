import { governanceRestoreDiff } from './mcp-governance-fixtures';
import { describe, expect, it } from 'vitest';
import {
  validatePolicyHistoryState,
  validatePolicyRestorePreview,
  validatePolicyRestoreReceipt,
} from './policy-history';
const id = '12345678-1234-4123-8123-123456789abc';
const other = '12345678-1234-4123-8123-123456789abd';
const time = '2026-10-24T01:00:00.000Z';
const sha = 'a'.repeat(64);
const entry = {
  id,
  recordedAt: time,
  beforeRawSha: sha,
  afterRawSha: null,
  afterPolicyFingerprint: sha,
  recordSha256: sha,
  recovery: 'backup',
};
const state = {
  schema: 'stroq-policy-history/1',
  scope: 'stroq-home',
  runtimeSha256: sha,
  currentRawSha: null,
  currentPolicyFingerprint: sha,
  currentValid: true,
  history: { status: 'ready', limited: false },
  entries: [entry],
  restoreAvailable: true,
};
const preview = {
  schema: 'stroq-policy-restore-preview/2',
  mcpGovernance: governanceRestoreDiff(),
  previewId: id,
  expiresAt: time,
  entryId: other,
  recordSha256: sha,
  runtimeSha256: sha,
  expectedRawSha: null,
  currentPolicyFingerprint: sha,
  candidateRawSha: sha,
  candidateFingerprint: sha,
  target: 'backup',
  scope: 'stroq-home',
  hostEnforcement: false,
  settings: {
    current: { defaultEffect: 'allow', threshold: 0.6, rules: 21 },
    candidate: { defaultEffect: 'allow', threshold: 0.5, rules: 21 },
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
  decisions: [{ actionClass: 'network.fetch', taint: 'suspect', from: 'deny', to: 'allow' }],
  blockers: [],
};
const receipt = {
  schema: 'stroq-policy-restore-receipt/1',
  restored: true,
  entryId: other,
  receiptId: id,
  restoredAt: time,
  target: 'current-default',
  scope: 'stroq-home',
  hostEnforcement: false,
  policyFingerprint: sha,
  rawSha: null,
  backupId: null,
  runtimeSha256: sha,
};
describe('policy history boundary', () => {
  it('accepts recorded absence without claiming a historical default or proven application', () => {
    expect(validatePolicyHistoryState(state)).toBe(true);
    expect(
      validatePolicyHistoryState({
        ...state,
        entries: [{ ...entry, beforeRawSha: null, afterRawSha: sha, recovery: 'current-default' }],
      }),
    ).toBe(true);
  });
  it('requires closed metadata, correct recovery/source relation and unique ordered IDs', () => {
    for (const value of [
      { ...state, path: '/private/policy' },
      { ...state, entries: [entry, entry] },
      { ...state, entries: [{ ...entry, recovery: 'current-default' }] },
      { ...state, entries: [{ ...entry, beforeRawSha: null, recovery: 'current-default' }] },
      { ...state, entries: [{ ...entry, command: 'private' }] },
      { ...state, history: { status: 'ready', limited: true } },
      { ...state, currentValid: false },
    ])
      expect(validatePolicyHistoryState(value)).toBe(false);
  });
  it('keeps partial entries usable but never calls unavailable history an empty success', () => {
    expect(
      validatePolicyHistoryState({ ...state, history: { status: 'partial', limited: true } }),
    ).toBe(true);
    expect(
      validatePolicyHistoryState({
        ...state,
        history: { status: 'unavailable', limited: false },
        entries: [],
        restoreAvailable: false,
      }),
    ).toBe(true);
    expect(
      validatePolicyHistoryState({ ...state, history: { status: 'unavailable', limited: false } }),
    ).toBe(false);
  });
  it('accepts both reducing and increasing finite class decisions including zero class changes', () => {
    expect(validatePolicyRestorePreview(preview)).toBe(true);
    expect(validatePolicyRestorePreview({ ...preview, decisions: [] })).toBe(true);
    expect(
      validatePolicyRestorePreview({
        ...preview,
        candidateRawSha: null,
        target: 'current-default',
      }),
    ).toBe(true);
  });
  it('rejects unknown, duplicate, unchanged, disordered or private decisions', () => {
    for (const decisions of [
      [{ ...preview.decisions[0], actionClass: 'private-class' }],
      [preview.decisions[0], preview.decisions[0]],
      [{ ...preview.decisions[0], to: 'deny' }],
      [{ ...preview.decisions[0], reason: 'private' }],
      [
        { ...preview.decisions[0], taint: 'suspect' },
        { ...preview.decisions[0], taint: 'none' },
      ],
    ])
      expect(validatePolicyRestorePreview({ ...preview, decisions })).toBe(false);
  });
  it('requires bounded parsed settings and rejects missing, unknown or private setting values', () => {
    for (const settings of [
      undefined,
      { ...preview.settings, command: 'private' },
      { current: preview.settings.current },
      { ...preview.settings, candidate: { ...preview.settings.candidate, raw: 'private' } },
      { ...preview.settings, candidate: { ...preview.settings.candidate, defaultEffect: 'clean' } },
      ...[-0.1, 1.1, NaN, Infinity, '0.5'].map((threshold) => ({
        ...preview.settings,
        candidate: { ...preview.settings.candidate, threshold },
      })),
      ...[-1, 513, 1.5, '21'].map((rules) => ({
        ...preview.settings,
        current: { ...preview.settings.current, rules },
      })),
    ])
      expect(validatePolicyRestorePreview({ ...preview, settings })).toBe(false);
    expect(validatePolicyRestorePreview(preview)).toBe(true);
  });
  it('rejects private nested fields, raw YAML, impossible blocker counts and truncated details', () => {
    for (const value of [
      { ...preview, candidateText: 'private-yaml' },
      {
        ...preview,
        check: {
          ...preview.check,
          findings: [{ kind: 'private-kind', severity: 'error', count: 1 }],
        },
      },
      { ...preview, blockers: ['attacks-allowed'] },
      { ...preview, interruptionsTruncated: true },
      { ...preview, target: 'current-default' },
      { ...preview, simulation: { ...preview.simulation, command: 'private' } },
    ])
      expect(validatePolicyRestorePreview(value)).toBe(false);
  });
  it('accepts blocked reports and binds every blocker to actual finite test facts', () => {
    const blocked = {
      ...preview,
      simulation: { ...preview.simulation, ok: false, attacksPassing: 1 },
      blockers: ['attacks-allowed'],
    };
    expect(validatePolicyRestorePreview(blocked)).toBe(true);
    expect(validatePolicyRestorePreview({ ...blocked, blockers: [] })).toBe(false);
  });
  it('distinguishes a committed file restore from selecting the current bundled default', () => {
    expect(validatePolicyRestoreReceipt(receipt)).toBe(true);
    expect(
      validatePolicyRestoreReceipt({ ...receipt, target: 'backup', rawSha: sha, backupId: other }),
    ).toBe(true);
    expect(validatePolicyRestoreReceipt({ ...receipt, target: 'backup' })).toBe(false);
    expect(validatePolicyRestoreReceipt({ ...receipt, rawSha: sha })).toBe(false);
    expect(validatePolicyRestoreReceipt({ ...receipt, hostEnforcement: true })).toBe(false);
  });
});

it('refuses old Restore previews or missing MCP gate evidence', () => {
  const { mcpGovernance, ...missing } = preview;
  expect(validatePolicyRestorePreview(missing)).toBe(false);
  expect(
    validatePolicyRestorePreview({ ...preview, schema: 'stroq-policy-restore-preview/1' }),
  ).toBe(false);
  expect(
    validatePolicyRestorePreview({
      ...preview,
      mcpGovernance: { ...mcpGovernance, registrationPinned: true },
    }),
  ).toBe(false);
});
