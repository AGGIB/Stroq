import { randomUUID } from 'node:crypto';
import { serialize } from 'node:v8';
import { isDeepStrictEqual } from 'node:util';
import { isCodexControlContext } from '../lib/codex-skill-controls';
import { hash } from '../lib/local-guards';
import {
  codexNetworkGuardCheckPreparationBytes,
  type CodexNetworkGuardCheckPreparation,
} from '../lib/codex-network-guard-check-private';
import {
  validateCodexNetworkCheckJob,
  validateCodexNetworkCheckResult,
  validateCodexNetworkCheckPreview,
  validateCodexNetworkCheckState,
  type CodexNetworkCheckJob,
  type CodexNetworkCheckPreview,
  type CodexNetworkCheckError,
} from '../lib/codex-network-check';
import { createNetworkCheckJournal } from './codex-network-check-journal';
import type { NetworkInventory, NetworkReply } from './codex-network-service';

import {
  exact,
  failure,
  invalid,
  MAX_BYTES,
  code,
  type Store,
  type Runner,
  type NetworkCheckLease,
  prepareNetworkCheck,
  networkCheckBinding,
  assertNetworkCheckOwnership,
  failNetworkCheckRelease,
} from './codex-network-check-service-shared';

/** A canary job proves one isolated permission copy. It never runs a chat or edits Codex config. */
export async function createCodexNetworkCheckService({
  inventory,
  workspaceId,
  store,
  run,
  acquireLease,
  now = Date.now,
}: {
  inventory: NetworkInventory;
  workspaceId: string;
  store: Store;
  run: Runner;
  acquireLease: () => Promise<NetworkCheckLease | null>;
  now?: () => number;
}) {
  const journal = createNetworkCheckJournal(store, workspaceId);
  let jobs = journal.initial,
    closed = false,
    busy = false;
  let active: {
    id: string;
    controller: AbortController;
    reason: 'cancelled' | 'server-stopped' | null;
    lease: NetworkCheckLease;
    releasing: boolean;
  } | null = null;
  let task: Promise<void> | null = null;
  let admission: Promise<NetworkReply> | null = null;
  const plans = new Map<
    string,
    {
      preview: CodexNetworkCheckPreview;
      preparation: CodexNetworkGuardCheckPreparation;
      expires: number;
      bytes: number;
    }
  >();
  const historyReady = journal.ready;
  async function refresh() {
    try {
      await assertNetworkCheckOwnership(active);
      const fresh = await journal.refresh(active !== null && !active.releasing);
      if (!fresh) throw Error('history-unavailable');
      if (!active || active.releasing) jobs = fresh;
      return true;
    } catch {
      journal.latch();
      active?.controller.abort();
      return false;
    }
  }
  const prune = () => {
    for (const [id, p] of plans) if (p.expires <= now()) plans.delete(id);
  };
  const exclusive = (action: () => Promise<NetworkReply>): Promise<NetworkReply> => {
    if (closed) return Promise.resolve(failure('codex-network-check-unavailable', 503));
    if (busy) return Promise.resolve(failure('codex-network-check-busy'));
    busy = true;
    const pending = Promise.resolve()
      .then(() => (closed ? failure('codex-network-check-unavailable', 503) : action()))
      .catch(() => failure('codex-network-check-unavailable', 503))
      .finally(() => {
        busy = false;
        if (admission === pending) admission = null;
      });
    admission = pending;
    return pending;
  };
  const prepare = (selection: { controlContextId: string; captureSha256: string }) =>
    prepareNetworkCheck(inventory, selection);
  const binding = (input: CodexNetworkGuardCheckPreparation) =>
    networkCheckBinding(input, workspaceId);
  async function finish(
    job: CodexNetworkCheckJob,
    preparation: CodexNetworkGuardCheckPreparation,
    current: NonNullable<typeof active>,
  ) {
    let result: unknown,
      error: CodexNetworkCheckError | null = null;
    try {
      await current.lease.assertCurrent();
      result = await run(preparation, {
        signal: current.controller.signal,
        onProgress: (id) => {
          if (['positive', 'native', 'cleanup'].includes(id)) job.progress = id;
        },
      });
      if (
        !validateCodexNetworkCheckResult(result) ||
        ['nativeBinarySha256', 'profileCopySha256', 'suiteSha256'].some(
          (k) => (result as any)[k] !== (job.binding as any)[k],
        )
      )
        throw Error('invalid-report');
      if (job.binding.runtimeSha256 !== (await inventory.codexNetworkRuntime()))
        throw Error('native-changed');
    } catch (e) {
      error = code(e);
    }
    if (error !== 'codex-network-check-cleanup-failed' && current.reason)
      error =
        current.reason === 'cancelled'
          ? 'codex-network-check-cancelled'
          : 'codex-network-check-server-stopped';
    job.progress = 'cleanup';
    const terminal: CodexNetworkCheckJob = {
      ...job,
      finishedAt: new Date(Math.max(now(), Date.parse(job.startedAt))).toISOString(),
      status:
        error === null
          ? 'completed'
          : error === 'codex-network-check-cancelled'
            ? 'cancelled'
            : 'failed',
      error,
      result: error === null ? (result as CodexNetworkCheckJob['result']) : null,
    };
    if (!validateCodexNetworkCheckJob(terminal)) {
      terminal.status = 'failed';
      terminal.error = 'codex-network-check-invalid-report';
      terminal.result = null;
    }
    if (
      !(await journal.publish(
        jobs.map((j) => (j.id === job.id ? terminal : j)),
        current.lease,
      ))
    ) {
      terminal.status = 'failed';
      terminal.error = 'codex-network-check-history-unavailable';
      terminal.result = null;
    }
    Object.assign(job, terminal);
    current.releasing = true;
    try {
      await current.lease.release();
    } catch {
      journal.latch();
      jobs = failNetworkCheckRelease(jobs, job);
    }
    if (active === current) active = null;
  }
  return {
    read: () =>
      exclusive(async () => {
        await refresh();
        const response = await inventory.codexNetworkOperation('codex-network-state', {});
        if (response.status !== 200)
          return failure(
            response.body?.error === 'codex-network-busy'
              ? 'codex-network-check-busy'
              : 'codex-network-check-unavailable',
            response.status === 409 ? 409 : 503,
          );
        const context = response.body?.controlContextId;
        const state = {
          schema: 'stroq-codex-network-checks/2',
          workspaceId,
          controlContextId: isCodexControlContext(context) ? context : null,
          generatedAt: new Date(now()).toISOString(),
          history: historyReady() ? 'ready' : 'unavailable',
          jobs: structuredClone(jobs),
          activeJobId: jobs.find((j) => j.status === 'running')?.id ?? null,
          ownedJobId:
            historyReady() &&
            active &&
            !active.releasing &&
            jobs.some((j) => j.id === active.id && j.status === 'running')
              ? active.id
              : null,
          error: historyReady() ? null : 'codex-network-check-history-unavailable',
        };
        return validateCodexNetworkCheckState(state)
          ? { status: 200, body: state }
          : failure('codex-network-check-unavailable', 503);
      }),
    preview(input: any) {
      if (
        !exact(input, ['controlContextId', 'captureSha256']) ||
        !isCodexControlContext(input.controlContextId) ||
        !hash(input.captureSha256)
      )
        return Promise.resolve(invalid());
      input = structuredClone(input);
      return exclusive(async () => {
        if (active) return failure('codex-network-check-busy');
        await refresh();
        if (!historyReady()) return failure('codex-network-check-history-unavailable');
        prune();
        if (plans.size >= 8) return failure('codex-network-check-busy');
        let preparation;
        try {
          preparation = await prepare(input);
        } catch (e) {
          return failure(
            e instanceof Error && e.message === 'check-busy' ? 'codex-network-check-busy' : code(e),
          );
        }
        const created = now(),
          id = randomUUID();
        const preview: CodexNetworkCheckPreview = {
          schema: 'stroq-codex-network-check-preview/1',
          id,
          operationId: id,
          jobId: randomUUID(),
          createdAt: new Date(created).toISOString(),
          expiresAt: new Date(created + 120000).toISOString(),
          binding: binding(preparation),
          scope: 'isolated-permission-copy',
          changesConfiguration: false,
          retainsDerivedResults: true,
          modelCalls: 0,
          providerCalls: 0,
        };
        const bytes = Math.max(
          serialize(preparation).byteLength,
          codexNetworkGuardCheckPreparationBytes(preparation),
        );
        if (!validateCodexNetworkCheckPreview(preview) || closed)
          return failure('codex-network-check-unavailable', 503);
        if ([...plans.values()].reduce((n, p) => n + p.bytes, bytes) > MAX_BYTES)
          return failure('codex-network-check-busy');
        plans.set(id, {
          preview,
          preparation: structuredClone(preparation),
          expires: created + 120000,
          bytes,
        });
        return { status: 200, body: structuredClone(preview) };
      });
    },
    start(input: any) {
      const plan = input && typeof input === 'object' ? plans.get(input.previewId) : undefined;
      if (plan) plans.delete(input.previewId);
      prune();
      if (!plan) return Promise.resolve(failure('codex-network-check-stale'));
      if (plan.expires <= now()) return Promise.resolve(failure('codex-network-check-expired'));
      if (
        !exact(input, ['previewId', 'controlContextId']) ||
        input.controlContextId !== plan.preview.binding.controlContextId
      )
        return Promise.resolve(invalid());
      return exclusive(async () => {
        if (active) return failure('codex-network-check-busy');
        if (!historyReady()) return failure('codex-network-check-history-unavailable');
        let lease: NetworkCheckLease | null = null,
          transferred = false;
        try {
          if (!(await store.prepare())) return failure('codex-network-check-history-unavailable');
          if (closed) return failure('codex-network-check-unavailable', 503);
          lease = await acquireLease();
          if (!lease) return failure('codex-network-check-busy');
          if (closed) return failure('codex-network-check-unavailable', 503);
          if (!(await refresh())) return failure('codex-network-check-history-unavailable');
          const current = await prepare({
            controlContextId: plan.preview.binding.controlContextId,
            captureSha256: plan.preview.binding.captureSha256,
          });
          if (
            !isDeepStrictEqual(current, plan.preparation) ||
            !isDeepStrictEqual(binding(current), plan.preview.binding) ||
            now() >= plan.expires
          )
            return failure('codex-network-check-stale');
          if (closed) return failure('codex-network-check-unavailable', 503);
          const job: CodexNetworkCheckJob = {
            schema: 'stroq-codex-network-check-job/1',
            id: plan.preview.jobId,
            operationId: plan.preview.operationId,
            binding: plan.preview.binding,
            startedAt: new Date(now()).toISOString(),
            finishedAt: null,
            status: 'running',
            progress: 'preparing',
            error: null,
            result: null,
          };
          if (!validateCodexNetworkCheckJob(job))
            return failure('codex-network-check-invalid-report', 503);
          const previous = jobs;
          // Only exclusive explicit admission may recover an interrupted retained attempt.
          const retained = jobs.map((j): CodexNetworkCheckJob =>
            j.status === 'running'
              ? {
                  ...j,
                  status: 'failed',
                  finishedAt: new Date(Math.max(now(), Date.parse(j.startedAt))).toISOString(),
                  error: 'codex-network-check-server-stopped',
                  result: null,
                }
              : j,
          );
          jobs = [job, ...retained].slice(0, 32);
          if (!(await journal.publish(jobs, lease))) {
            jobs = previous;
            return failure('codex-network-check-history-unavailable');
          }
          if (closed) {
            job.status = 'failed';
            job.finishedAt = new Date(Math.max(now(), Date.parse(job.startedAt))).toISOString();
            job.error = 'codex-network-check-server-stopped';
            await journal.publish(jobs, lease);
            return failure('codex-network-check-unavailable', 503);
          }
          active = {
            id: job.id,
            controller: new AbortController(),
            reason: null,
            lease,
            releasing: false,
          };
          const selected = active;
          transferred = true;
          task = Promise.resolve().then(() => finish(job, current, selected));
          return { status: 200, body: structuredClone(job) };
        } catch (e) {
          return failure(
            e instanceof Error && e.message === 'check-busy' ? 'codex-network-check-busy' : code(e),
          );
        } finally {
          if (lease && !transferred)
            try {
              await lease.release();
            } catch {
              journal.latch();
            }
        }
      });
    },
    async cancel(input: any): Promise<NetworkReply> {
      if (closed) return failure('codex-network-check-unavailable', 503);
      if (!exact(input, ['jobId', 'controlContextId', 'operationId'])) return invalid();
      const job = jobs.find(
        (j) =>
          j.id === input.jobId &&
          j.operationId === input.operationId &&
          j.binding.controlContextId === input.controlContextId,
      );
      if (!job) return failure('codex-network-check-stale');
      if (job.status !== 'running') return { status: 200, body: structuredClone(job) };
      if (!active || active.releasing || active.id !== job.id)
        return failure('codex-network-check-busy');
      active.reason = 'cancelled';
      active.controller.abort();
      await task;
      return { status: 200, body: structuredClone(job) };
    },
    async close() {
      closed = true;
      plans.clear();
      if (active) {
        active.reason = 'server-stopped';
        active.controller.abort();
      }
      await admission;
      await task;
    },
    async wait() {
      await task;
    },
  };
}
