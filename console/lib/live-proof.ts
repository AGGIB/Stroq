import { closed, count, hash, member, stamp, text } from './local-guards';
export type LiveAgent = 'claude-code' | 'codex' | 'cursor';
export interface LiveReport {
  state: 'verified' | 'failed' | 'inconclusive' | 'not-attempted' | 'unsupported';
  mode: 'live' | 'stand-in' | null;
  hostVersion: string | null;
  requestsMade: number;
  probes: {
    id: string;
    kind: 'allow' | 'deny' | 'secret-egress';
    mark: 'passed' | 'failed' | 'not-issued' | 'inconclusive' | 'skipped' | 'not-attempted';
    reason?: string;
    evidence: { E1: boolean | null; E2: boolean | null; E3: boolean | null; E4: boolean | null };
  }[];
  caveats: string[];
  advice: string[];
}
export interface LiveJob {
  schema: 'stroq-live-job/1';
  id: string;
  agent: LiveAgent;
  maxRequests: number;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: string;
  finishedAt?: string;
  result?: LiveReport;
  error?: string;
}
/** Matches the live service's session retention; updating a job must not invent eviction. */
export const LIVE_JOB_LIMIT = 24;
export function updateLiveJobs(jobs: readonly LiveJob[], job: LiveJob): LiveJob[] {
  return [...jobs.filter((item) => item.id !== job.id), job]
    .toSorted((a, b) => a.startedAt.localeCompare(b.startedAt))
    .slice(-LIVE_JOB_LIMIT);
}
/** A newer inconclusive job must not disappear behind an older passing record. */
export function latestLiveJob(jobs: readonly LiveJob[], agent: LiveAgent): LiveJob | null {
  return (
    jobs.find((j) => j.status === 'running') ??
    jobs
      .filter((j) => j.agent === agent)
      .toSorted((a, b) => b.startedAt.localeCompare(a.startedAt))[0] ??
    null
  );
}
export interface LiveState {
  schema: 'stroq-live/1';
  engine: { available: boolean; version: string | null };
  target: 'isolated-host';
  agents: {
    id: LiveAgent;
    supported: boolean;
    reason: null | 'platform-unmeasured' | 'driver-unavailable';
    proof: null | {
      state: 'verified' | 'stale' | 'failed' | 'inconclusive' | 'not-attempted';
      checkedAt: string;
      hostVersion: string | null;
      hostVersionRechecked: false;
      reason: string;
      report: LiveReport;
    };
  }[];
  jobs: LiveJob[];
}
export interface LivePreview {
  schema: 'stroq-live-preview/1';
  id: string;
  agent: LiveAgent;
  maxRequests: number;
  createdAt: string;
  expiresAt: string;
  engineVersion: string | null;
  hostVersion: string | null;
  policySha256: string | null;
  target: 'isolated-host';
  supported: boolean;
  canStart: boolean;
  reason?: string | null;
  disclosure: {
    usesSubscription: true;
    maxRequests: number;
    externalRequests: true;
    temporaryProject: true;
    checks: ('allow' | 'deny' | 'control')[];
    optionalSecretEgress: boolean;
  };
}
const agents = ['claude-code', 'codex', 'cursor'];
const nullableText = (v: unknown) => v === null || text(v, 100);
const budget = (v: unknown): v is number => count(v, 6) && v >= 3;
const strings = (v: unknown, max = 32) =>
  Array.isArray(v) && v.length <= max && v.every((s) => text(s, 600));
