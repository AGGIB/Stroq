import type { AgentId } from './agent-status';
import { validateSetupResult } from './agent-setup';
import {
  HOOK_CHECK_AGENTS,
  validateHookCheckState,
  type HookCheckJob,
  type HookCheckScope,
  type HookCheckState,
} from './hook-checks';
import { closed, hash, member } from './local-guards';

const BASE = '/agents/hooks/';
const workspace = (value: unknown): value is string =>
  typeof value === 'string' && /^workspace-[a-f0-9]{24}$/.test(value);
const uuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
export interface HookCheckTarget {
  workspaceId: string;
  agent: AgentId;
  scope: HookCheckScope;
  sourceSha256?: string;
}
export type HookCheckNavigation =
  | { kind: 'overview' }
  | { kind: 'invalid' }
  | ({ kind: 'selection' } & HookCheckTarget)
  | { kind: 'job'; workspaceId: string; jobId: string };
export type HookCheckNavigationResolution =
  | {
      status:
        | 'overview'
        | 'loading'
        | 'invalid'
        | 'context-unavailable'
        | 'foreign-workspace'
        | 'history-unavailable'
        | 'missing-run';
    }
  | { status: 'selection'; selection: HookCheckTarget }
  | { status: 'job'; job: HookCheckJob; selection: HookCheckTarget };

export function parseHookCheckNavigation(query: string): HookCheckNavigation {
  if (query.length > 512) return { kind: 'invalid' };
  const params = new URLSearchParams(query);
  if (params.size === 0) return { kind: 'overview' };
  const allowed = ['workspace', 'agent', 'scope', 'source', 'job'];
  if ([...params.keys()].some((key) => !allowed.includes(key) || params.getAll(key).length !== 1))
    return { kind: 'invalid' };
  const workspaceId = params.get('workspace');
  if (!workspace(workspaceId)) return { kind: 'invalid' };
  if (params.has('job')) {
    const jobId = params.get('job');
    return params.size === 2 && uuid(jobId)
      ? { kind: 'job', workspaceId, jobId }
      : { kind: 'invalid' };
  }
  const agent = params.get('agent'),
    scope = params.get('scope'),
    sourceSha256 = params.get('source');
  if (
    !member(agent, HOOK_CHECK_AGENTS) ||
    !member(scope, ['project', 'user']) ||
    (sourceSha256 !== null && !hash(sourceSha256))
  )
    return { kind: 'invalid' };
  return {
    kind: 'selection',
    workspaceId,
    agent: agent as AgentId,
    scope: scope as HookCheckScope,
    ...(sourceSha256 === null ? {} : { sourceSha256 }),
  };
}

export function hookCheckHref(
  input: {
    workspaceId?: string;
    agent?: AgentId;
    scope?: HookCheckScope;
    sourceSha256?: string;
    jobId?: string;
  } = {},
): string | null {
  if (!closed(input, ['workspaceId', 'agent', 'scope', 'sourceSha256', 'jobId'])) return null;
  if (Reflect.ownKeys(input).length === 0) return BASE;
  if (!workspace(input.workspaceId)) return null;
  const params = new URLSearchParams({ workspace: input.workspaceId });
  if (input.jobId !== undefined) {
    if (
      !uuid(input.jobId) ||
      input.agent !== undefined ||
      input.scope !== undefined ||
      input.sourceSha256 !== undefined
    )
      return null;
    params.set('job', input.jobId);
  } else {
    if (
      !member(input.agent, HOOK_CHECK_AGENTS) ||
      !member(input.scope, ['project', 'user']) ||
      (input.sourceSha256 !== undefined && !hash(input.sourceSha256))
    )
      return null;
    params.set('agent', input.agent!);
    params.set('scope', input.scope!);
    if (input.sourceSha256 !== undefined) params.set('source', input.sourceSha256);
  }
  return `${BASE}?${params}`;
}

/** The configured bytes and actual selected scope come from the validated receipt. */
export function hookCheckHrefForSetup(result: unknown): string | null {
  return validateSetupResult(result)
    ? hookCheckHref({
        workspaceId: result.workspaceId,
        agent: result.agent,
        scope: result.scope,
        sourceSha256: result.candidateSha256,
      })
    : null;
}

export function resolveHookCheckNavigation(
  nav: HookCheckNavigation,
  workspaceId: string | null,
  state: HookCheckState | null,
): HookCheckNavigationResolution {
  if (nav.kind === 'invalid') return { status: 'invalid' };
  if (state !== null && !validateHookCheckState(state)) return { status: 'invalid' };
  if (nav.kind === 'overview') return { status: 'overview' };
  if (!workspace(workspaceId)) return { status: 'context-unavailable' };
  if (nav.workspaceId !== workspaceId || (state && state.workspaceId !== workspaceId))
    return { status: 'foreign-workspace' };
  if (nav.kind === 'selection') {
    const { kind: _kind, ...selection } = nav;
    return { status: 'selection', selection };
  }
  if (!state) return { status: 'loading' };
  const job = state.jobs.find(
    (item) => item.id === nav.jobId && item.binding.workspaceId === workspaceId,
  );
  if (!job)
    return { status: state.history.status === 'error' ? 'history-unavailable' : 'missing-run' };
  return {
    status: 'job',
    job,
    selection: { workspaceId, agent: job.binding.agent, scope: job.binding.scope },
  };
}
