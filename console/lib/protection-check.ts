import type { ControlRun, DoctorResult, GuardTestResult, PolicyCheckResult } from './control';
import { closed, count, hash, member, stamp, text } from './local-guards';
import { validatePolicyCaseRegressions, type PolicyCaseResult } from './policy-cases';
import { ACTION_CLASSES, type ActionClass } from '../../packages/core/src/types';

export const PROTECTION_STEPS = [
  'doctor',
  'policy-check',
  'guard-test',
  'saved-policy-checks',
  'workspace-review',
] as const;
export type ProtectionStepId = (typeof PROTECTION_STEPS)[number];
export const PROTECTION_STEP_LABELS: Record<ProtectionStepId, string> = {
  doctor: 'Installation',
  'policy-check': 'Policy validation',
  'guard-test': 'Policy scenarios',
  'saved-policy-checks': 'Saved policy checks',
  'workspace-review': 'Workspace capture',
};
export interface SavedProtectionResult {
  source: 'local';
  evidence: 'simulation';
  workspaceId: string;
  generatedAt: string;
  revision: string | null;
  policy: { source: 'built-in' | 'file'; semanticSha: string; rawSha: string | null };
  total: number;
  passed: number;
  failed: number;
  cases: { id: string; classes: ActionClass[] }[];
  results: PolicyCaseResult[];
  hostEnforcement: false;
}
export interface WorkspaceProtectionResult {
  source: 'local';
  evidence: 'static-capture';
  runId: string;
  workspaceId: string;
  captureSha256: string;
  capturedAt: string;
  profile: {
    id: 'stroq-workspace-surface/1';
    engineVersion: string;
    runtimeSha256: string;
    scopeSha256: string;
  };
  complete: boolean;
  sources: number;
  entries: number;
  errors: number;
  warnings: number;
  notices: number;
  coverage: { omittedSources: number; omittedEntries: number; gaps: number };
  hostEnforcement: false;
}
export interface ProtectionCheckSummary {
  source: 'local';
  evidence: 'local-checks';
  outcome: 'finished' | 'incomplete';
  completed: number;
  total: 5;
  hostEnforcement: false;
}
export interface ProtectionCheckStep {
  id: ProtectionStepId;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'skipped';
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  result:
    | DoctorResult
    | PolicyCheckResult
    | GuardTestResult
    | SavedProtectionResult
    | WorkspaceProtectionResult
    | null;
}
export interface ProtectionCheckProgress {
  steps: ProtectionCheckStep[];
}
const workspace = (v: unknown) => typeof v === 'string' && /^workspace-[a-f0-9]{24}$/.test(v);
const uuid = (v: unknown) =>
  typeof v === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
