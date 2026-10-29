import { isDeepStrictEqual } from 'node:util';
import { withAgentConfigurationLock } from './agent-configuration-lock.mjs';
import { closedWorkspaceInput as closed, WORKSPACE_ERRORS } from './workspace-review-context.mjs';

const INTERVAL_MS = 300000,
  POLL_MS = 1000,
  MAX_WAIT_MS = 35000;
const SHA = /^[a-f0-9]{64}$/,
  UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const STORE_ERRORS = new Set([
  'monitor-store-invalid',
  'monitor-store-unavailable',
  'monitor-store-stale',
  'monitor-store-limit',
  'monitor-store-write-unconfirmed',
]);
const clone = (value) => structuredClone(value);
const errorOf = (error) =>
  STORE_ERRORS.has(error?.message) ||
  WORKSPACE_ERRORS.has(error?.message) ||
  error?.message === 'monitor-preview-expired'
    ? error.message
    : error?.message === 'agent-configuration-busy'
      ? 'workspace-review-busy'
      : 'workspace-review-failed';
const failure = (error) => ({
  status:
    error === 'invalid-request'
      ? 400
      : [
            'monitor-store-stale',
            'workspace-review-busy',
            'stale-capture',
            'monitor-preview-expired',
          ].includes(error)
        ? 409
        : error === 'monitor-store-write-unconfirmed'
          ? 422
          : 503,
  body: { error },
});

