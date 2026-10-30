import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  createWorkspaceReviewContext,
  closedWorkspaceInput as closed,
} from './workspace-review-context.mjs';
import { createWorkspaceMonitorStore } from './workspace-monitor-store.mjs';
import { createWorkspaceMonitorService } from './workspace-monitor-service.mjs';

const SHA = /^[a-f0-9]{64}$/;
const TTL = 120000,
  MAX_PREVIEWS = 32;
const finite = new Set([
  'runtime-unavailable',
  'context-unavailable',
  'platform-unsupported',
  'stale-capture',
  'server-stopped',
  'monitor-store-invalid',
  'monitor-store-unavailable',
  'monitor-store-stale',
  'monitor-store-limit',
  'monitor-store-write-unconfirmed',
  'workspace-review-busy',
  'workspace-review-failed',
  'monitor-in-use',
  'monitor-preview-expired',
]);
const failure = (code, status = 503) => ({ status, body: { error: code } });
const errorOf = (error) => (finite.has(error?.message) ? error.message : 'workspace-review-failed');
const nullableSha = (v) => v === null || (typeof v === 'string' && SHA.test(v));

/** A browser can review a fixed local action; all paths, runtime bindings and scheduling stay server-owned. */
export async function createWorkspaceMonitorControl(configuration = {}) {
  const context = configuration.context ?? (await createWorkspaceReviewContext(configuration));
  const unavailable = async () => {
    throw Error('context-unavailable');
  };
  const store =
    configuration.store ??
    (context.roots
      ? createWorkspaceMonitorStore({
          home: context.options.home,
          storeId: context.storeId,
          workspaceId: context.workspaceId,
          roots: context.roots,
        })
      : {
          read: unavailable,
          context: unavailable,
          update: unavailable,
          acquireLease: unavailable,
        });
  const scheduler =
    configuration.scheduler ?? createWorkspaceMonitorService({ ...configuration, context, store });
  const now = configuration.now ?? Date.now,
    previews = new Map();
  let stopped = false;
  const stamp = () => new Date(now()).toISOString();
  async function currentSnapshot() {
    const snapshot = await store.read();
    const bound = await context.current();
    const after = await store.read();
    if ((snapshot?.revision ?? null) !== (after?.revision ?? null))
      throw Error('monitor-store-stale');
    return { snapshot, bound };
  }
  async function state() {
    let value = scheduler.getState();
    try {
      const snapshot = await store.read();
      value = {
        ...value,
        revision: snapshot?.revision ?? null,
        configuredAt: snapshot?.record.configuredAt ?? null,
      };
      if (value.revision !== scheduler.getState().revision || !snapshot?.record.enabled) {
        value = {
          ...value,
          status: snapshot?.record.enabled ? 'needs-review' : 'disabled',
          reason: snapshot?.record.enabled ? 'monitor-store-stale' : null,
          nextCheckAt: null,
        };
      }
      try {
        const bound = await context.current(),
          storage = await store.context();
        value.runtimeSha256 = bound.runtimeSha256;
        if (
          snapshot?.record.enabled &&
          (!isDeepStrictEqual(storage, {
            home: snapshot.record.home,
            roots: snapshot.record.roots,
            workspaceId: snapshot.record.workspaceId,
            storeId: snapshot.record.storeId,
          }) ||
            snapshot.record.engineVersion !== bound.engineVersion ||
            snapshot.record.runtimeSha256 !== bound.runtimeSha256)
        )
          value = { ...value, status: 'needs-review', reason: 'stale-capture', nextCheckAt: null };
      } catch (error) {
        value = {
          ...value,
          status: snapshot?.record.enabled ? 'needs-review' : snapshot ? 'disabled' : 'unavailable',
          reason: errorOf(error),
          runtimeSha256: null,
          nextCheckAt: null,
        };
      }
      const after = await store.read();
      if ((after?.revision ?? null) !== (snapshot?.revision ?? null))
        throw Error('monitor-store-stale');
    } catch (error) {
      value = {
        ...value,
        status: 'unavailable',
        reason: errorOf(error),
        runtimeSha256: null,
        nextCheckAt: null,
      };
    }
    if (stopped)
      value = { ...value, status: 'stopped', reason: 'server-stopped', nextCheckAt: null };
    return { status: 200, body: value };
  }
  async function preview(input) {
    if (stopped) return failure('server-stopped');
    if (
      !closed(input, ['action', 'expectedRevision']) ||
      !['enable', 'pause'].includes(input.action) ||
      !nullableSha(input.expectedRevision)
    )
      return failure('invalid-request', 400);
    try {
      let snapshot, bound;
      if (input.action === 'enable') ({ snapshot, bound } = await currentSnapshot());
      else {
        snapshot = await store.read();
        if (!snapshot) return failure('monitor-store-stale', 409);
        try {
          bound = await context.current();
        } catch {
          bound = {
            engineVersion: snapshot.record.engineVersion,
            runtimeSha256: snapshot.record.runtimeSha256,
          };
        }
      }
      if ((snapshot?.revision ?? null) !== input.expectedRevision)
        return failure('monitor-store-stale', 409);
      if (stopped) return failure('server-stopped');
      for (const [id, entry] of previews) if (entry.expires <= now()) previews.delete(id);
      while (previews.size >= MAX_PREVIEWS) previews.delete(previews.keys().next().value);
      const createdAt = now(),
        expiresAt = createdAt + TTL;
      const plan = {
        schema: 'stroq-workspace-monitor-preview/1',
        id: randomUUID(),
        createdAt: new Date(createdAt).toISOString(),
        expiresAt: new Date(expiresAt).toISOString(),
        workspaceId: context.workspaceId,
        action: input.action,
        expectedRevision: input.expectedRevision,
        runtimeSha256: bound.runtimeSha256,
        intervalMs: 300000,
        hostEnforcement: false,
      };
      previews.set(plan.id, { plan, bound, expires: expiresAt });
      return { status: 200, body: structuredClone(plan) };
    } catch (error) {
      return failure(errorOf(error));
    }
  }
  async function apply(input) {
    if (stopped) return failure('server-stopped');
    if (
      !closed(input, ['previewId', 'confirm', 'acknowledgeLocalChecks', 'acknowledgeRetention']) ||
      typeof input.previewId !== 'string' ||
      input.confirm !== true ||
      typeof input.acknowledgeLocalChecks !== 'boolean' ||
      typeof input.acknowledgeRetention !== 'boolean'
    )
      return failure('invalid-request', 400);
    const entry = previews.get(input.previewId);
    if (!entry || entry.expires <= now()) {
      previews.delete(input.previewId);
      return failure('monitor-preview-expired', 409);
    }
    const { plan, bound } = entry;
    if (plan.action === 'enable' && (!input.acknowledgeLocalChecks || !input.acknowledgeRetention))
      return failure('invalid-request', 400);
    // Consume before the first await. An uncertain response is never retried with this consent.
    previews.delete(input.previewId);
    try {
      const beforeCommit = async () => {
        if (stopped) throw Error('server-stopped');
        if (now() >= entry.expires) throw Error('monitor-preview-expired');
      };
      if (plan.action === 'enable') {
        const fresh = await context.current();
        if (!isDeepStrictEqual(bound, fresh)) return failure('stale-capture', 409);
      }
      await beforeCommit();
      const reply = await scheduler[plan.action]({
        expectedRevision: plan.expectedRevision,
        beforeCommit,
        ...(plan.action === 'enable' ? { expectedBound: bound } : {}),
      });
      if (reply.status !== 200) return reply;
      return {
        status: 200,
        body: {
          schema: 'stroq-workspace-monitor-receipt/1',
          previewId: plan.id,
          workspaceId: context.workspaceId,
          action: plan.action,
          completedAt: stamp(),
          revision: reply.body.revision,
          runtimeSha256: plan.runtimeSha256,
          enabled: plan.action === 'enable',
          hostEnforcement: false,
        },
      };
    } catch (error) {
      const code = errorOf(error);
      return failure(code, code === 'monitor-preview-expired' ? 409 : 503);
    }
  }
  return {
    state,
    preview,
    apply,
    start: () => scheduler.start(),
    async close() {
      stopped = true;
      previews.clear();
      await scheduler.close();
    },
  };
}
