import { closed, count, hash, member, stamp, text } from './local-guards';
import { ACTION_CLASSES, type ActionClass } from '../../packages/core/src/types';
import { validatePolicyCaseRegressions, type PolicyCaseRegressions } from './policy-cases';
export { ACTION_CLASSES };
export type { ActionClass };
export type PolicyEffect = 'allow' | 'ask' | 'deny';
export type PolicyChange =
  | { field: 'default'; from: PolicyEffect; to: 'ask' | 'deny' }
  | { field: 'threshold'; from: number; to: number }
  | { field: 'rule-effect'; index: number; from: 'ask'; to: 'deny' }
  | { field: 'class-deny'; actionClass: ActionClass; from: 'current-policy'; to: 'deny' };
export interface PolicyActionControl {
  classes: ActionClass[];
  removedRules: number;
  narrowedRules: number;
  taint: 'any';
  scope: 'stroq-home';
  hostEnforcement: false;
}
export interface PolicyCheck {
  ok: boolean;
  loaded: boolean;
  faults: number;
  findings: { kind: string; severity: 'error' | 'warning' | 'info'; count: number }[];
}
export interface PolicyState {
  schema: 'stroq-policy/1';
  source: 'default' | 'file';
  expectedRawSha: string | null;
  policyFingerprint: string | null;
  defaultEffect: PolicyEffect | null;
  threshold: number | null;
  rules: {
    index: number;
    effect: PolicyEffect;
    classes: string[];
    taint: 'any' | 'none' | 'suspect';
  }[];
  check: PolicyCheck;
  editable: boolean;
}
export interface PolicyPreview {
  interruptions: {
    label: string;
    step: number;
    from: 'allow' | 'ask' | 'deny' | 'clean' | 'suspect';
    to: 'allow' | 'ask' | 'deny' | 'clean' | 'suspect';
  }[];
  interruptionsTruncated: boolean;
  previewId: string;
  expiresAt: string;
  expectedRawSha: string | null;
  candidateFingerprint: string;
  currentPolicyFingerprint: string;
  changes: PolicyChange[];
  actionControl: PolicyActionControl | null;
  regressions: PolicyCaseRegressions;
  check: PolicyCheck;
  simulation: {
    ok: boolean;
    replayed: { attack: number; ordinary: number; cases: number };
    attacksPassing: number;
    newInterruptions: number;
    relieved: number;
    violations: number;
    notJudged: number;
  };
  blockers: string[];
  requiresInterruptionAcknowledgement: boolean;
}
export interface PolicyReceipt {
  applied: true;
  receiptId: string;
  appliedAt: string;
  policyFingerprint: string;
  rawSha: string;
  backupId: string | null;
}
const nullableHash = (v: unknown) => v === null || hash(v);
const fraction = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
function check(v: unknown): boolean {
  return (
    closed(v, ['ok', 'loaded', 'faults', 'findings']) &&
    typeof v.ok === 'boolean' &&
    typeof v.loaded === 'boolean' &&
    count(v.faults) &&
    Array.isArray(v.findings) &&
    v.findings.length <= 64 &&
    v.findings.every(
      (f) =>
        closed(f, ['kind', 'severity', 'count']) &&
        text(f.kind, 80) &&
        member(f.severity, ['error', 'warning', 'info']) &&
        count(f.count),
    )
  );
}

const effectStrength = { allow: 0, ask: 1, deny: 2 } as const;
function change(value: unknown): value is PolicyChange {
  if (!closed(value, ['field', 'index', 'actionClass', 'from', 'to'])) return false;
  switch (value.field) {
    case 'class-deny':
      return (
        closed(value, ['field', 'actionClass', 'from', 'to']) &&
        member(value.actionClass, ACTION_CLASSES) &&
        value.from === 'current-policy' &&
        value.to === 'deny'
      );
    case 'rule-effect':
      return (
        closed(value, ['field', 'index', 'from', 'to']) &&
        count(value.index, 511) &&
        value.from === 'ask' &&
        value.to === 'deny'
      );
    case 'threshold':
      return (
        closed(value, ['field', 'from', 'to']) &&
        fraction(value.from) &&
        fraction(value.to) &&
        (value.to as number) < (value.from as number)
      );
    case 'default':
      return (
        closed(value, ['field', 'from', 'to']) &&
        member(value.from, ['allow', 'ask', 'deny']) &&
        member(value.to, ['ask', 'deny']) &&
        effectStrength[value.to as PolicyEffect] > effectStrength[value.from as PolicyEffect]
      );
    default:
      return false;
  }
}

