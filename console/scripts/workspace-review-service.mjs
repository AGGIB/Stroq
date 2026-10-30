import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createRunStore, MAX_HISTORY_BYTES } from './run-store.mjs';
import { withAgentConfigurationLock } from './agent-configuration-lock.mjs';
import {
  closedWorkspaceInput as closed,
  createWorkspaceReviewContext,
  workspaceReviewError as codeOf,
  workspaceReviewStatus as statusOf,
} from './workspace-review-context.mjs';

const SHA = /^[a-f0-9]{64}$/,
  UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const copy = (v) => structuredClone(v),
  fail = (status, error) => ({ status, body: { error } });
const invalidBaseline = () => ({
  status: 'invalid',
  revision: null,
  reviewedAt: null,
  capture: null,
});

/** Explicit checks execute only the fixed static worker. Review records metadata, never trust. */
export async function createWorkspaceReviewService(configuration = {}) {
  const ctx = await createWorkspaceReviewContext(configuration);
  const { options, workspaceId, storeId, validate, now } = ctx;
  const loadValidator = async () => ({
    validateRun: (run) => validate('Run', run) && run.workspaceId === workspaceId,
    parseHistory: (text) => {
      const parsed = ctx.schema?.parseWorkspaceReviewHistoryJson?.(text);
      if (parsed?.ok !== true) throw new Error('invalid-history');
      return parsed.value;
    },
  });
  let store = await createRunStore({
    home: options.home,
    workspaceId: storeId,
    namespace: 'workspace-review',
    loadValidator,
  });
  // A retained running row may belong to another live console. Without process
  // attribution it cannot be truthfully turned into a failed historical attempt.
  const jobs = new Map(
    store.runs.filter((run) => run.status !== 'running').map((run) => [run.id, run]),
  );
  const ownedJobs = new Set();
  const lock = options.withLock ?? withAgentConfigurationLock,
    pending = new Set(),
    controllers = new Set();
  let active = null,
    busy = false,
    stopped = false,
    historyError = null;
  const ordered = () => [...jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const history = () => historyError ?? store.state();
  function boundedRows(candidate, protectedId) {
    let rows = [...candidate.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    while (rows.length > 32 || Buffer.byteLength(JSON.stringify(rows)) > MAX_HISTORY_BYTES - 4096) {
      const last = [...rows]
        .reverse()
        .find((row) => row.id !== protectedId && row.status !== 'running');
      if (!last) throw new Error('output-limit');
      rows = rows.filter((row) => row.id !== last.id);
    }
    return rows;
  }
  function rowsWith(run) {
    const candidate = new Map(jobs);
    candidate.set(run.id, run);
    return boundedRows(candidate, run.id);
  }
  function mergeRows(fresh, local, protectedId) {
    const candidate = new Map(
      fresh.filter((run) => run.status !== 'running').map((run) => [run.id, run]),
    );
    for (const run of local) if (ownedJobs.has(run.id)) candidate.set(run.id, run);
    return boundedRows(candidate, protectedId);
  }
  const readStore = () =>
    createRunStore({
      home: options.home,
      workspaceId: storeId,
      namespace: 'workspace-review',
      loadValidator,
    });
  function publish(rows) {
    jobs.clear();
    for (const row of rows) jobs.set(row.id, row);
    for (const id of ownedJobs) if (!jobs.has(id)) ownedJobs.delete(id);
  }
  function retain(run) {
    publish(rowsWith(run));
  }
  async function locked(bound, action) {
    return lock(
      { home: options.home, version: bound.engineVersion, runtime: bound.runtimeSha256 },
      action,
      { timeoutMs: 3000 },
    );
  }
  async function persist(bound, rows = ordered(), protectedId = active?.id) {
    return locked(bound, async () => {
      await ctx.assert(bound);
      const fresh = await readStore();
      if (fresh.state().status !== 'ready') throw new Error('history-unavailable');
      const merged = mergeRows(fresh.runs, rows, protectedId);
      if (!(await fresh.write(merged))) throw new Error('history-unavailable');
      store = fresh;
      return merged;
    });
  }
  function track(promise) {
    pending.add(promise);
    promise.finally(() => pending.delete(promise)).catch(() => undefined);
    return promise;
  }
  function worker(operation, input, bound, extra = {}) {
    const controller = extra.controller ?? new AbortController();
    controllers.add(controller);
    if (stopped) controller.abort();
    return ctx
      .run(operation, input, bound, { ...extra, signal: controller.signal })
      .finally(() => controllers.delete(controller));
  }
  async function getState() {
    let bound = null,
      baseline = invalidBaseline();
    try {
      bound = await ctx.current();
    } catch {
      /* Historical reports remain readable without current execution authority. */
    }
    if (bound && !stopped) {
      try {
        baseline = await worker('baseline', {}, bound);
        await ctx.assert(bound);
        if (
          !validate('Baseline', baseline) ||
          (baseline.capture && baseline.capture.workspaceId !== workspaceId)
        )
          throw new Error();
      } catch {
        baseline = invalidBaseline();
      }
    }
    // Re-read storage to expose malformed/replaced history without accepting it as empty.
    const fresh = await readStore();
    if (fresh.state().status !== 'ready') historyError = fresh.state();
    else {
      store = fresh;
      publish(mergeRows(fresh.runs, ordered(), active?.id));
    }
    const body = {
      schema: 'stroq-workspace-review/1',
      workspaceId,
      engine: {
        available: bound !== null && !stopped,
        version: bound && !stopped ? bound.engineVersion : null,
      },
      history: history(),
      baseline,
      runs: ordered(),
    };
    if (!validate('State', body)) throw new Error('runtime-unavailable');
    return copy(body);
  }
  async function launchCheck(run, bound, controller, monitor) {
    const extra = { controller, at: Date.parse(run.startedAt) };
    if (!monitor) return worker('check', {}, bound, extra);
    const launched = await locked(bound, async () => {
      await ctx.assert(bound);
      await monitor.beforeStart();
      await ctx.assert(bound);
      if (controller.signal.aborted) throw new Error('cancelled');
      let admit;
      const admission = new Promise((resolve) => {
        admit = resolve;
      });
      const task = worker('check', {}, bound, { ...extra, onStart: admit });
      // The configuration lock protects admission only, never the full static check.
      await Promise.race([
        admission,
        task.then(
          () => undefined,
          () => undefined,
        ),
      ]);
      return { task };
    });
    return launched.task;
  }
  async function finishCheck(run, bound, controller, monitor = null) {
    let terminal;
    try {
      const result = await launchCheck(run, bound, controller, monitor);
      await ctx.assert(bound);
      if (
        !validate('Result', result) ||
        result.capture.workspaceId !== workspaceId ||
        result.capture.profile.engineVersion !== bound.engineVersion ||
        result.capture.profile.runtimeSha256 !== bound.runtimeSha256
      )
        throw new Error('invalid-report');
      terminal = {
        ...run,
        status: 'completed',
        finishedAt: new Date(Math.max(now(), Date.parse(run.startedAt))).toISOString(),
        result,
      };
    } catch (error) {
      terminal = {
        ...run,
        status: stopped ? 'failed' : controller.signal.aborted ? 'cancelled' : 'failed',
        finishedAt: new Date(Math.max(now(), Date.parse(run.startedAt))).toISOString(),
        error: stopped ? 'server-stopped' : controller.signal.aborted ? 'cancelled' : codeOf(error),
      };
    }
    if (!validate('Run', terminal))
      terminal = {
        ...run,
        status: 'failed',
        finishedAt: new Date(Math.max(now(), Date.parse(run.startedAt))).toISOString(),
        error: 'invalid-report',
      };
    let rows = rowsWith(terminal);
    try {
      rows = await persist(bound, rows, run.id);
    } catch {
      historyError = { status: 'error', error: 'write-failed' };
    }
    // Publish the terminal result and its idle state together, after durable finalization.
    if (active?.id === run.id) {
      publish(rows);
      active = null;
    }
    return copy(terminal);
  }
  async function check(input, monitor = null) {
    if (!closed(input, [])) return fail(400, 'invalid-request');
    if (stopped) return fail(503, 'server-stopped');
    if (busy || active) return fail(409, 'workspace-review-busy');
    if (history().status !== 'ready') return fail(503, 'history-unavailable');
    busy = true;
    try {
      const bound = await ctx.current();
      if (monitor && !isDeepStrictEqual(bound, monitor.expectedBound))
        throw new Error('stale-capture');
      const run = {
        schema: 'stroq-workspace-review-run/1',
        id: randomUUID(),
        workspaceId,
        status: 'running',
        startedAt: new Date(now()).toISOString(),
      };
      ownedJobs.add(run.id);
      retain(run);
      try {
        publish(await persist(bound, ordered(), run.id));
      } catch (error) {
        jobs.delete(run.id);
        ownedJobs.delete(run.id);
        throw error;
      }
      const controller = new AbortController();
      active = { id: run.id, controller, task: null };
      active.task = track(finishCheck(run, bound, controller, monitor));
      return { status: 202, body: copy(run) };
    } catch (error) {
      const code = codeOf(error);
      return fail(statusOf(code), code);
    } finally {
      busy = false;
    }
  }
  async function cancel(input) {
    if (!closed(input, ['id']) || typeof input.id !== 'string' || !UUID.test(input.id))
      return fail(400, 'invalid-request');
    const run = jobs.get(input.id);
    if (!run) return fail(409, 'stale-capture');
    if (active?.id === input.id) {
      active.controller.abort();
      await active.task;
    }
    return { status: 200, body: copy(jobs.get(input.id)) };
  }
  async function review(input) {
    if (
      !closed(input, [
        'runId',
        'expectedCaptureSha256',
        'expectedReviewedRevision',
        'acknowledgeReviewOnly',
      ]) ||
      typeof input.runId !== 'string' ||
      !UUID.test(input.runId) ||
      typeof input.expectedCaptureSha256 !== 'string' ||
      !SHA.test(input.expectedCaptureSha256) ||
      !(
        input.expectedReviewedRevision === null ||
        (typeof input.expectedReviewedRevision === 'string' &&
          SHA.test(input.expectedReviewedRevision))
      ) ||
      input.acknowledgeReviewOnly !== true
    )
      return fail(400, 'invalid-request');
    if (stopped) return fail(503, 'server-stopped');
    if (busy || active) return fail(409, 'workspace-review-busy');
    if (history().status !== 'ready') return fail(503, 'history-unavailable');
    const run = jobs.get(input.runId);
    if (
      run?.status !== 'completed' ||
      run.result.capture.captureSha256 !== input.expectedCaptureSha256
    )
      return fail(409, 'stale-capture');
    if (!run.result.canReview) return fail(422, 'incomplete-capture');
    if (run.result.baseline.revision !== input.expectedReviewedRevision)
      return fail(409, 'stale-baseline');
    busy = true;
    let launched = false;
    try {
      const bound = await ctx.current();
      if (
        run.result.capture.profile.engineVersion !== bound.engineVersion ||
        run.result.capture.profile.runtimeSha256 !== bound.runtimeSha256
      )
        throw new Error('stale-capture');
      const body = await locked(bound, async () => {
        await ctx.assert(bound);
        const receipt = await worker(
          'review',
          {
            runId: run.id,
            capture: run.result.capture,
            expectedReviewedRevision: input.expectedReviewedRevision,
          },
          bound,
          {
            onStart: () => {
              launched = true;
            },
          },
        );
        if (
          !validate('Receipt', receipt) ||
          receipt.runId !== run.id ||
          receipt.workspaceId !== workspaceId ||
          receipt.captureSha256 !== input.expectedCaptureSha256
        )
          throw new Error('write-unconfirmed');
        await ctx.assert(bound, true);
        return receipt;
      });
      return { status: 200, body: copy(body) };
    } catch (error) {
      let code = codeOf(error);
      if (
        launched &&
        ![
          'stale-capture',
          'stale-baseline',
          'incomplete-capture',
          'baseline-unavailable',
          'write-unconfirmed',
        ].includes(code)
      )
        code = 'write-unconfirmed';
      return fail(statusOf(code), code);
    } finally {
      busy = false;
    }
  }
  return {
    // Internal scheduler observation avoids starting a baseline worker on every poll.
    getRun: (id) => copy(jobs.get(id) ?? null),
    // This private admission path shares the manual check's active-run guard.
    checkForMonitor: (expectedBound, beforeStart) =>
      track(check({}, { expectedBound: copy(expectedBound), beforeStart })),
    getState: () => track(getState()),
    check: (input) => track(check(input)),
    cancel: (input) => track(cancel(input)),
    review: (input) => track(review(input)),
    async close() {
      stopped = true;
      for (const controller of controllers) controller.abort();
      active?.controller.abort();
      while (pending.size) await Promise.allSettled([...pending]);
    },
  };
}