function saved(v: unknown): boolean {
  if (
    !closed(v, [
      'source',
      'evidence',
      'workspaceId',
      'generatedAt',
      'revision',
      'policy',
      'total',
      'passed',
      'failed',
      'cases',
      'results',
      'hostEnforcement',
    ]) ||
    v.source !== 'local' ||
    v.evidence !== 'simulation' ||
    !workspace(v.workspaceId) ||
    !stamp(v.generatedAt) ||
    v.hostEnforcement !== false ||
    !closed(v.policy, ['source', 'semanticSha', 'rawSha']) ||
    !hash(v.policy.semanticSha) ||
    !(v.policy.source === 'built-in'
      ? v.policy.rawSha === null
      : v.policy.source === 'file' && hash(v.policy.rawSha)) ||
    !Array.isArray(v.cases) ||
    v.cases.length > 64 ||
    v.cases.length !== v.total ||
    !v.cases.every(
      (row) =>
        closed(row, ['id', 'classes']) &&
        typeof row.id === 'string' &&
        /^case-[a-f0-9]{64}$/.test(row.id) &&
        Array.isArray(row.classes) &&
        row.classes.length > 0 &&
        row.classes.length <= ACTION_CLASSES.length &&
        row.classes.every(
          (value, index, all) =>
            member(value, ACTION_CLASSES) && (index === 0 || all[index - 1] < value),
        ),
    )
  )
    return false;
  const cases = v.cases as SavedProtectionResult['cases'];
  return (
    validatePolicyCaseRegressions({
      revision: v.revision,
      total: v.total,
      passed: v.passed,
      failed: v.failed,
      results: v.results,
    }) &&
    new Set(cases.map((row) => row.id)).size === cases.length &&
    new Set(cases.map((row) => JSON.stringify(row.classes))).size === cases.length &&
    cases.every((row, index) => row.id === (v.results as PolicyCaseResult[])[index]?.caseId)
  );
}
function workspaceResult(v: unknown): boolean {
  return (
    closed(v, [
      'source',
      'evidence',
      'runId',
      'workspaceId',
      'captureSha256',
      'capturedAt',
      'profile',
      'complete',
      'sources',
      'entries',
      'errors',
      'warnings',
      'notices',
      'coverage',
      'hostEnforcement',
    ]) &&
    v.source === 'local' &&
    v.evidence === 'static-capture' &&
    uuid(v.runId) &&
    workspace(v.workspaceId) &&
    hash(v.captureSha256) &&
    stamp(v.capturedAt) &&
    closed(v.profile, ['id', 'engineVersion', 'runtimeSha256', 'scopeSha256']) &&
    v.profile.id === 'stroq-workspace-surface/1' &&
    text(v.profile.engineVersion, 100) &&
    hash(v.profile.runtimeSha256) &&
    hash(v.profile.scopeSha256) &&
    typeof v.complete === 'boolean' &&
    ['sources', 'entries', 'errors', 'warnings', 'notices'].every((k) => count(v[k], 10_000_000)) &&
    v.entries === (v.errors as number) + (v.warnings as number) + (v.notices as number) &&
    closed(v.coverage, ['omittedSources', 'omittedEntries', 'gaps']) &&
    ['omittedSources', 'omittedEntries', 'gaps'].every((k) =>
      count((v.coverage as Record<string, unknown>)[k], 10_000_000),
    ) &&
    (!v.complete ||
      (v.coverage.omittedSources === 0 &&
        v.coverage.omittedEntries === 0 &&
        v.coverage.gaps === 0)) &&
    v.hostEnforcement === false
  );
}
/** Parent progress is fixed, bounded and typed; it never accepts raw engine reports. */
export function validateProtectionCheckRun(
  v: Record<string, unknown>,
  validators: Record<'doctor' | 'policy-check' | 'guard-test', (v: unknown) => boolean>,
  errors: readonly string[],
): boolean {
  if (
    !closed(v.progress, ['steps']) ||
    !Array.isArray(v.progress.steps) ||
    v.progress.steps.length !== 5
  )
    return false;
  const stages = v.progress.steps;
  const checks = {
    ...validators,
    'saved-policy-checks': saved,
    'workspace-review': workspaceResult,
  };
  if (
    !stages.every((s, i) => {
      if (
        !closed(s, ['id', 'status', 'startedAt', 'finishedAt', 'error', 'result']) ||
        s.id !== PROTECTION_STEPS[i] ||
        !member(s.status, ['queued', 'running', 'completed', 'failed', 'skipped'])
      )
        return false;
      if (s.status === 'queued')
        return (
          s.startedAt === null && s.finishedAt === null && s.error === null && s.result === null
        );
      if (s.status === 'skipped')
        return (
          s.startedAt === null &&
          stamp(s.finishedAt) &&
          member(s.error, errors) &&
          s.result === null
        );
      if (!stamp(s.startedAt) || s.startedAt < (v.startedAt as string)) return false;
      if (s.status === 'running')
        return s.finishedAt === null && s.error === null && s.result === null;
      if (!stamp(s.finishedAt) || s.finishedAt < s.startedAt) return false;
      return s.status === 'failed'
        ? member(s.error, errors) && s.result === null
        : s.error === null && checks[s.id as ProtectionStepId](s.result);
    })
  )
    return false;
  const typed = stages as ProtectionCheckStep[];
  const savedResult = typed[3]!.result as SavedProtectionResult | null;
  const capturedWorkspace = typed[4]!.result as WorkspaceProtectionResult | null;
  if (savedResult && capturedWorkspace && savedResult.workspaceId !== capturedWorkspace.workspaceId)
    return false;
  if (
    savedResult?.policy.source === 'file' &&
    closed(v.provenance, ['workspaceId', 'policySha256', 'runtimeSha256']) &&
    v.provenance.policySha256 !== null &&
    savedResult.policy.rawSha !== v.provenance.policySha256
  )
    return false;
  let previousFinish = v.startedAt as string;
  for (const step of typed) {
    if (step.startedAt !== null && step.startedAt < previousFinish) return false;
    if (step.finishedAt !== null) {
      if (step.finishedAt < previousFinish) return false;
      previousFinish = step.finishedAt;
    }
    if (step.result && ('generatedAt' in step.result || 'capturedAt' in step.result)) {
      const at = 'generatedAt' in step.result ? step.result.generatedAt : step.result.capturedAt;
      if (
        step.startedAt === null ||
        step.finishedAt === null ||
        at < step.startedAt ||
        at > step.finishedAt
      )
        return false;
    }
  }
  if (
    typed.filter((s) => s.status === 'running').length > 1 ||
    typed.some(
      (s, i) =>
        s.status === 'running' && typed.slice(i + 1).some((next) => next.status !== 'queued'),
    )
  )
    return false;
  const firstQueued = typed.findIndex((s) => s.status === 'queued');
  if (firstQueued >= 0 && typed.slice(firstQueued).some((s) => s.status !== 'queued')) return false;
  if (v.status === 'running')
    return (
      !Object.hasOwn(v, 'finishedAt') && !Object.hasOwn(v, 'result') && !Object.hasOwn(v, 'error')
    );
  if (
    !stamp(v.finishedAt) ||
    typed.some(
      (s) =>
        s.status === 'queued' ||
        s.status === 'running' ||
        (s.finishedAt !== null && s.finishedAt > (v.finishedAt as string)),
    )
  )
    return false;
  if (
    v.status === 'completed'
      ? Object.hasOwn(v, 'error') || typed.some((s) => s.status !== 'completed')
      : !member(v.error, errors)
  )
    return false;
  if (v.status === 'cancelled' && v.error !== 'cancelled') return false;
  return (
    closed(v.result, ['source', 'evidence', 'outcome', 'completed', 'total', 'hostEnforcement']) &&
    v.result.source === 'local' &&
    v.result.evidence === 'local-checks' &&
    v.result.outcome === (v.status === 'completed' ? 'finished' : 'incomplete') &&
    v.result.completed === typed.filter((s) => s.status === 'completed').length &&
    v.result.total === 5 &&
    v.result.hostEnforcement === false
  );
}
/** A child projection retains the parent's exact identity/provenance for existing diagnostics. */
export function protectionStepRun(
  run: ControlRun,
  id: 'doctor' | 'policy-check' | 'guard-test',
): ControlRun | undefined {
  if (run.kind !== 'protection-check') return undefined;
  const step = run.progress?.steps.find((s) => s.id === id);
  if (!step || step.status === 'queued' || step.status === 'skipped') return undefined;
  return {
    id: run.id,
    kind: id,
    status: step.status,
    startedAt: step.startedAt!,
    ...(step.finishedAt ? { finishedAt: step.finishedAt } : {}),
    ...(step.result
      ? { result: step.result as DoctorResult | PolicyCheckResult | GuardTestResult }
      : {}),
    ...(step.error ? { error: step.error } : {}),
    ...(run.provenance ? { provenance: run.provenance } : {}),
  };
}