function actionControl(
  value: unknown,
  changes: PolicyChange[],
): value is PolicyActionControl | null {
  const classes = changes.flatMap((item) =>
    item.field === 'class-deny' ? [item.actionClass] : [],
  );
  if (classes.length === 0) return value === null;
  return (
    closed(value, [
      'classes',
      'removedRules',
      'narrowedRules',
      'taint',
      'scope',
      'hostEnforcement',
    ]) &&
    Array.isArray(value.classes) &&
    value.classes.length === classes.length &&
    value.classes.length <= ACTION_CLASSES.length &&
    Array.from(value.classes).every(
      (item, index) =>
        member(item, ACTION_CLASSES) &&
        item === classes[index] &&
        (index === 0 || classes[index - 1]! < item),
    ) &&
    count(value.removedRules, 512) &&
    count(value.narrowedRules, 512) &&
    value.removedRules + value.narrowedRules <= 512 &&
    value.taint === 'any' &&
    value.scope === 'stroq-home' &&
    value.hostEnforcement === false
  );
}
export function validatePolicy(v: unknown): v is PolicyState {
  return (
    closed(v, [
      'schema',
      'source',
      'expectedRawSha',
      'policyFingerprint',
      'defaultEffect',
      'threshold',
      'rules',
      'check',
      'editable',
    ]) &&
    v.schema === 'stroq-policy/1' &&
    member(v.source, ['default', 'file']) &&
    nullableHash(v.expectedRawSha) &&
    nullableHash(v.policyFingerprint) &&
    (v.defaultEffect === null || member(v.defaultEffect, ['allow', 'ask', 'deny'])) &&
    (v.threshold === null || fraction(v.threshold)) &&
    typeof v.editable === 'boolean' &&
    check(v.check) &&
    Array.isArray(v.rules) &&
    v.rules.length <= 2000 &&
    v.rules.every(
      (r, i) =>
        closed(r, ['index', 'effect', 'classes', 'taint']) &&
        r.index === i &&
        member(r.effect, ['allow', 'ask', 'deny']) &&
        member(r.taint, ['any', 'none', 'suspect']) &&
        Array.isArray(r.classes) &&
        r.classes.length <= 128 &&
        r.classes.every((c) => text(c, 100)),
    )
  );
}
export function validatePolicyPreview(v: unknown): v is PolicyPreview {
  if (
    !closed(v, [
      'previewId',
      'expiresAt',
      'expectedRawSha',
      'candidateFingerprint',
      'currentPolicyFingerprint',
      'changes',
      'actionControl',
      'regressions',
      'check',
      'simulation',
      'blockers',
      'requiresInterruptionAcknowledgement',
      'interruptions',
      'interruptionsTruncated',
    ]) ||
    !text(v.previewId, 100) ||
    !stamp(v.expiresAt) ||
    !nullableHash(v.expectedRawSha) ||
    !hash(v.candidateFingerprint) ||
    !hash(v.currentPolicyFingerprint) ||
    !check(v.check) ||
    !validatePolicyCaseRegressions(v.regressions) ||
    typeof v.requiresInterruptionAcknowledgement !== 'boolean' ||
    typeof v.interruptionsTruncated !== 'boolean' ||
    !Array.isArray(v.interruptions) ||
    v.interruptions.length > 128 ||
    !v.interruptions.every(
      (i) =>
        closed(i, ['label', 'step', 'from', 'to']) &&
        text(i.label, 200) &&
        count(i.step, 1000) &&
        member(i.from, ['allow', 'ask', 'deny', 'clean', 'suspect']) &&
        member(i.to, ['allow', 'ask', 'deny', 'clean', 'suspect']),
    )
  )
    return false;
  if (
    !Array.isArray(v.changes) ||
    v.changes.length === 0 ||
    v.changes.length > 534 ||
    !Array.from(v.changes).every(change)
  )
    return false;
  const changes = v.changes as PolicyChange[];
  const changeKeys = changes.map((item) =>
    item.field === 'class-deny'
      ? `class:${item.actionClass}`
      : item.field === 'rule-effect'
        ? `rule:${item.index}`
        : item.field,
  );
  if (new Set(changeKeys).size !== changes.length || !actionControl(v.actionControl, changes))
    return false;
  const s = v.simulation;
  return (
    closed(s, [
      'ok',
      'replayed',
      'attacksPassing',
      'newInterruptions',
      'relieved',
      'violations',
      'notJudged',
    ]) &&
    typeof s.ok === 'boolean' &&
    closed(s.replayed, ['attack', 'ordinary', 'cases']) &&
    ['attack', 'ordinary', 'cases'].every((k) =>
      count((s.replayed as Record<string, unknown>)[k]),
    ) &&
    ['attacksPassing', 'newInterruptions', 'relieved', 'violations', 'notJudged'].every((k) =>
      count(s[k]),
    ) &&
    Array.isArray(v.blockers) &&
    v.blockers.length <= 64 &&
    v.blockers.every((b) =>
      member(b, [
        'policy-findings',
        'attacks-allowed',
        'unmet-expectations',
        'unjudged-scenarios',
        'saved-case-failures',
      ]),
    ) &&
    (v.regressions as PolicyCaseRegressions).failed > 0 ===
      v.blockers.includes('saved-case-failures')
  );
}
export function validatePolicyReceipt(v: unknown): v is PolicyReceipt {
  return (
    closed(v, ['applied', 'receiptId', 'appliedAt', 'policyFingerprint', 'rawSha', 'backupId']) &&
    v.applied === true &&
    text(v.receiptId, 100) &&
    stamp(v.appliedAt) &&
    hash(v.policyFingerprint) &&
    hash(v.rawSha) &&
    (v.backupId === null || text(v.backupId, 100))
  );
}
