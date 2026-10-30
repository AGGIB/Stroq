import type { AgentId } from './agent-status';
import { closed, count, hash, member, stamp, text } from './local-guards';

export const HOOK_CHECK_AGENTS = ['claude-code', 'codex', 'cursor'] as const;
export const HOOK_CHECK_ERRORS = [
  'engine-unavailable',
  'platform-unsupported',
  'configuration-unreadable',
  'hooks-not-configured',
  'policy-unavailable',
  'preview-stale',
  'preview-expired',
  'hook-check-busy',
  'history-unavailable',
  'deadline-exceeded',
  'output-limit',
  'server-stopped',
  'cancelled',
  'invalid-report',
  'cleanup-failed',
  'hook-check-failed',
] as const;
export type HookCheckError = (typeof HOOK_CHECK_ERRORS)[number];
export type HookCheckEffect = 'allow' | 'ask' | 'deny';
export type HookCheckScope = 'project' | 'user';
export interface HookCheckBinding {
  workspaceId: string;
  agent: AgentId;
  scope: HookCheckScope;
  sourceSha256: string;
  policySha256: string | null;
  policySemanticSha256: string;
  runtimeSha256: string;
}
export interface HookCheckProbe {
  id: 'ordinary' | 'encoded-fetch';
  expectedEffect: HookCheckEffect;
  expectedWire: HookCheckEffect;
  observedEffect: HookCheckEffect | null;
  wireEffect: HookCheckEffect | 'unreadable';
  auditConfirmed: boolean;
  exitCode: number | null;
  durationMs: number;
  matched: boolean;
}
export interface HookCheckResult {
  status: 'passed' | 'attention' | 'failed';
  probes: [HookCheckProbe, HookCheckProbe];
  standard: { ordinaryAllowed: boolean; encodedDenied: boolean };
  evidence: 'isolated-hook-execution';
  isolated: true;
  providerRequests: 0;
  hostEnforcement: false;
}
export interface HookCheckJob {
  schema: 'stroq-hook-check-job/1';
  id: string;
  previewId: string;
  binding: HookCheckBinding;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: string;
  finishedAt?: string;
  result?: HookCheckResult;
  error?: HookCheckError;
}
export interface HookCheckPreview {
  schema: 'stroq-hook-check-preview/1';
  id: string;
  agent: AgentId;
  scope: HookCheckScope;
  createdAt: string;
  expiresAt: string;
  engineVersion: string | null;
  canStart: boolean;
  reason: HookCheckError | null;
  binding: HookCheckBinding | null;
}
export interface HookCheckState {
  schema: 'stroq-hook-checks/1';
  workspaceId: string;
  engine: { available: boolean; version: string | null };
  agents: { id: AgentId; supported: boolean; reason: 'platform-unsupported' | null }[];
  history: { status: 'ready' | 'disabled' | 'error'; error?: string };
  jobs: HookCheckJob[];
}
const uuid = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const workspace = (v: unknown) => typeof v === 'string' && /^workspace-[a-f0-9]{24}$/.test(v);
const scope = (v: unknown) => member(v, ['project', 'user']);
const effect = (v: unknown) => member(v, ['allow', 'ask', 'deny']);
const version = (v: unknown) => v === null || text(v, 100);
export function validateHookCheckBinding(v: unknown): v is HookCheckBinding {
  return (
    closed(v, [
      'workspaceId',
      'agent',
      'scope',
      'sourceSha256',
      'policySha256',
      'policySemanticSha256',
      'runtimeSha256',
    ]) &&
    workspace(v.workspaceId) &&
    member(v.agent, HOOK_CHECK_AGENTS) &&
    scope(v.scope) &&
    hash(v.sourceSha256) &&
    (v.policySha256 === null || hash(v.policySha256)) &&
    hash(v.policySemanticSha256) &&
    hash(v.runtimeSha256)
  );
}
function validateProbe(v: unknown): v is HookCheckProbe {
  if (
    !closed(v, [
      'id',
      'expectedEffect',
      'expectedWire',
      'observedEffect',
      'wireEffect',
      'auditConfirmed',
      'exitCode',
      'durationMs',
      'matched',
    ]) ||
    !member(v.id, ['ordinary', 'encoded-fetch']) ||
    !effect(v.expectedEffect) ||
    !effect(v.expectedWire) ||
    !(v.observedEffect === null || effect(v.observedEffect)) ||
    !(v.wireEffect === 'unreadable' || effect(v.wireEffect)) ||
    typeof v.auditConfirmed !== 'boolean' ||
    !(v.exitCode === null || count(v.exitCode, 255)) ||
    !count(v.durationMs, 120_000) ||
    typeof v.matched !== 'boolean'
  )
    return false;
  return (
    v.auditConfirmed === (v.observedEffect !== null) &&
    v.matched ===
      (v.expectedWire === v.wireEffect && v.observedEffect === v.expectedEffect && v.auditConfirmed)
  );
}
/** Derive success from both protocol output and its matching isolated audit event. */
export function validateHookCheckResult(v: unknown): v is HookCheckResult {
  if (
    !closed(v, [
      'status',
      'probes',
      'standard',
      'evidence',
      'isolated',
      'providerRequests',
      'hostEnforcement',
    ]) ||
    !member(v.status, ['passed', 'attention', 'failed']) ||
    v.evidence !== 'isolated-hook-execution' ||
    v.isolated !== true ||
    v.providerRequests !== 0 ||
    v.hostEnforcement !== false ||
    !Array.isArray(v.probes) ||
    v.probes.length !== 2 ||
    !v.probes.every(validateProbe) ||
    v.probes[0]!.id !== 'ordinary' ||
    v.probes[1]!.id !== 'encoded-fetch' ||
    !closed(v.standard, ['ordinaryAllowed', 'encodedDenied'])
  )
    return false;
  const ordinaryAllowed = v.probes[0]!.auditConfirmed && v.probes[0]!.observedEffect === 'allow';
  const encodedDenied = v.probes[1]!.auditConfirmed && v.probes[1]!.observedEffect === 'deny';
  const status = v.probes.every((p) => p.matched)
    ? ordinaryAllowed && encodedDenied
      ? 'passed'
      : 'attention'
    : 'failed';
  return (
    v.standard.ordinaryAllowed === ordinaryAllowed &&
    v.standard.encodedDenied === encodedDenied &&
    v.status === status
  );
}
export function validateHookCheckJob(v: unknown): v is HookCheckJob {
  if (
    !closed(v, [
      'schema',
      'id',
      'previewId',
      'binding',
      'status',
      'startedAt',
      'finishedAt',
      'result',
      'error',
    ]) ||
    v.schema !== 'stroq-hook-check-job/1' ||
    !uuid(v.id) ||
    !uuid(v.previewId) ||
    !validateHookCheckBinding(v.binding) ||
    !member(v.status, ['running', 'completed', 'failed', 'cancelled']) ||
    !stamp(v.startedAt)
  )
    return false;
  if (v.status === 'running')
    return (
      !Object.hasOwn(v, 'finishedAt') && !Object.hasOwn(v, 'result') && !Object.hasOwn(v, 'error')
    );
  if (!stamp(v.finishedAt) || v.finishedAt < v.startedAt) return false;
  const binding = v.binding;
  if (v.status === 'completed')
    return (
      validateHookCheckResult(v.result) &&
      !Object.hasOwn(v, 'error') &&
      v.result.probes.every(
        (p) =>
          (!p.matched || p.exitCode === 0) &&
          p.expectedWire ===
            (binding.agent === 'codex' && p.expectedEffect === 'ask' ? 'deny' : p.expectedEffect),
      )
    );
  return (
    !Object.hasOwn(v, 'result') &&
    member(v.error, HOOK_CHECK_ERRORS) &&
    (v.status !== 'cancelled' || v.error === 'cancelled')
  );
}
export function validateHookCheckPreview(v: unknown): v is HookCheckPreview {
  if (
    !closed(v, [
      'schema',
      'id',
      'agent',
      'scope',
      'createdAt',
      'expiresAt',
      'engineVersion',
      'canStart',
      'reason',
      'binding',
    ]) ||
    v.schema !== 'stroq-hook-check-preview/1' ||
    !uuid(v.id) ||
    !member(v.agent, HOOK_CHECK_AGENTS) ||
    !scope(v.scope) ||
    !stamp(v.createdAt) ||
    !stamp(v.expiresAt) ||
    v.expiresAt <= v.createdAt ||
    Date.parse(v.expiresAt) - Date.parse(v.createdAt) > 120_000 ||
    !version(v.engineVersion) ||
    typeof v.canStart !== 'boolean'
  )
    return false;
  return v.canStart
    ? v.reason === null &&
        text(v.engineVersion, 100) &&
        validateHookCheckBinding(v.binding) &&
        v.binding.agent === v.agent &&
        v.binding.scope === v.scope
    : v.binding === null && member(v.reason, HOOK_CHECK_ERRORS);
}
export function validateHookCheckState(v: unknown): v is HookCheckState {
  if (
    !closed(v, ['schema', 'workspaceId', 'engine', 'agents', 'history', 'jobs']) ||
    v.schema !== 'stroq-hook-checks/1' ||
    !workspace(v.workspaceId) ||
    !closed(v.engine, ['available', 'version']) ||
    typeof v.engine.available !== 'boolean' ||
    !version(v.engine.version) ||
    !Array.isArray(v.agents) ||
    v.agents.length !== HOOK_CHECK_AGENTS.length ||
    !v.agents.every(
      (a) =>
        closed(a, ['id', 'supported', 'reason']) &&
        member(a.id, HOOK_CHECK_AGENTS) &&
        typeof a.supported === 'boolean' &&
        (a.supported ? a.reason === null : a.reason === 'platform-unsupported'),
    ) ||
    new Set(v.agents.map((a) => a.id)).size !== HOOK_CHECK_AGENTS.length ||
    !closed(v.history, ['status', 'error']) ||
    !member(v.history.status, ['ready', 'disabled', 'error']) ||
    !Array.isArray(v.jobs) ||
    v.jobs.length > 32 ||
    !v.jobs.every(validateHookCheckJob) ||
    new Set(v.jobs.map((j) => j.id)).size !== v.jobs.length ||
    v.jobs.filter((j) => j.status === 'running').length > 1 ||
    !v.jobs.every((j) => j.binding.workspaceId === v.workspaceId)
  )
    return false;
  return v.history.status === 'error'
    ? member(v.history.error, [
        'unavailable',
        'unsafe-path',
        'invalid-history',
        'read-failed',
        'write-failed',
      ])
    : !Object.hasOwn(v.history, 'error');
}
