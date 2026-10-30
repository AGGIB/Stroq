import { closed, count, hash, member, stamp } from './local-guards';
import { isCodexControlContext } from './codex-skill-controls';

export const CODEX_NETWORK_CHECK_ERRORS = [
  'codex-network-check-unavailable',
  'codex-network-check-unsupported',
  'codex-network-check-stale',
  'codex-network-check-expired',
  'codex-network-check-busy',
  'codex-network-check-history-unavailable',
  'codex-network-check-cancelled',
  'codex-network-check-timeout',
  'codex-network-check-invalid-report',
  'codex-network-check-cleanup-failed',
  'codex-network-check-output-limit',
  'codex-network-check-server-stopped',
] as const;
export type CodexNetworkCheckError = (typeof CODEX_NETWORK_CHECK_ERRORS)[number];
export type CodexNetworkCopyKind = 'profile' | 'legacy-translated' | 'implicit-translated';
export interface CodexNetworkCheckBinding {
  workspaceId: string;
  controlContextId: string;
  captureSha256: string;
  configSha256: string | null;
  runtimeSha256: string;
  nativeBinarySha256: string;
  sourceGraphSha256: string;
  profileCopySha256: string;
  suiteSha256: string;
  copyKind: CodexNetworkCopyKind;
}
export interface CodexNetworkCheckProbe {
  id: 'tcp' | 'unix';
  positiveConnections: number;
  attempted: boolean;
  effect: 'denied' | 'allowed' | 'unreached' | 'error';
  connections: number;
  errno: 'EPERM' | 'EACCES' | null;
}
export interface CodexNetworkCheckResult {
  scope: 'isolated-permission-copy';
  outcome: 'passed' | 'attention' | 'inconclusive';
  nativeBinarySha256: string;
  profileCopySha256: string;
  suiteSha256: string;
  nativeExitCode: number | null;
  cleanupConfirmed: true;
  checks: CodexNetworkCheckProbe[];
  modelCalls: 0;
  providerCalls: 0;
}
export interface CodexNetworkCheckPreview {
  schema: 'stroq-codex-network-check-preview/1';
  id: string;
  operationId: string;
  jobId: string;
  createdAt: string;
  expiresAt: string;
  binding: CodexNetworkCheckBinding;
  scope: 'isolated-permission-copy';
  changesConfiguration: false;
  retainsDerivedResults: true;
  modelCalls: 0;
  providerCalls: 0;
}
export interface CodexNetworkCheckJob {
  schema: 'stroq-codex-network-check-job/1';
  id: string;
  operationId: string;
  binding: CodexNetworkCheckBinding;
  startedAt: string;
  finishedAt: string | null;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  progress: 'preparing' | 'positive' | 'native' | 'cleanup';
  error: CodexNetworkCheckError | null;
  result: CodexNetworkCheckResult | null;
}
export interface CodexNetworkCheckState {
  schema: 'stroq-codex-network-checks/2';
  workspaceId: string;
  controlContextId: string | null;
  generatedAt: string;
  history: 'ready' | 'unavailable';
  jobs: CodexNetworkCheckJob[];
  activeJobId: string | null;
  ownedJobId: string | null;
  error: CodexNetworkCheckError | null;
}
const exact = (v: unknown, keys: string[]): v is Record<string, unknown> =>
  closed(v, keys) && Reflect.ownKeys(v).length === keys.length;
const uuid = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const workspace = (v: unknown): v is string =>
  typeof v === 'string' && /^workspace-[a-f0-9]{24}$/.test(v);