export function validateLiveReport(v: unknown): v is LiveReport {
  if (
    !closed(v, ['state', 'mode', 'hostVersion', 'requestsMade', 'probes', 'caveats', 'advice']) ||
    !member(v.state, ['verified', 'failed', 'inconclusive', 'not-attempted', 'unsupported']) ||
    !(v.mode === null || member(v.mode, ['live', 'stand-in'])) ||
    !nullableText(v.hostVersion) ||
    !count(v.requestsMade, 6) ||
    !strings(v.caveats) ||
    !strings(v.advice) ||
    !Array.isArray(v.probes) ||
    v.probes.length > 32
  )
    return false;
  if (
    !v.probes.every(
      (p) =>
        closed(p, ['id', 'kind', 'mark', 'reason', 'evidence']) &&
        text(p.id, 100) &&
        member(p.kind, ['allow', 'deny', 'secret-egress']) &&
        member(p.mark, [
          'passed',
          'failed',
          'not-issued',
          'inconclusive',
          'skipped',
          'not-attempted',
        ]) &&
        (!Object.hasOwn(p, 'reason') || text(p.reason, 200)) &&
        closed(p.evidence, ['E1', 'E2', 'E3', 'E4']) &&
        ['E1', 'E2', 'E3', 'E4'].every(
          (k) =>
            (p.evidence as Record<string, unknown>)[k] === null ||
            typeof (p.evidence as Record<string, unknown>)[k] === 'boolean',
        ),
    )
  )
    return false;
  return (
    v.state !== 'verified' ||
    (v.mode === 'live' &&
      v.requestsMade > 0 &&
      v.probes.some((p) => p.kind === 'deny' && p.mark === 'passed') &&
      !v.probes.some((p) => p.mark === 'failed'))
  );
}
export function validateLiveJob(v: unknown): v is LiveJob {
  if (
    !closed(v, [
      'schema',
      'id',
      'agent',
      'maxRequests',
      'status',
      'startedAt',
      'finishedAt',
      'result',
      'error',
    ]) ||
    v.schema !== 'stroq-live-job/1' ||
    !text(v.id, 100) ||
    !member(v.agent, agents) ||
    !budget(v.maxRequests) ||
    !stamp(v.startedAt) ||
    !member(v.status, ['running', 'completed', 'failed', 'cancelled'])
  )
    return false;
  if (v.status === 'running')
    return (
      !Object.hasOwn(v, 'finishedAt') && !Object.hasOwn(v, 'result') && !Object.hasOwn(v, 'error')
    );
  if (!stamp(v.finishedAt) || v.finishedAt < v.startedAt) return false;
  if (v.status === 'completed')
    return (
      validateLiveReport(v.result) &&
      v.result.requestsMade <= v.maxRequests &&
      !Object.hasOwn(v, 'error')
    );
  return !Object.hasOwn(v, 'result') && (!Object.hasOwn(v, 'error') || text(v.error, 100));
}
export function validateLiveState(v: unknown): v is LiveState {
  if (
    !closed(v, ['schema', 'engine', 'target', 'agents', 'jobs']) ||
    v.schema !== 'stroq-live/1' ||
    v.target !== 'isolated-host' ||
    !closed(v.engine, ['available', 'version']) ||
    typeof v.engine.available !== 'boolean' ||
    !nullableText(v.engine.version) ||
    !Array.isArray(v.agents) ||
    v.agents.length > agents.length ||
    !Array.isArray(v.jobs) ||
    v.jobs.length > 32 ||
    !v.jobs.every(validateLiveJob)
  )
    return false;
  return v.agents.every(
    (a) =>
      closed(a, ['id', 'supported', 'reason', 'proof']) &&
      member(a.id, agents) &&
      typeof a.supported === 'boolean' &&
      (a.reason === null || member(a.reason, ['platform-unmeasured', 'driver-unavailable'])) &&
      (a.proof === null ||
        (closed(a.proof, [
          'state',
          'checkedAt',
          'hostVersion',
          'hostVersionRechecked',
          'reason',
          'report',
        ]) &&
          member(a.proof.state, ['verified', 'stale', 'failed', 'inconclusive', 'not-attempted']) &&
          stamp(a.proof.checkedAt) &&
          nullableText(a.proof.hostVersion) &&
          a.proof.hostVersionRechecked === false &&
          text(a.proof.reason, 200) &&
          validateLiveReport(a.proof.report))),
  );
}
export function validateLivePreview(v: unknown): v is LivePreview {
  return (
    closed(v, [
      'schema',
      'id',
      'agent',
      'maxRequests',
      'createdAt',
      'expiresAt',
      'engineVersion',
      'hostVersion',
      'policySha256',
      'target',
      'supported',
      'canStart',
      'reason',
      'disclosure',
    ]) &&
    v.schema === 'stroq-live-preview/1' &&
    text(v.id, 100) &&
    member(v.agent, agents) &&
    budget(v.maxRequests) &&
    stamp(v.createdAt) &&
    stamp(v.expiresAt) &&
    v.expiresAt > v.createdAt &&
    nullableText(v.engineVersion) &&
    nullableText(v.hostVersion) &&
    (v.policySha256 === null || hash(v.policySha256)) &&
    v.target === 'isolated-host' &&
    typeof v.supported === 'boolean' &&
    typeof v.canStart === 'boolean' &&
    (!v.canStart || v.supported) &&
    (!Object.hasOwn(v, 'reason') || v.reason === null || text(v.reason, 200)) &&
    closed(v.disclosure, [
      'usesSubscription',
      'maxRequests',
      'externalRequests',
      'temporaryProject',
      'checks',
      'optionalSecretEgress',
    ]) &&
    v.disclosure.usesSubscription === true &&
    v.disclosure.maxRequests === v.maxRequests &&
    v.disclosure.externalRequests === true &&
    v.disclosure.temporaryProject === true &&
    Array.isArray(v.disclosure.checks) &&
    v.disclosure.checks.length === 3 &&
    ['allow', 'deny', 'control'].every((c) =>
      ((v.disclosure as Record<string, unknown>).checks as unknown[]).includes(c),
    ) &&
    typeof v.disclosure.optionalSecretEgress === 'boolean'
  );
}
