import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { validateInventory } from '../lib/inventory.ts';
import {
  INVENTORY_MONITOR_INTERVAL_MS,
  type InventoryMonitorError,
} from '../lib/inventory-monitor.ts';
import { closed, hash } from '../lib/local-guards.ts';
import { withAgentConfigurationLock } from './agent-configuration-lock.mjs';

import {
  inventoryMonitorError,
  inventoryMonitorFailure as failure,
  type MonitorBound,
  type Intent,
  type Lease,
  type Timer,
  type SchedulerState,
  type InventoryMonitorConfiguration,
} from './inventory-monitor-shared.ts';
export { inventoryMonitorError } from './inventory-monitor-shared.ts';
export type {
  MonitorBound,
  MonitorContext,
  MonitorStore,
  InventoryMonitorConfiguration,
} from './inventory-monitor-shared.ts';

/** An independent opt-in owns one lease and timer; it only observes the shared inventory reader. */
export function createInventoryMonitorService(configuration: InventoryMonitorConfiguration) {
  const { context, store, inventory } = configuration;
  if (!context || !store || typeof inventory?.read !== 'function')
    throw new TypeError('monitor-configuration-required');
  const now = configuration.now ?? Date.now,
    later = configuration.setTimeout ?? setTimeout;
  const clear = configuration.clearTimeout ?? clearTimeout,
    lock = configuration.withLock ?? withAgentConfigurationLock;
  let state: SchedulerState = {
    schema: 'stroq-inventory-monitor/1',
    workspaceId: context.workspaceId,
    status: 'disabled',
    reason: null,
    revision: null,
    configuredAt: null,
    runtimeSha256: null,
    intervalMs: INVENTORY_MONITOR_INTERVAL_MS,
    nextCheckAt: null,
    lastAttempt: null,
    latestCheckId: null,
    latestCaptureId: null,
  };
  let stopped = false,
    started = false,
    generation = 0,
    scheduled: Timer | null = null,
    lease: Lease | null = null,
    cycle: Promise<void> | null = null;
  let control: Promise<unknown> = Promise.resolve();
  const stamp = () => new Date(now()).toISOString();
  const live = (epoch: number) => !stopped && epoch === generation && state.status === 'enabled';
  const getState = () => structuredClone(state);
  const remember = (snapshot: Intent | null) => {
    state = {
      ...state,
      revision: snapshot?.revision ?? null,
      configuredAt: snapshot?.record.configuredAt ?? null,
    };
  };
  const setError = (error: InventoryMonitorError) => {
    state = {
      ...state,
      status: [
        'stale-capture',
        'context-unavailable',
        'runtime-unavailable',
        'platform-unsupported',
      ].includes(error)
        ? 'needs-review'
        : 'unavailable',
      reason: error,
      nextCheckAt: null,
    };
  };
  function cancelTimer() {
    if (scheduled !== null) clear(scheduled);
    scheduled = null;
    state = { ...state, nextCheckAt: null };
  }
  async function releaseLease() {
    const held = lease;
    lease = null;
    try {
      await held?.release();
    } catch (error) {
      if (!stopped) setError(inventoryMonitorError(error));
    }
  }
  async function acquireLease(epoch: number) {
    if (lease) return true;
    const held = await store.acquireLease();
    if (!live(epoch)) {
      await held?.release();
      return false;
    }
    if (!held) {
      state = { ...state, status: 'in-use', reason: 'monitor-in-use' };
      return false;
    }
    lease = held;
    return true;
  }
  async function verify(
    epoch: number,
    expectedRevision?: string | null,
  ): Promise<MonitorBound | null> {
    try {
      const snapshot = await store.readIntent();
      if (stopped || epoch !== generation) return null;
      remember(snapshot);
      if (!snapshot?.record.enabled) {
        state = { ...state, status: 'disabled', reason: null, nextCheckAt: null };
        return null;
      }
      if (expectedRevision !== undefined && snapshot.revision !== expectedRevision) {
        setError('stale-capture');
        return null;
      }
      const bound = await context.current(),
        binding = await store.context();
      if (stopped || epoch !== generation) return null;
      state = { ...state, runtimeSha256: bound.runtimeSha256 };
      const record = snapshot.record;
      if (
        !isDeepStrictEqual(
          {
            home: record.home,
            roots: record.roots,
            workspaceId: record.workspaceId,
            storeId: record.storeId,
          },
          binding,
        ) ||
        record.engineVersion !== bound.engineVersion ||
        record.runtimeSha256 !== bound.runtimeSha256 ||
        record.sourceProfileSha256 !== bound.sourceProfileSha256
      ) {
        setError('stale-capture');
        return null;
      }
      state = { ...state, status: 'enabled', reason: null };
      return bound;
    } catch (error) {
      if (!stopped && epoch === generation) setError(inventoryMonitorError(error));
      return null;
    }
  }
  function schedule(epoch: number, milliseconds: number) {
    if (!live(epoch)) return;
    cancelTimer();
    state = { ...state, nextCheckAt: new Date(now() + milliseconds).toISOString() };
    scheduled = later(() => {
      scheduled = null;
      state = { ...state, nextCheckAt: null };
      if (!live(epoch)) return;
      const running = runCycle(epoch);
      cycle = running;
      running
        .finally(() => {
          if (cycle === running) cycle = null;
        })
        .catch(() => undefined);
    }, milliseconds);
    if (typeof scheduled === 'object') scheduled.unref?.();
  }
  async function runCycle(epoch: number) {
    const revision = state.revision,
      bound = await verify(epoch, revision);
    if (!bound || !live(epoch) || !revision) {
      await releaseLease();
      return;
    }
    const checkId = randomUUID();
    state = {
      ...state,
      lastAttempt: {
        status: 'running',
        startedAt: stamp(),
        finishedAt: null,
        error: null,
        checkId,
        captureId: null,
      },
    };
    try {
      const held = lease;
      if (!held) throw new Error('monitor-in-use');
      await held.assertCurrent();
      if (!live(epoch)) return;
      const reply = await inventory.read();
      if (!live(epoch)) return;
      if (reply.status !== 200)
        throw new Error((reply.body as { error?: string })?.error ?? 'inventory-unavailable');
      if (!validateInventory(reply.body) || reply.body.workspace.id !== context.workspaceId)
        throw new Error('inventory-unavailable');
      const snapshot = reply.body,
        storage = await store.context();
      const beforeCommit = async () => {
        if (!live(epoch)) throw new Error('cancelled');
        if (!(await verify(epoch, revision))) throw new Error(state.reason ?? 'cancelled');
        if (lease !== held) throw new Error('cancelled');
        await held.assertCurrent();
        await context.assert(bound);
        if (!live(epoch)) throw new Error('cancelled');
      };
      const captured = await lock(
        { home: storage.home, version: bound.engineVersion, runtime: bound.runtimeSha256 },
        async () => {
          await beforeCommit();
          return store.appendObservation(snapshot, bound, {
            expectedIntentRevision: revision,
            checkId,
            observedAt: stamp(),
            beforeCommit,
          });
        },
        { timeoutMs: 3000 },
      );
      if (state.lastAttempt?.checkId === checkId)
        state = {
          ...state,
          latestCheckId: captured.latestCheckId,
          latestCaptureId: captured.latestCaptureId,
          lastAttempt: {
            ...state.lastAttempt,
            status: 'completed',
            finishedAt: stamp(),
            error: null,
            captureId: captured.record.id,
          },
        };
    } catch (error) {
      const code = inventoryMonitorError(error);
      if (state.lastAttempt?.checkId === checkId)
        state = {
          ...state,
          lastAttempt: {
            ...state.lastAttempt,
            status:
              code === 'inventory-busy' || code === 'workspace-review-busy'
                ? 'skipped'
                : code === 'cancelled'
                  ? 'cancelled'
                  : 'failed',
            finishedAt: stamp(),
            error: code,
            captureId: null,
          },
        };
      if (
        live(epoch) &&
        !['inventory-busy', 'workspace-review-busy', 'inventory-unavailable'].includes(code)
      )
        setError(code);
    } finally {
      if (state.lastAttempt?.checkId === checkId && state.lastAttempt.status === 'running')
        state = {
          ...state,
          lastAttempt: {
            ...state.lastAttempt,
            status: 'cancelled',
            finishedAt: stamp(),
            error: 'cancelled',
            captureId: null,
          },
        };
      if (live(epoch)) schedule(epoch, INVENTORY_MONITOR_INTERVAL_MS);
      else await releaseLease();
    }
  }
  function serialized<T>(action: () => Promise<T>): Promise<T> {
    const pending = control.then(action, action);
    control = pending.catch(() => undefined);
    return pending;
  }
  async function stopOwn() {
    cancelTimer();
    await cycle;
  }
  async function change(
    enabled: boolean,
    input: {
      expectedRevision: string | null;
      expectedBound?: MonitorBound;
      beforeCommit?: () => Promise<void>;
    },
  ) {
    if (stopped) return failure('server-stopped');
    let published = false;
    try {
      const bound = enabled ? await context.current() : null;
      if (enabled && input.expectedBound && !isDeepStrictEqual(bound, input.expectedBound))
        throw new Error('stale-capture');
      const previous = enabled ? null : await store.readIntent();
      const effective =
        bound ??
        (previous
          ? {
              engineVersion: previous.record.engineVersion,
              runtimeSha256: previous.record.runtimeSha256,
              sourceProfileSha256: previous.record.sourceProfileSha256,
            }
          : await context.current());
      const binding = await store.context();
      const snapshot = await lock(
        { home: binding.home, version: effective.engineVersion, runtime: effective.runtimeSha256 },
        async () => {
          const beforeCommit = async () => {
            if (stopped) throw new Error('server-stopped');
            await input.beforeCommit?.();
            if (enabled) await context.assert(effective);
            if (stopped) throw new Error('server-stopped');
          };
          await beforeCommit();
          return store.updateIntent(
            effective,
            { enabled, expectedRevision: input.expectedRevision, configuredAt: stamp() },
            { beforeCommit },
          );
        },
        { timeoutMs: 3000 },
      );
      published = true;
      if (stopped) return failure('monitor-store-write-unconfirmed');
      generation++;
      remember(snapshot);
      state = {
        ...state,
        status: enabled ? 'enabled' : 'disabled',
        reason: null,
        runtimeSha256: effective.runtimeSha256,
      };
      await stopOwn();
      if (enabled && !stopped && (await acquireLease(generation))) schedule(generation, 0);
      else if (!enabled) await releaseLease();
      return { status: 200, body: getState() };
    } catch (error) {
      const code =
        (error as Error)?.message === 'monitor-preview-expired'
          ? 'monitor-preview-expired'
          : inventoryMonitorError(error);
      if (published && !stopped) setError(inventoryMonitorError(error));
      return failure(published ? 'monitor-store-write-unconfirmed' : code);
    }
  }
  function apply(enabled: boolean, input: unknown) {
    const hasBound =
      enabled &&
      input !== null &&
      typeof input === 'object' &&
      Object.hasOwn(input, 'expectedBound');
    const hasGuard =
      input !== null && typeof input === 'object' && Object.hasOwn(input, 'beforeCommit');
    if (
      !closed(input, [
        'expectedRevision',
        ...(hasBound ? ['expectedBound'] : []),
        ...(hasGuard ? ['beforeCommit'] : []),
      ]) ||
      !(input.expectedRevision === null || hash(input.expectedRevision)) ||
      (hasGuard && typeof input.beforeCommit !== 'function') ||
      (hasBound &&
        (!closed(input.expectedBound, ['engineVersion', 'runtimeSha256', 'sourceProfileSha256']) ||
          typeof input.expectedBound.engineVersion !== 'string' ||
          !input.expectedBound.engineVersion.length ||
          !hash(input.expectedBound.runtimeSha256) ||
          !hash(input.expectedBound.sourceProfileSha256)))
    )
      return Promise.resolve(failure('invalid-request'));
    const captured = {
      expectedRevision: input.expectedRevision,
      ...(hasBound ? { expectedBound: structuredClone(input.expectedBound) as MonitorBound } : {}),
      ...(hasGuard ? { beforeCommit: input.beforeCommit as () => Promise<void> } : {}),
    };
    return serialized(() => change(enabled, captured));
  }
  return {
    getState,
    start: () =>
      serialized(async () => {
        if (started || stopped) return getState();
        started = true;
        const epoch = generation;
        if (await verify(epoch))
          try {
            if (await acquireLease(epoch)) schedule(epoch, 0);
          } catch (error) {
            setError(inventoryMonitorError(error));
          }
        return getState();
      }),
    enable: (input: unknown) => apply(true, input),
    pause: (input: unknown) => apply(false, input),
    async close() {
      if (!stopped) {
        stopped = true;
        generation++;
        state = { ...state, status: 'stopped', reason: 'server-stopped', nextCheckAt: null };
      }
      await stopOwn();
      await control;
      await releaseLease();
    },
  };
}