export function validateCodexNetworkCheckBinding(v: unknown): v is CodexNetworkCheckBinding {
  return (
    exact(v, [
      'workspaceId',
      'controlContextId',
      'captureSha256',
      'configSha256',
      'runtimeSha256',
      'nativeBinarySha256',
      'sourceGraphSha256',
      'profileCopySha256',
      'suiteSha256',
      'copyKind',
    ]) &&
    workspace(v.workspaceId) &&
    isCodexControlContext(v.controlContextId) &&
    hash(v.captureSha256) &&
    (v.configSha256 === null || hash(v.configSha256)) &&
    [
      'runtimeSha256',
      'nativeBinarySha256',
      'sourceGraphSha256',
      'profileCopySha256',
      'suiteSha256',
    ].every((k) => hash(v[k])) &&
    member(v.copyKind, ['profile', 'legacy-translated', 'implicit-translated'])
  );
}
function probe(v: unknown, id: string): v is CodexNetworkCheckProbe {
  if (
    !exact(v, ['id', 'positiveConnections', 'attempted', 'effect', 'connections', 'errno']) ||
    v.id !== id ||
    !count(v.positiveConnections, 1) ||
    !count(v.connections, 1) ||
    typeof v.attempted !== 'boolean' ||
    !member(v.effect, ['denied', 'allowed', 'unreached', 'error']) ||
    !(v.errno === null || member(v.errno, ['EPERM', 'EACCES']))
  )
    return false;
  if (v.effect === 'denied') return v.attempted && v.connections === 0 && v.errno !== null;
  if (v.effect === 'allowed') return v.attempted && v.connections === 1 && v.errno === null;
  return v.connections === 0 && v.errno === null && (v.effect !== 'unreached' || !v.attempted);
}
export function codexNetworkCheckOutcome(
  v: Pick<CodexNetworkCheckResult, 'checks' | 'nativeExitCode'>,
): CodexNetworkCheckResult['outcome'] {
  if (v.nativeExitCode !== 0 || !v.checks.every((c) => c.positiveConnections === 1))
    return 'inconclusive';
  if (v.checks.some((c) => c.effect === 'allowed')) return 'attention';
  return v.checks.every((c) => c.effect === 'denied') ? 'passed' : 'inconclusive';
}
export function validateCodexNetworkCheckResult(v: unknown): v is CodexNetworkCheckResult {
  return (
    exact(v, [
      'scope',
      'outcome',
      'nativeBinarySha256',
      'profileCopySha256',
      'suiteSha256',
      'nativeExitCode',
      'cleanupConfirmed',
      'checks',
      'modelCalls',
      'providerCalls',
    ]) &&
    v.scope === 'isolated-permission-copy' &&
    member(v.outcome, ['passed', 'attention', 'inconclusive']) &&
    hash(v.nativeBinarySha256) &&
    hash(v.profileCopySha256) &&
    hash(v.suiteSha256) &&
    (v.nativeExitCode === null || count(v.nativeExitCode, 255)) &&
    v.cleanupConfirmed === true &&
    v.modelCalls === 0 &&
    v.providerCalls === 0 &&
    Array.isArray(v.checks) &&
    v.checks.length === 2 &&
    probe(v.checks[0], 'tcp') &&
    probe(v.checks[1], 'unix') &&
    v.outcome === codexNetworkCheckOutcome(v as unknown as CodexNetworkCheckResult)
  );
}
export function validateCodexNetworkCheckPreview(v: unknown): v is CodexNetworkCheckPreview {
  return (
    exact(v, [
      'schema',
      'id',
      'operationId',
      'jobId',
      'createdAt',
      'expiresAt',
      'binding',
      'scope',
      'changesConfiguration',
      'retainsDerivedResults',
      'modelCalls',
      'providerCalls',
    ]) &&
    v.schema === 'stroq-codex-network-check-preview/1' &&
    uuid(v.id) &&
    v.operationId === v.id &&
    uuid(v.jobId) &&
    v.jobId !== v.id &&
    stamp(v.createdAt) &&
    stamp(v.expiresAt) &&
    Date.parse(v.expiresAt) > Date.parse(v.createdAt) &&
    Date.parse(v.expiresAt) - Date.parse(v.createdAt) <= 120000 &&
    validateCodexNetworkCheckBinding(v.binding) &&
    v.scope === 'isolated-permission-copy' &&
    v.changesConfiguration === false &&
    v.retainsDerivedResults === true &&
    v.modelCalls === 0 &&
    v.providerCalls === 0
  );
}
export function validateCodexNetworkCheckJob(v: unknown): v is CodexNetworkCheckJob {
  if (
    !exact(v, [
      'schema',
      'id',
      'operationId',
      'binding',
      'startedAt',
      'finishedAt',
      'status',
      'progress',
      'error',
      'result',
    ]) ||
    v.schema !== 'stroq-codex-network-check-job/1' ||
    !uuid(v.id) ||
    !uuid(v.operationId) ||
    !validateCodexNetworkCheckBinding(v.binding) ||
    !stamp(v.startedAt) ||
    !member(v.status, ['running', 'completed', 'failed', 'cancelled']) ||
    !member(v.progress, ['preparing', 'positive', 'native', 'cleanup']) ||
    !(v.error === null || member(v.error, CODEX_NETWORK_CHECK_ERRORS))
  )
    return false;
  if (v.status === 'running') return v.finishedAt === null && v.error === null && v.result === null;
  if (!stamp(v.finishedAt) || v.finishedAt < v.startedAt) return false;
  if (v.status !== 'completed') return v.result === null && v.error !== null;
  return (
    v.error === null &&
    validateCodexNetworkCheckResult(v.result) &&
    ['nativeBinarySha256', 'profileCopySha256', 'suiteSha256'].every(
      (k) =>
        (v.result as unknown as Record<string, unknown>)[k] ===
        (v.binding as unknown as Record<string, unknown>)[k],
    )
  );
}
export function validateCodexNetworkCheckState(v: unknown): v is CodexNetworkCheckState {
  if (
    !exact(v, [
      'schema',
      'workspaceId',
      'controlContextId',
      'generatedAt',
      'history',
      'jobs',
      'activeJobId',
      'ownedJobId',
      'error',
    ]) ||
    v.schema !== 'stroq-codex-network-checks/2' ||
    !workspace(v.workspaceId) ||
    !(v.controlContextId === null || isCodexControlContext(v.controlContextId)) ||
    !stamp(v.generatedAt) ||
    !member(v.history, ['ready', 'unavailable']) ||
    !Array.isArray(v.jobs) ||
    v.jobs.length > 32 ||
    !v.jobs.every(validateCodexNetworkCheckJob) ||
    v.jobs.some((j) => j.binding.workspaceId !== v.workspaceId) ||
    new Set(v.jobs.map((j) => j.id)).size !== v.jobs.length ||
    !(v.activeJobId === null || uuid(v.activeJobId)) ||
    !(v.ownedJobId === null || (uuid(v.ownedJobId) && v.ownedJobId === v.activeJobId)) ||
    !(v.error === null || member(v.error, CODEX_NETWORK_CHECK_ERRORS))
  )
    return false;
  const active = v.jobs.filter((j) => j.status === 'running');
  return (
    active.length <= 1 &&
    (active[0]?.id ?? null) === v.activeJobId &&
    (v.history !== 'unavailable' || (v.error !== null && v.ownedJobId === null))
  );
}
