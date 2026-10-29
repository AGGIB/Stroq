import { doctorDiagnosticMatchesCheck, type DoctorDiagnostic } from './doctor-diagnostics';
import {
  protectionStepRun,
  validateProtectionCheckRun,
  type ProtectionCheckProgress,
  type ProtectionCheckSummary,
} from './protection-check';
export {
  validateDoctorDiagnostic,
  doctorDiagnosticMatchesCheck,
  doctorDiagnosticLabel,
} from './doctor-diagnostics';

export type ControlKind =
  'doctor' | 'policy-check' | 'guard-test' | 'content-scan' | 'protection-check';
export type RunInput =
  | { kind: Exclude<ControlKind, 'content-scan'> }
  | {
      kind: 'content-scan';
      content: string;
      target: 'skill' | 'tool-result';
    };
export interface DoctorResult {
  source: 'local';
  evidence: 'configuration';
  ok: boolean;
  diagnosticsVersion?: 1;
  checks: { id: string; label: string; ok: boolean; diagnostic?: DoctorDiagnostic }[];
  passed: number;
  total: number;
}
export interface PolicyCheckResult {
  source: 'local';
  evidence: 'configuration';
  ok: boolean;
  loaded: boolean;
  policySource: 'default' | 'file';
  rules: number | null;
  defaultEffect: 'allow' | 'ask' | 'deny' | null;
  threshold: number | null;
  faults: number;
  findings: { kind: string; severity: 'error' | 'warning' | 'info'; count: number }[];
}
export interface GuardTestResult {
  source: 'local';
  evidence: 'simulation';
  ok: boolean;
  replayed: { attack: number; ordinary: number; cases: number };
  attacksPassing: number;
  newInterruptions: number;
  relieved: number;
  violations: number;
  notJudged: number;
}
export interface ContentScanResult {
  source: 'local';
  evidence: 'content-scan';
  target: 'skill' | 'tool-result';
  verdict: 'clean' | 'suspect';
  score: number;
  timedOut: boolean;
  matches: {
    ruleId: string;
    title: string;
    severity: 'critical' | 'high' | 'medium' | 'low' | 'informational';
    category: string;
    variant: string;
  }[];
  characters: number;
  sha256: string;
}
export interface ControlRun {
  id: string;
  kind: ControlKind;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: string;
  finishedAt?: string;
  summary?: string;
  error?: string;
  result?:
    DoctorResult | PolicyCheckResult | GuardTestResult | ContentScanResult | ProtectionCheckSummary;
  progress?: ProtectionCheckProgress;
  provenance?: ControlContext;
}
export interface ControlContext {
  workspaceId: string;
  /** Source bytes, or the bundled-default marker bound to runtimeSha256; not a semantic policy hash. */
  policySha256: string | null;
  runtimeSha256: string | null;
}
export interface ControlState {
  schema: 'stroq-control/1';
  /** Platform identity for navigation; diagnostic provenance uses a distinct inode-bound ID. */
  workspaceId?: string;
  /** Current service ownership only; null never proves a retained worker stopped. */
  activeProtectionCheckId?: string | null;
  /** Current service ownership for any offline check. Other consoles can still own retained runs. */
  activeRunId?: string | null;
  engine: { available: boolean; version: string | null };
  context: ControlContext;
  history: {
    status: 'ready' | 'disabled' | 'error';
    error?: 'unsafe-path' | 'invalid-history' | 'read-failed' | 'write-failed' | 'unavailable';
  };
  runs: ControlRun[];
}
/** Legacy services did not expose leaf ownership; preserve their existing busy behavior. */
export function controlRunOwned(run: ControlRun, control: ControlState | null): boolean {
  if (run.status !== 'running' || control === null) return false;
  if (Object.hasOwn(control, 'activeRunId')) return control.activeRunId === run.id;
  return run.kind === 'protection-check' ? control.activeProtectionCheckId === run.id : true;
}
export const MAX_CONTENT_BYTES = 48 * 1024;
export function contentBytes(value: string): number {
  return new TextEncoder().encode(value).length;
}
export const RUN_LABELS: Record<ControlKind, string> = {
  'protection-check': 'Protection check',
  doctor: 'Installation check',
  'policy-check': 'Policy validation',
  'guard-test': 'Policy scenarios',
  'content-scan': 'Content scan',
};
export const RUN_ERRORS: Record<string, string> = {
  cancelled: 'The protection check was cancelled. Recorded stages remain available.',
  'context-changed': 'The workspace, policy or runtime changed. Run a new check.',
  'prerequisite-failed': 'A required earlier stage did not finish.',
  'history-unavailable': 'Saved evidence could not be verified.',
  'workspace-review-busy': 'Another workspace capture is running.',
  'policy-cases-unavailable': 'Saved policy checks could not be verified.',
  interrupted: 'This earlier attempt has no verified active owner. It will not resume.',
  'ownership-lost': 'Ownership of this check could not be verified. No further stage was accepted.',
  'engine-unavailable': 'Build the local Stroq engine, then restart the server.',
  'deadline-exceeded': 'The check exceeded its time limit. No conclusion was reached.',
  'output-limit': 'The check exceeded its output limit. No result was accepted.',
  'invalid-report': 'The engine returned an unsupported report. No result was accepted.',
  'engine-failed': 'The engine could not complete this check.',
  'server-stopped': 'The local server stopped before this check finished.',
};
const kinds = Object.keys(RUN_LABELS);
function closed(v: unknown, keys: string[]): v is Record<string, unknown> {
  return (
    v !== null &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(v)) &&
    Reflect.ownKeys(v).every((k) => typeof k === 'string' && keys.includes(k))
  );
}
function str(v: unknown, max = 200): v is string {
  return (
    typeof v === 'string' &&
    v.trim().length > 0 &&
    v.length <= max &&
    !/[\u0000-\u001f\u007f]/.test(v)
  );
}
function member(v: unknown, values: readonly string[]): boolean {
  return typeof v === 'string' && values.includes(v);
}
function count(v: unknown): v is number {
  return Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= 10_000_000;
}
function number(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 10_000_000;
}
function stamp(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v))
    return false;
  const date = new Date(v);
  return Number.isFinite(date.getTime()) && date.toISOString() === v;
}
function digest(v: unknown): v is string {
  return typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
}
export function validateControlContext(v: unknown): v is ControlContext {
  return (
    closed(v, ['workspaceId', 'policySha256', 'runtimeSha256']) &&
    digest(v.workspaceId) &&
    (v.policySha256 === null || digest(v.policySha256)) &&
    (v.runtimeSha256 === null || digest(v.runtimeSha256))
  );
}
/** Matching context binds historical diagnostics; it never establishes current host configuration. */
export function runMatchesContext(run: unknown, context: unknown): boolean {
  return (
    validateRun(run) &&
    validateControlContext(context) &&
    validateControlContext(run.provenance) &&
    context.policySha256 !== null &&
    context.runtimeSha256 !== null &&
    run.provenance.workspaceId === context.workspaceId &&
    run.provenance.policySha256 === context.policySha256 &&
    run.provenance.runtimeSha256 === context.runtimeSha256
  );
}
export function latestContextRun(
  runs: readonly unknown[],
  kind: ControlKind,
  context: unknown,
): ControlRun | undefined {
  return runs
    .flatMap((run) =>
      validateRun(run) &&
      run.kind === 'protection-check' &&
      ['doctor', 'policy-check', 'guard-test'].includes(kind)
        ? [protectionStepRun(run, kind as 'doctor' | 'policy-check' | 'guard-test')]
        : [run],
    )
    .filter(
      (run): run is ControlRun =>
        validateRun(run) && run.kind === kind && runMatchesContext(run, context),
    )
    .toSorted((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
}
function list(v: unknown, max: number, validate: (row: unknown) => boolean): v is unknown[] {
  return Array.isArray(v) && v.length <= max && v.every(validate);
}
function doctor(v: unknown): boolean {
  if (
    !closed(v, ['source', 'evidence', 'ok', 'checks', 'passed', 'total', 'diagnosticsVersion']) ||
    v.source !== 'local' ||
    v.evidence !== 'configuration' ||
    typeof v.ok !== 'boolean' ||
    (Object.hasOwn(v, 'diagnosticsVersion') && v.diagnosticsVersion !== 1)
  )
    return false;
  if (
    !list(
      v.checks,
      128,
      (c) =>
        closed(c, ['id', 'label', 'ok', 'diagnostic']) &&
        str(c.id, 80) &&
        str(c.label, 240) &&
        typeof c.ok === 'boolean' &&
        (v.diagnosticsVersion === 1
          ? doctorDiagnosticMatchesCheck(c.diagnostic, c.ok)
          : !Object.hasOwn(c, 'diagnostic')),
    )
  )
    return false;
  const checks = v.checks as DoctorResult['checks'];
  return (
    count(v.passed) &&
    v.total === checks.length &&
    checks.length > 0 &&
    v.ok === checks.every((c) => c.ok) &&
    v.passed === checks.filter((c) => c.ok).length &&
    new Set(checks.map((c) => c.id)).size === checks.length
  );
}
function policy(v: unknown): boolean {
  return (
    closed(v, [
      'source',
      'evidence',
      'ok',
      'loaded',
      'policySource',
      'rules',
      'defaultEffect',
      'threshold',
      'faults',
      'findings',
    ]) &&
    v.source === 'local' &&
    v.evidence === 'configuration' &&
    typeof v.ok === 'boolean' &&
    typeof v.loaded === 'boolean' &&
    member(v.policySource, ['default', 'file']) &&
    (v.rules === null || count(v.rules)) &&
    (v.defaultEffect === null || member(v.defaultEffect, ['allow', 'ask', 'deny'])) &&
    (v.threshold === null || number(v.threshold)) &&
    count(v.faults) &&
    list(
      v.findings,
      64,
      (f) =>
        closed(f, ['kind', 'severity', 'count']) &&
        member(f.kind, [
          'shadowed-rule',
          'dropped-protection',
          'loose-default',
          'high-threshold',
          'unknown-field',
        ]) &&
        member(f.severity, ['error', 'warning', 'info']) &&
        count(f.count),
    ) &&
    (v.loaded
      ? count(v.rules) && v.defaultEffect !== null && v.threshold !== null && v.faults === 0
      : v.rules === null && v.defaultEffect === null && v.threshold === null && v.faults > 0) &&
    v.ok ===
      (v.loaded &&
        (v.findings as PolicyCheckResult['findings']).every((f) => f.severity === 'info'))
  );
}
function scenarios(v: unknown): boolean {
  return (
    closed(v, [
      'source',
      'evidence',
      'ok',
      'replayed',
      'attacksPassing',
      'newInterruptions',
      'relieved',
      'violations',
      'notJudged',
    ]) &&
    v.source === 'local' &&
    v.evidence === 'simulation' &&
    typeof v.ok === 'boolean' &&
    closed(v.replayed, ['attack', 'ordinary', 'cases']) &&
    ['attack', 'ordinary', 'cases'].every((key) =>
      count((v.replayed as Record<string, unknown>)[key]),
    ) &&
    ['attacksPassing', 'newInterruptions', 'relieved', 'violations', 'notJudged'].every((k) =>
      count(v[k]),
    ) &&
    (!v.ok || (v.attacksPassing === 0 && v.notJudged === 0 && v.violations === 0))
  );
}
function scan(v: unknown): boolean {
  return (
    closed(v, [
      'source',
      'evidence',
      'target',
      'verdict',
      'score',
      'timedOut',
      'matches',
      'characters',
      'sha256',
    ]) &&
    v.source === 'local' &&
    v.evidence === 'content-scan' &&
    member(v.target, ['skill', 'tool-result']) &&
    member(v.verdict, ['clean', 'suspect']) &&
    number(v.score) &&
    typeof v.timedOut === 'boolean' &&
    count(v.characters) &&
    v.characters <= MAX_CONTENT_BYTES &&
    typeof v.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(v.sha256) &&
    list(
      v.matches,
      512,
      (m) =>
        closed(m, ['ruleId', 'title', 'severity', 'category', 'variant']) &&
        str(m.ruleId, 128) &&
        str(m.title, 400) &&
        member(m.severity, ['critical', 'high', 'medium', 'low', 'informational']) &&
        str(m.category, 128) &&
        str(m.variant, 128),
    )
  );
}
/** Reject unknown fields: engine reports must never leak raw content into the UI. */
export function validateRun(v: unknown): v is ControlRun {
  if (
    !closed(v, [
      'id',
      'kind',
      'status',
      'startedAt',
      'finishedAt',
      'summary',
      'result',
      'error',
      'provenance',
      'progress',
    ]) ||
    typeof v.id !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v.id) ||
    !member(v.kind, kinds) ||
    !member(v.status, [
      'running',
      'completed',
      'failed',
      ...(v.kind === 'protection-check' ? ['cancelled'] : []),
    ]) ||
    !stamp(v.startedAt) ||
    (Object.hasOwn(v, 'provenance') && !validateControlContext(v.provenance)) ||
    (Object.hasOwn(v, 'summary') && !str(v.summary, 600))
  )
    return false;
  if (v.kind === 'protection-check')
    return validateProtectionCheckRun(
      v,
      { doctor, 'policy-check': policy, 'guard-test': scenarios },
      Object.keys(RUN_ERRORS),
    );
  if (Object.hasOwn(v, 'progress')) return false;
  if (v.status === 'running')
    return (
      !Object.hasOwn(v, 'result') && !Object.hasOwn(v, 'error') && !Object.hasOwn(v, 'finishedAt')
    );
  if (!stamp(v.finishedAt) || v.finishedAt < v.startedAt) return false;
  if (v.status === 'failed')
    return member(v.error, Object.keys(RUN_ERRORS)) && !Object.hasOwn(v, 'result');
  if (Object.hasOwn(v, 'error')) return false;
  return { doctor, 'policy-check': policy, 'guard-test': scenarios, 'content-scan': scan }[
    v.kind as Exclude<ControlKind, 'protection-check'>
  ](v.result);
}
export function validateControl(v: unknown): v is ControlState {
  if (
    !closed(v, [
      'schema',
      'workspaceId',
      'activeProtectionCheckId',
      'activeRunId',
      'engine',
      'runs',
      'history',
      'context',
    ]) ||
    v.schema !== 'stroq-control/1' ||
    (Object.hasOwn(v, 'workspaceId') &&
      (typeof v.workspaceId !== 'string' || !/^workspace-[a-f0-9]{24}$/.test(v.workspaceId))) ||
    !closed(v.engine, ['available', 'version']) ||
    typeof v.engine.available !== 'boolean' ||
    !(v.engine.version === null || str(v.engine.version, 80)) ||
    !validateControlContext(v.context) ||
    !closed(v.history, ['status', 'error']) ||
    !member(v.history.status, ['ready', 'disabled', 'error']) ||
    (v.history.status === 'error'
      ? !member(v.history.error, [
          'unsafe-path',
          'invalid-history',
          'read-failed',
          'write-failed',
          'unavailable',
        ])
      : Object.hasOwn(v.history, 'error')) ||
    !list(v.runs, 32, validateRun)
  )
    return false;
  const runs = v.runs as ControlRun[];
  return (
    (!Object.hasOwn(v, 'activeRunId') ||
      v.activeRunId === null ||
      (typeof v.activeRunId === 'string' &&
        runs.some((run) => run.id === v.activeRunId && run.status === 'running'))) &&
    (!Object.hasOwn(v, 'activeRunId') ||
      !Object.hasOwn(v, 'activeProtectionCheckId') ||
      v.activeProtectionCheckId ===
        (runs.find((run) => run.id === v.activeRunId && run.kind === 'protection-check')?.id ??
          null)) &&
    (!Object.hasOwn(v, 'activeProtectionCheckId') ||
      v.activeProtectionCheckId === null ||
      (typeof v.activeProtectionCheckId === 'string' &&
        runs.some(
          (run) =>
            run.id === v.activeProtectionCheckId &&
            run.kind === 'protection-check' &&
            run.status === 'running',
        ))) &&
    (!v.workspaceId ||
      runs.every(
        (run) =>
          run.kind !== 'protection-check' ||
          run.progress?.steps.every(
            (step) =>
              !step.result ||
              !('workspaceId' in step.result) ||
              step.result.workspaceId === v.workspaceId,
          ),
      )) &&
    new Set(runs.map((r) => r.id)).size === runs.length &&
    runs.filter((r) => r.status === 'running').length <= 1
  );
}