/** Timed static observation is opt-in. Reads never start it and checks never accept a baseline. */
export function createWorkspaceMonitorService(configuration = {}) {
  const { context, store, workspaceReview: review } = configuration;
  if (!context || !store || !review) throw new TypeError('monitor-configuration-required');
  const now = configuration.now ?? Date.now,
    later = configuration.setTimeout ?? setTimeout,
    clear = configuration.clearTimeout ?? clearTimeout,
    lock = configuration.withLock ?? withAgentConfigurationLock;
  const pending = new Set();
  let status = 'disabled',
    revision = null,
    runtimeSha256 = null,
    reason = null,
    configuredAt = null,
    nextCheckAt = null,
    activeRunId = null,
    lastAttempt = null,
    scheduled = null,
    waiting = null,
    cycle = null,
    lease = null,
    started = false,
    stopped = false,
    generation = 0,
    control = Promise.resolve();
  const stamp = () => new Date(now()).toISOString();
  const live = (epoch) => !stopped && generation === epoch && status === 'enabled';
  const getState = () =>
    clone({
      schema: 'stroq-workspace-monitor/1',
      workspaceId: context.workspaceId,
      status,
      revision,
      runtimeSha256,
      reason,
      configuredAt,
      intervalMs: INTERVAL_MS,
      nextCheckAt,
      activeRunId,
      lastAttempt,
    });
  function track(promise) {
    pending.add(promise);
    promise.finally(() => pending.delete(promise)).catch(() => undefined);
    return promise;
  }
  function serialized(action) {
    const task = control.then(action, action);
    control = task.catch(() => undefined);
    return track(task);
  }
  function cancelTimer() {
    if (scheduled !== null) clear(scheduled);
    scheduled = null;
    nextCheckAt = null;
    if (waiting) {
      clear(waiting.timer);
      waiting.resolve();
      waiting = null;
    }
  }
  function delay() {
    return new Promise((resolve) => {
      const timer = later(() => {
        waiting = null;
        resolve();
      }, POLL_MS);
      timer?.unref?.();
      waiting = { timer, resolve };
    });
  }
  function schedule(epoch, milliseconds) {
    if (!live(epoch)) return;
    if (scheduled !== null) clear(scheduled);
    nextCheckAt = new Date(now() + milliseconds).toISOString();
    scheduled = later(() => {
      scheduled = null;
      nextCheckAt = null;
      if (!live(epoch)) return;
      cycle = track(runCycle(epoch));
      cycle
        .finally(() => {
          cycle = null;
        })
        .catch(() => undefined);
    }, milliseconds);
    scheduled?.unref?.();
  }
  function remember(snapshot) {
    revision = snapshot?.revision ?? null;
    configuredAt = snapshot?.record.configuredAt ?? null;
  }
  async function releaseLease() {
    const held = lease;
    lease = null;
    if (!held) return;
    try {
      await held.release();
    } catch (error) {
      if (!stopped) {
        status = 'unavailable';
        reason = errorOf(error);
      }
    }
  }
  async function acquireLease(epoch) {
    if (lease) return true;
    const acquired = await store.acquireLease();
    if (!live(epoch)) {
      await acquired?.release();
      return false;
    }
    if (!acquired) {
      status = 'in-use';
      reason = 'monitor-in-use';
      return false;
    }
    lease = acquired;
    return true;
  }
  async function matches(record, bound) {
    const current = await store.context();
    return (
      isDeepStrictEqual(
        {
          home: record.home,
          roots: record.roots,
          workspaceId: record.workspaceId,
          storeId: record.storeId,
        },
        current,
      ) &&
      record.engineVersion === bound.engineVersion &&
      record.runtimeSha256 === bound.runtimeSha256
    );
  }
  async function verify(epoch, expectedRevision) {
    try {
      const snapshot = await store.read();
      if (stopped || epoch !== generation) return false;
      const changed = expectedRevision !== undefined && snapshot?.revision !== expectedRevision;
      remember(snapshot);
      if (!snapshot || !snapshot.record.enabled) {
        status = 'disabled';
        reason = null;
        return false;
      }
      if (changed) {
        status = 'needs-review';
        reason = 'stale-capture';
        return false;
      }
      const bound = await context.current();
      runtimeSha256 = bound.runtimeSha256;
      const same = await matches(snapshot.record, bound);
      if (stopped || epoch !== generation) return false;
      status = same ? 'enabled' : 'needs-review';
      reason = same ? null : 'stale-capture';
      return same ? bound : false;
    } catch (error) {
      if (!stopped && epoch === generation) {
        runtimeSha256 = null;
        status = STORE_ERRORS.has(error?.message) ? 'unavailable' : 'needs-review';
        reason = errorOf(error);
      }
      return false;
    }
  }
  async function readRun(id) {
    if (typeof review.getRun === 'function') return review.getRun(id);
    const state = await review.getState();
    return state.runs.find((run) => run.id === id) ?? null;
  }
  function finishAttempt(run, fallback = null) {
    const terminal = ['completed', 'failed', 'cancelled'].includes(run?.status)
      ? run.status
      : 'failed';
    lastAttempt = {
      ...lastAttempt,
      status: terminal,
      finishedAt: run?.finishedAt ?? stamp(),
      error:
        terminal === 'completed'
          ? null
          : WORKSPACE_ERRORS.has(run?.error)
            ? run.error
            : (fallback ?? 'invalid-report'),
    };
    if (
      status === 'enabled' &&
      [
        'stale-capture',
        'runtime-unavailable',
        'context-unavailable',
        'platform-unsupported',
      ].includes(lastAttempt.error)
    )
      stopForError(lastAttempt.error);
  }
  function stopForError(code) {
    status = [
      'stale-capture',
      'context-unavailable',
      'runtime-unavailable',
      'platform-unsupported',
    ].includes(code)
      ? 'needs-review'
      : 'unavailable';
    reason = code;
  }
  async function observe(id, epoch) {
    const deadline = now() + MAX_WAIT_MS;
    let polls = 0;
    while (live(epoch) && now() < deadline && polls++ < MAX_WAIT_MS / POLL_MS) {
      const run = await readRun(id);
      if (run?.id !== id || !['running', 'completed', 'failed', 'cancelled'].includes(run.status))
        throw new Error('invalid-report');
      if (run.status !== 'running') {
        finishAttempt(run);
        return;
      }
      if (!live(epoch)) continue;
      await delay();
    }
    // Only an ID returned by this monitor's own check can reach cancellation.
    const cancelled = await review.cancel({ id });
    finishAttempt(cancelled?.body, now() >= deadline ? 'deadline-exceeded' : 'cancelled');
  }
  async function runCycle(epoch) {
    const expectedRevision = revision;
    const bound = await verify(epoch, expectedRevision);
    if (!bound || !live(epoch)) {
      await releaseLease();
      return;
    }
    lastAttempt = {
      status: 'running',
      startedAt: stamp(),
      finishedAt: null,
      runId: null,
      error: null,
    };
    try {
      await lease.assertCurrent();
      const reply = await review.checkForMonitor(bound, async () => {
        if (!live(epoch)) throw new Error('cancelled');
        if (!(await verify(epoch, expectedRevision))) throw new Error(reason ?? 'stale-capture');
        await lease.assertCurrent();
        await context.assert(bound);
        if (!live(epoch)) throw new Error('cancelled');
      });
      if (reply?.status !== 202) {
        const error = errorOf({ message: reply?.body?.error });
        lastAttempt = {
          ...lastAttempt,
          status: error === 'workspace-review-busy' ? 'skipped' : 'failed',
          finishedAt: stamp(),
          error,
        };
        if (error !== 'workspace-review-busy') stopForError(error);
        return;
      }
      const id = reply.body?.id;
      if (typeof id !== 'string' || !UUID.test(id)) throw new Error('invalid-report');
      activeRunId = id;
      lastAttempt = { ...lastAttempt, runId: id };
      if (!live(epoch)) {
        const cancelled = await review.cancel({ id });
        finishAttempt(cancelled?.body, 'cancelled');
      } else await observe(id, epoch);
    } catch (error) {
      if (live(epoch)) {
        const code = errorOf(error);
        stopForError(code);
      }
      if (activeRunId) {
        try {
          await review.cancel({ id: activeRunId });
        } catch {
          /* Shutdown still waits for this cycle. */
        }
      }
      finishAttempt(null, errorOf(error));
      activeRunId = null;
    } finally {
      activeRunId = null;
      if (live(epoch)) schedule(epoch, INTERVAL_MS);
      else await releaseLease();
    }
  }
  async function stopOwn() {
    cancelTimer();
    // Waking the observer makes the owning cycle cancel exactly its own accepted run.
    if (cycle) await cycle;
  }
  async function change(enabled, input) {
    if (stopped) return failure('server-stopped');
    let published = false;
    try {
      const bound = enabled ? await context.current() : null;
      if (enabled && input.expectedBound && !isDeepStrictEqual(bound, input.expectedBound))
        throw new Error('stale-capture');
      if (bound) runtimeSha256 = bound.runtimeSha256;
      const previous = enabled ? null : await store.read();
      const effective =
        bound ??
        (previous
          ? {
              engineVersion: previous.record.engineVersion,
              runtimeSha256: previous.record.runtimeSha256,
            }
          : await context.current());
      if (stopped) return failure('server-stopped');
      const storage = await store.context();
      const snapshot = await lock(
        { home: storage.home, version: effective.engineVersion, runtime: effective.runtimeSha256 },
        async () => {
          await input.beforeCommit?.();
          return store.update(
            effective,
            {
              enabled,
              expectedRevision: input.expectedRevision,
              configuredAt: stamp(),
            },
            {
              beforeCommit: async () => {
                if (stopped) throw new Error('server-stopped');
                await input.beforeCommit?.();
                if (enabled) await context.assert(effective);
                if (
                  enabled &&
                  input.expectedBound &&
                  !isDeepStrictEqual(effective, input.expectedBound)
                )
                  throw new Error('stale-capture');
                if (stopped) throw new Error('server-stopped');
              },
            },
          );
        },
        { timeoutMs: 3000 },
      );
      published = true;
      if (stopped) return failure('monitor-store-write-unconfirmed');
      // Persist the disabled intent before cancelling a timer or an owned worker.
      generation++;
      status = enabled ? 'enabled' : 'disabled';
      reason = null;
      remember(snapshot);
      await stopOwn();
      if (!stopped && enabled && (await acquireLease(generation))) schedule(generation, 0);
      else if (!enabled) await releaseLease();
      return { status: 200, body: getState() };
    } catch (error) {
      if (published && !stopped) {
        stopForError(errorOf(error));
        return failure('monitor-store-write-unconfirmed');
      }
      return failure(errorOf(error));
    }
  }
  function apply(enabled, input) {
    const hasBound = enabled && input && Object.hasOwn(input, 'expectedBound');
    const hasGuard = input && Object.hasOwn(input, 'beforeCommit');
    const keys = [
      'expectedRevision',
      ...(hasBound ? ['expectedBound'] : []),
      ...(hasGuard ? ['beforeCommit'] : []),
    ];
    if (
      !closed(input, keys) ||
      (hasGuard && typeof input.beforeCommit !== 'function') ||
      (hasBound &&
        (!closed(input.expectedBound, ['engineVersion', 'runtimeSha256']) ||
          typeof input.expectedBound.engineVersion !== 'string' ||
          !input.expectedBound.engineVersion.length ||
          input.expectedBound.engineVersion.length > 100 ||
          typeof input.expectedBound.runtimeSha256 !== 'string' ||
          !SHA.test(input.expectedBound.runtimeSha256))) ||
      !(
        input.expectedRevision === null ||
        (typeof input.expectedRevision === 'string' && SHA.test(input.expectedRevision))
      )
    )
      return Promise.resolve(failure('invalid-request'));
    const { beforeCommit, ...values } = input;
    const captured = { ...clone(values), ...(hasGuard ? { beforeCommit } : {}) };
    return serialized(() => change(enabled, captured));
  }
  return {
    getState,
    start: () =>
      serialized(async () => {
        if (started || stopped) return getState();
        started = true;
        const epoch = generation;
        if (await verify(epoch)) {
          try {
            if (await acquireLease(epoch)) schedule(epoch, 0);
          } catch (error) {
            status = 'unavailable';
            reason = errorOf(error);
          }
        }
        return getState();
      }),
    enable: (input) => apply(true, input),
    pause: (input) => apply(false, input),
    async close() {
      if (!stopped) {
        stopped = true;
        generation++;
        status = 'stopped';
        reason = 'server-stopped';
      }
      await stopOwn();
      while (pending.size) await Promise.allSettled([...pending]);
      await releaseLease();
    },
  };
}
