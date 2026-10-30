import { describe, it, expect } from 'vitest';
import { validatePolicy, validatePolicyPreview, validatePolicyReceipt } from './policy-control';
import { ACTION_CLASSES } from '../../packages/core/src/types';
const check = { ok: true, loaded: true, faults: 0, findings: [] };
const regressions = { revision: null, total: 0, passed: 0, failed: 0, results: [] };
const state = {
  schema: 'stroq-policy/1',
  source: 'default',
  expectedRawSha: null,
  policyFingerprint: 'a'.repeat(64),
  defaultEffect: 'allow',
  threshold: 0.6,
  rules: [{ index: 0, effect: 'ask', classes: ['shell.network'], taint: 'suspect' }],
  check,
  editable: true,
};
describe('policy editor protocol', () => {
  it('validates defaults with an absent raw file separately from the semantic hash', () =>
    expect(validatePolicy(state)).toBe(true));
  it('rejects raw predicates, invalid indices and non-finite thresholds', () => {
    expect(validatePolicy({ ...state, raw: 'private configuration' })).toBe(false);
    expect(validatePolicy({ ...state, rules: [{ ...state.rules[0], index: 1 }] })).toBe(false);
    expect(validatePolicy({ ...state, threshold: NaN })).toBe(false);
  });
  it('accepts a blocked simulation without inventing a successful apply', () => {
    const preview = {
      previewId: 'preview-123',
      expiresAt: '2026-10-23T01:02:03.000Z',
      expectedRawSha: null,
      candidateFingerprint: 'b'.repeat(64),
      currentPolicyFingerprint: state.policyFingerprint,
      changes: [{ field: 'default', from: 'allow', to: 'ask' }],
      actionControl: null,
      regressions,
      check,
      simulation: {
        ok: false,
        replayed: { attack: 1, ordinary: 2, cases: 0 },
        attacksPassing: 0,
        newInterruptions: 1,
        relieved: 0,
        violations: 0,
        notJudged: 1,
      },
      blockers: ['unjudged-scenarios'],
      requiresInterruptionAcknowledgement: true,
      interruptions: [{ label: 'Read documentation', step: 0, from: 'allow', to: 'ask' }],
      interruptionsTruncated: false,
    };
    expect(validatePolicyPreview(preview)).toBe(true);
    expect(validatePolicyReceipt(preview)).toBe(false);
    expect(
      validatePolicyPreview({ ...preview, simulation: { ...preview.simulation, raw: 'secret' } }),
    ).toBe(false);
  });

  const actionPreview = () => ({
    previewId: 'preview-actions',
    expiresAt: '2026-10-23T01:02:03.000Z',
    expectedRawSha: null,
    candidateFingerprint: 'b'.repeat(64),
    currentPolicyFingerprint: 'a'.repeat(64),
    changes: [
      { field: 'class-deny', actionClass: 'shell.network', from: 'current-policy', to: 'deny' },
    ],
    actionControl: {
      classes: ['shell.network'],
      removedRules: 1,
      narrowedRules: 2,
      taint: 'any',
      scope: 'stroq-home',
      hostEnforcement: false,
    },
    regressions,
    check,
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
  });

  it('accepts only canonical known class controls and checks every class against the core enum', () => {
    expect(validatePolicyPreview(actionPreview())).toBe(true);
    const classes = [...ACTION_CLASSES].sort();
    const preview = actionPreview();
    expect(
      validatePolicyPreview({
        ...preview,
        changes: classes.map((actionClass) => ({
          field: 'class-deny',
          actionClass,
          from: 'current-policy',
          to: 'deny',
        })),
        actionControl: { ...preview.actionControl, classes },
      }),
    ).toBe(true);
  });

  it('rejects missing controls, unsupported scope, enforcement claims and private predicates', () => {
    const preview = actionPreview();
    const { actionControl: _control, ...missing } = preview;
    expect(validatePolicyPreview(missing)).toBe(false);
    for (const patch of [
      { classes: [] },
      { classes: ['PRIVATE_CLASS'] },
      { classes: ['shell.network', 'shell.network'] },
      { classes: ['shell.network', 'mcp.call'] },
      { classes: new Array(1) },
      { removedRules: -1 },
      { narrowedRules: 513 },
      { removedRules: 300, narrowedRules: 300 },
      { taint: 'suspect' },
      { scope: 'workspace' },
      { hostEnforcement: true },
      { reason: 'PRIVATE_REASON' },
      { rules: ['PRIVATE_RULE'] },
    ]) {
      expect(
        validatePolicyPreview({
          ...preview,
          actionControl: { ...preview.actionControl, ...patch },
        }),
      ).toBe(false);
    }
  });

  it('cross-checks exact class diffs and refuses strings from private policy fields', () => {
    const preview = actionPreview();
    expect(validatePolicyPreview({ ...preview, actionControl: null })).toBe(false);
    expect(validatePolicyPreview({ ...preview, changes: [] })).toBe(false);
    expect(
      validatePolicyPreview({ ...preview, changes: [...preview.changes, ...preview.changes] }),
    ).toBe(false);
    for (const patch of [
      { actionClass: 'mcp.call' },
      { actionClass: 'PRIVATE_CLASS' },
      { index: 0 },
      { from: 'PRIVATE_RULE' },
      { to: 'allow' },
      { reason: 'PRIVATE_REASON' },
    ]) {
      expect(
        validatePolicyPreview({ ...preview, changes: [{ ...preview.changes[0], ...patch }] }),
      ).toBe(false);
    }
    expect(
      validatePolicyPreview({
        ...preview,
        actionControl: null,
        changes: [{ field: 'default', from: 'PRIVATE_RULE', to: 'deny' }],
      }),
    ).toBe(false);
  });
});
