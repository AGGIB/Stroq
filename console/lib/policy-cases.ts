import { ACTION_CLASSES, type ActionClass } from '../../packages/core/src/types';
import { closed, count, hash, member, stamp } from './local-guards';
import type { PolicyEffect } from './policy-control';

export const MAX_POLICY_CASES = 64;
export const CASE_LIMITATIONS = [
  'Saved checks evaluate the complete recorded action-class combination under clean and suspect session assumptions; they do not replay the original command or content.',
  'The original session taint and policy version were not recorded. Saved expected decisions are explicit current-policy expectations, not historical execution evidence.',
  'Checks apply to every policy candidate using this Stroq data directory, across workspaces. Removing a check weakens this regression gate, not the active policy.',
  'A passing check does not establish native-client adoption, live blocking, remediation or absence of credential exposure.',
  'Cases retain fixed action classes, expected effects, timestamps and source fingerprints locally until explicitly removed; no commands, content, credentials or free-form names are stored.',
] as const;
export interface PolicyCase {
  id: string;
  createdAt: string;
  source: { incidentId: string; evidenceSha: string; workspaceId: string };
  classes: ActionClass[];
  expected: [{ taint: 'none'; effect: PolicyEffect }, { taint: 'suspect'; effect: PolicyEffect }];
}
export interface PolicyCaseResult {
  caseId: string;
  passed: boolean;
  scenarios: [
    { taint: 'none'; expected: PolicyEffect; actual: PolicyEffect },
    { taint: 'suspect'; expected: PolicyEffect; actual: PolicyEffect },
  ];
}
export interface PolicyCaseEvaluation {
  policyFingerprint: string;
  total: number;
  passed: number;
  failed: number;
  results: PolicyCaseResult[];
}
export interface PolicyCaseRegressions {
  revision: string | null;
  total: number;
  passed: number;
  failed: number;
  results: PolicyCaseResult[];
}
export interface PolicyCaseReport {
  policy: { source: 'built-in' | 'file'; semanticSha: string; rawSha: string | null };
  total: number;
  passed: number;
  failed: number;
  results: PolicyCaseResult[];
  hostEnforcement: false;
}
export interface PolicyCasesState {
  schema: 'stroq-policy-cases/1';
  source: 'local';
  workspaceId: string;
  generatedAt: string;
  revision: string | null;
  cases: PolicyCase[];
  report: PolicyCaseReport;
  limitations: string[];
}
export interface PolicyCaseReceipt {
  schema: 'stroq-policy-case-receipt/1';
  status: 'saved' | 'unchanged' | 'removed';
  caseId: string;
  revision: string;
  completedAt: string;
  workspaceId: string;
  record: PolicyCase | null;
  hostEnforcement: false;
}
const caseId = (v: unknown) => typeof v === 'string' && /^case-[a-f0-9]{64}$/.test(v);
const workspace = (v: unknown) => typeof v === 'string' && /^workspace-[a-f0-9]{24}$/.test(v);
const effect = (v: unknown): v is PolicyEffect => member(v, ['allow', 'ask', 'deny']);
const nullableHash = (v: unknown) => v === null || hash(v);
export function validatePolicyCase(v: unknown): v is PolicyCase {
  return (
    closed(v, ['id', 'createdAt', 'source', 'classes', 'expected']) &&
    caseId(v.id) &&
    stamp(v.createdAt) &&
    closed(v.source, ['incidentId', 'evidenceSha', 'workspaceId']) &&
    hash(v.source.evidenceSha) &&
    v.source.incidentId === `incident-${v.source.evidenceSha}` &&
    workspace(v.source.workspaceId) &&
    Array.isArray(v.classes) &&
    v.classes.length > 0 &&
    v.classes.length <= ACTION_CLASSES.length &&
    Array.from(v.classes).every(
      (item, i, all) => member(item, ACTION_CLASSES) && (i === 0 || all[i - 1] < item),
    ) &&
    Array.isArray(v.expected) &&
    v.expected.length === 2 &&
    v.expected.every(
      (row, i) =>
        closed(row, ['taint', 'effect']) &&
        row.taint === ['none', 'suspect'][i] &&
        effect(row.effect),
    )
  );
}
function result(v: unknown): v is PolicyCaseResult {
  if (
    !closed(v, ['caseId', 'passed', 'scenarios']) ||
    !caseId(v.caseId) ||
    typeof v.passed !== 'boolean' ||
    !Array.isArray(v.scenarios) ||
    v.scenarios.length !== 2 ||
    !v.scenarios.every(
      (s, i) =>
        closed(s, ['taint', 'expected', 'actual']) &&
        s.taint === ['none', 'suspect'][i] &&
        effect(s.expected) &&
        effect(s.actual),
    )
  )
    return false;
  return v.passed === v.scenarios.every((s) => s.expected === s.actual);
}
function counts(v: Record<string, unknown>): boolean {
  return (
    count(v.total, MAX_POLICY_CASES) &&
    count(v.passed, MAX_POLICY_CASES) &&
    count(v.failed, MAX_POLICY_CASES) &&
    Array.isArray(v.results) &&
    v.results.length === v.total &&
    v.results.every(result) &&
    new Set(v.results.map((r) => r.caseId)).size === v.results.length &&
    v.passed === v.results.filter((r) => r.passed).length &&
    v.failed === v.results.filter((r) => !r.passed).length
  );
}
function matchesRecords(results: PolicyCaseResult[], records: PolicyCase[]) {
  return (
    results.length === records.length &&
    results.every(
      (row, i) =>
        row.caseId === records[i]?.id &&
        row.scenarios.every((scenario, j) => scenario.expected === records[i]?.expected[j]?.effect),
    )
  );
}
export function validatePolicyCaseEvaluation(
  v: unknown,
  records?: PolicyCase[],
): v is PolicyCaseEvaluation {
  return (
    closed(v, ['policyFingerprint', 'total', 'passed', 'failed', 'results']) &&
    hash(v.policyFingerprint) &&
    counts(v) &&
    (!records || matchesRecords(v.results as PolicyCaseResult[], records))
  );
}
export function validatePolicyCaseRegressions(v: unknown): v is PolicyCaseRegressions {
  return (
    closed(v, ['revision', 'total', 'passed', 'failed', 'results']) &&
    nullableHash(v.revision) &&
    counts(v) &&
    (v.revision !== null || v.total === 0)
  );
}
export function validatePolicyCases(v: unknown): v is PolicyCasesState {
  if (
    !closed(v, [
      'schema',
      'source',
      'workspaceId',
      'generatedAt',
      'revision',
      'cases',
      'report',
      'limitations',
    ]) ||
    v.schema !== 'stroq-policy-cases/1' ||
    v.source !== 'local' ||
    !workspace(v.workspaceId) ||
    !stamp(v.generatedAt) ||
    !nullableHash(v.revision) ||
    !Array.isArray(v.cases) ||
    v.cases.length > MAX_POLICY_CASES ||
    !v.cases.every(validatePolicyCase) ||
    new Set(v.cases.map((r) => r.id)).size !== v.cases.length ||
    new Set(v.cases.map((r) => JSON.stringify(r.classes))).size !== v.cases.length ||
    (v.revision === null && v.cases.length !== 0) ||
    !closed(v.report, ['policy', 'total', 'passed', 'failed', 'results', 'hostEnforcement']) ||
    !closed(v.report.policy, ['source', 'semanticSha', 'rawSha']) ||
    !hash(v.report.policy.semanticSha) ||
    !(v.report.policy.source === 'built-in'
      ? v.report.policy.rawSha === null
      : v.report.policy.source === 'file' && hash(v.report.policy.rawSha)) ||
    v.report.hostEnforcement !== false ||
    !counts(v.report) ||
    !Array.isArray(v.limitations) ||
    v.limitations.length !== CASE_LIMITATIONS.length ||
    !v.limitations.every((s, i) => s === CASE_LIMITATIONS[i])
  )
    return false;
  return matchesRecords(v.report.results as PolicyCaseResult[], v.cases as PolicyCase[]);
}
export function validatePolicyCaseReceipt(v: unknown): v is PolicyCaseReceipt {
  return (
    closed(v, [
      'schema',
      'status',
      'caseId',
      'revision',
      'completedAt',
      'workspaceId',
      'record',
      'hostEnforcement',
    ]) &&
    v.schema === 'stroq-policy-case-receipt/1' &&
    member(v.status, ['saved', 'unchanged', 'removed']) &&
    caseId(v.caseId) &&
    hash(v.revision) &&
    stamp(v.completedAt) &&
    workspace(v.workspaceId) &&
    v.hostEnforcement === false &&
    (v.status === 'removed'
      ? v.record === null
      : validatePolicyCase(v.record) && v.record.id === v.caseId)
  );
}
