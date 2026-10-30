import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { closed, hash, stamp as validStamp } from '../lib/local-guards.ts';
import {
  validateInventoryMonitorState,
  type InventoryMonitorPreview,
  type InventoryMonitorState,
} from '../lib/inventory-monitor.ts';
import { createWorkspaceReviewContext } from './workspace-review-context.mjs';
import { createInventoryMonitorStore } from './inventory-monitor-store.ts';
import {
  assertInventoryMonitorContext,
  inventorySourceProfileSha256,
} from './inventory-monitor-context.ts';
import {
  createInventoryMonitorService,
  inventoryMonitorError,
  type MonitorBound,
} from './inventory-monitor-service.ts';

const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  closed(value, keys) && Reflect.ownKeys(value).length === keys.length;
const fail = (error: string, status = 503) => ({ status, body: { error } });
const uuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const emptyHistory = (status: 'missing' | 'unavailable' = 'unavailable') => ({
  status,
  revision: null,
  records: [],
  omitted: 0,
});

/** Fixed scope and runtime only. Browser requests carry opaque revisions and explicit opt-in. */
export async function createInventoryMonitorControl(configuration: Record<string, any> = {}) {
  const original = configuration.context ?? (await createWorkspaceReviewContext(configuration));
  const context = {
    ...original,
    async current() {
      return {
        ...(await original.current()),
        sourceProfileSha256: inventorySourceProfileSha256(
          original.roots.user.path,
          configuration.mcpEnvironment ?? {},
          configuration.platform ?? process.platform,
        ),
      };
    },
    async assert(bound: MonitorBound) {
      if (!isDeepStrictEqual(bound, await context.current())) throw new Error('stale-capture');
    },
  };
  const unavailable = async () => {
    throw new Error('context-unavailable');
  };
  const store =
    configuration.store ??
    (context.roots
      ? createInventoryMonitorStore({
          home: context.options.home,
          roots: context.roots,
          storeId: context.storeId,
          workspaceId: context.workspaceId,
        })
      : {
          context: unavailable,
          readIntent: unavailable,
          updateIntent: unavailable,
          acquireLease: unavailable,
          readObservations: unavailable,
          appendObservation: unavailable,
        });
  const scheduler =
    configuration.scheduler ??
    createInventoryMonitorService({
      ...configuration,
      inventory: configuration.inventory,
      context,
      store,
    });
  const now = configuration.now ?? Date.now;
  const previews = new Map<
    string,
    { plan: InventoryMonitorPreview; bound: MonitorBound; expires: number }
  >();
  let stopped = false;
  const stamp = () => new Date(now()).toISOString();
  const guardContext = () =>
    assertInventoryMonitorContext({ home: context.options.home, roots: context.roots });
  async function state() {
    let value: InventoryMonitorState = { ...scheduler.getState(), history: emptyHistory() };
    try {
      const snapshot = await store.readIntent();
      value = {
        ...value,
        revision: snapshot?.revision ?? null,
        configuredAt: snapshot?.record.configuredAt ?? null,
      };
      if (value.revision !== scheduler.getState().revision || !snapshot?.record.enabled)
        value = {
          ...value,
          status: snapshot?.record.enabled ? 'needs-review' : 'disabled',
          reason: snapshot?.record.enabled ? 'monitor-store-stale' : null,
          nextCheckAt: null,
        };
      try {
        const bound = await context.current();
        value.runtimeSha256 = bound.runtimeSha256;
        if (
          snapshot?.record.enabled &&
          (snapshot.record.engineVersion !== bound.engineVersion ||
            snapshot.record.runtimeSha256 !== bound.runtimeSha256 ||
            snapshot.record.sourceProfileSha256 !== bound.sourceProfileSha256)
        )
          value = { ...value, status: 'needs-review', reason: 'stale-capture', nextCheckAt: null };
        if (snapshot?.record.enabled) await guardContext();
      } catch (error) {
        value = {
          ...value,
          status: snapshot?.record.enabled ? 'needs-review' : snapshot ? 'disabled' : 'unavailable',
          reason: inventoryMonitorError(error),
          runtimeSha256: null,
          nextCheckAt: null,
        };
      }
      const history = await store.readObservations();
      value = {
        ...value,
        history: {
          status: history.status,
          revision: history.revision,
          records: history.records,
          omitted: history.omitted,
        },
        latestCheckId: history.latestCheckId,
        latestCaptureId: history.latestCaptureId,
      };
      if (history.status === 'unavailable')
        value = {
          ...value,
          status: 'unavailable',
          reason: 'observation-store-unavailable',
          nextCheckAt: null,
        };
      const after = await store.readIntent();
      if ((after?.revision ?? null) !== (snapshot?.revision ?? null))
        throw new Error('monitor-store-stale');
    } catch (error) {
      value = {
        ...value,
        status: 'unavailable',
        reason: inventoryMonitorError(error),
        runtimeSha256: null,
        nextCheckAt: null,
        latestCheckId: null,
        latestCaptureId: null,
        history: emptyHistory(),
      };
    }
    if (stopped)
      value = { ...value, status: 'stopped', reason: 'server-stopped', nextCheckAt: null };
    while (
      value.history.records.length > 1 &&
      Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024
    )
      value = {
        ...value,
        history: {
          ...value.history,
          records: value.history.records.slice(0, -1),
          omitted: value.history.omitted + 1,
        },
      };
    if (
      !validateInventoryMonitorState(value) ||
      Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024
    )
      value = {
        schema: 'stroq-inventory-monitor/1',
        workspaceId: context.workspaceId,
        status: stopped ? 'stopped' : 'unavailable',
        reason: stopped ? 'server-stopped' : 'observation-store-unavailable',
        revision: hash(value.revision) && validStamp(value.configuredAt) ? value.revision : null,
        configuredAt:
          hash(value.revision) && validStamp(value.configuredAt) ? value.configuredAt : null,
        runtimeSha256: null,
        intervalMs: 300000,
        nextCheckAt: null,
        lastAttempt: null,
        latestCheckId: null,
        latestCaptureId: null,
        history: emptyHistory(),
      };
    return { status: 200, body: value };
  }
  async function preview(input: unknown) {
    if (stopped) return fail('server-stopped');
    if (
      !exact(input, ['action', 'expectedRevision']) ||
      !['enable', 'pause'].includes(String(input.action)) ||
      !(input.expectedRevision === null || hash(input.expectedRevision))
    )
      return fail('invalid-request', 400);
    try {
      const snapshot = await store.readIntent();
      let bound: MonitorBound;
      if (input.action === 'enable') {
        await guardContext();
        bound = await context.current();
        if ((await store.readObservations()).status === 'unavailable')
          throw new Error('observation-store-unavailable');
      } else {
        if (!snapshot) return fail('monitor-store-stale', 409);
        try {
          bound = await context.current();
        } catch {
          bound = {
            engineVersion: snapshot.record.engineVersion,
            runtimeSha256: snapshot.record.runtimeSha256,
            sourceProfileSha256: snapshot.record.sourceProfileSha256,
          };
        }
      }
      if (
        (snapshot?.revision ?? null) !== input.expectedRevision ||
        ((await store.readIntent())?.revision ?? null) !== input.expectedRevision
      )
        return fail('monitor-store-stale', 409);
      if (stopped) return fail('server-stopped');
      const created = now();
      for (const [id, entry] of previews) if (entry.expires <= created) previews.delete(id);
      while (previews.size >= 32) previews.delete(previews.keys().next().value!);
      const plan: InventoryMonitorPreview = {
        schema: 'stroq-inventory-monitor-preview/1',
        id: randomUUID(),
        createdAt: new Date(created).toISOString(),
        expiresAt: new Date(created + 120000).toISOString(),
        workspaceId: context.workspaceId,
        action: input.action as 'enable' | 'pause',
        expectedRevision: input.expectedRevision,
        runtimeSha256: bound.runtimeSha256,
        intervalMs: 300000,
        hostEnforcement: false,
      };
      previews.set(plan.id, { plan, bound, expires: created + 120000 });
      return { status: 200, body: structuredClone(plan) };
    } catch (error) {
      return fail(inventoryMonitorError(error));
    }
  }
  async function apply(input: unknown) {
    if (stopped) return fail('server-stopped');
    if (
      !exact(input, [
        'previewId',
        'confirm',
        'acknowledgeLocalChecks',
        'acknowledgeUserSources',
        'acknowledgeRetention',
      ]) ||
      !uuid(input.previewId) ||
      input.confirm !== true ||
      ['acknowledgeLocalChecks', 'acknowledgeUserSources', 'acknowledgeRetention'].some(
        (key) => typeof input[key] !== 'boolean',
      )
    )
      return fail('invalid-request', 400);
    const entry = previews.get(input.previewId);
    if (!entry || entry.expires <= now()) {
      previews.delete(input.previewId);
      return fail('monitor-preview-expired', 409);
    }
    const enabled = entry.plan.action === 'enable';
    if (
      ['acknowledgeLocalChecks', 'acknowledgeUserSources', 'acknowledgeRetention'].some(
        (key) => input[key] !== enabled,
      )
    )
      return fail('invalid-request', 400);
    previews.delete(input.previewId);
    try {
      const beforeCommit = async () => {
        if (stopped) throw new Error('server-stopped');
        if (now() >= entry.expires) throw new Error('monitor-preview-expired');
        if (enabled) {
          await guardContext();
          if ((await store.readObservations()).status === 'unavailable')
            throw new Error('observation-store-unavailable');
        }
        if (now() >= entry.expires) throw new Error('monitor-preview-expired');
      };
      if (enabled && !isDeepStrictEqual(entry.bound, await context.current()))
        return fail('stale-capture', 409);
      await beforeCommit();
      const reply = await scheduler[entry.plan.action]({
        expectedRevision: entry.plan.expectedRevision,
        beforeCommit,
        ...(enabled ? { expectedBound: entry.bound } : {}),
      });
      if (reply.status !== 200) return reply;
      return {
        status: 200,
        body: {
          schema: 'stroq-inventory-monitor-receipt/1',
          previewId: entry.plan.id,
          workspaceId: context.workspaceId,
          action: entry.plan.action,
          completedAt: stamp(),
          revision: reply.body.revision,
          runtimeSha256: entry.plan.runtimeSha256,
          enabled,
          hostEnforcement: false,
        },
      };
    } catch (error) {
      const code = (error as Error)?.message;
      return fail(
        code === 'monitor-preview-expired' ? code : inventoryMonitorError(error),
        code === 'monitor-preview-expired' || code === 'stale-capture' ? 409 : 503,
      );
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
