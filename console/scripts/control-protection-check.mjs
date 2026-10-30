import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { withAgentConfigurationLock } from './agent-configuration-lock.mjs';
import { acquireProtectionCheckLease } from './workspace-monitor-bridge.mjs';
import {
  normalizeReport,
  protectionEvidence,
  protectionStamp as stamp,
  initialProtectionProgress as initialProgress,
  finishProtectionRun as finishParent,
} from './control-reports.mjs';
import { MAX_HISTORY_BYTES } from './run-store.mjs';

const FAILURES = new Set([
  'deadline-exceeded',
  'output-limit',
  'invalid-report',
  'engine-failed',
  'server-stopped',
  'cancelled',
  'context-changed',
  'prerequisite-failed',
  'history-unavailable',
  'workspace-review-busy',
  'policy-cases-unavailable',
  'interrupted',
  'ownership-lost',
]);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const sameContext = (before, after) =>
  ['workspaceId', 'policySha256', 'runtimeSha256'].every((key) => before[key] === after[key]);
const unbound = (workspaceId) => ({ workspaceId, policySha256: null, runtimeSha256: null });
const STEPS = ['doctor', 'policy-check', 'guard-test', 'saved-policy-checks', 'workspace-review'];
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const failureCode = (error) => (FAILURES.has(error?.message) ? error.message : 'engine-failed');
const clone = (value) => structuredClone(value);
function boundedRuns(rows, protectedId) {
  let ordered = [...rows].sort(
    (a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id),
  );
  while (
    ordered.length > 32 ||
    Buffer.byteLength(JSON.stringify(ordered)) > MAX_HISTORY_BYTES - 4096
  ) {
    const discard = ordered.findLast((run) => run.id !== protectedId && run.status !== 'running');
    if (!discard) throw new Error('history-unavailable');
    ordered = ordered.filter((run) => run.id !== discard.id);
  }
  return ordered;
}
function finishRun(run, error) {
  if (run.kind === 'protection-check') return finishParent(run, error);
  const { result, summary, ...captured } = run;
  return { ...captured, status: 'failed', finishedAt: stamp(run), error };
}

/** Server-owned offline checks. Only finite projections and exact evidence references persist. */
export function createProtectionCheckCoordinator({
  options,
  info,
  workspaceId,
  platformWorkspaceId,
  currentContext,
  readStore,
  setStore,
  getRuns,
  setRuns,
  execute,
  executeIndividual,
}) {
  let active = null,
    admission = null,
    pending = Promise.resolve(),
    closed = false,
    historyError = null;
  const owned = new Set();
  const lock = options.withLock ?? withAgentConfigurationLock;
  const acquireLease = options.acquireLease ?? acquireProtectionCheckLease;
  const retained = options.home !== undefined;
  const locked = (bound, action) =>
    lock(
      {
        home: options.home,
        version: info.version,
        runtime: bound.runtimeSha256 ?? 'stroq-control-unbound-runtime/1',
      },
      action,
      {
        timeoutMs: 3000,
      },
    );
  function publish(run) {
    setRuns(boundedRuns([run, ...getRuns().filter((row) => row.id !== run.id)], run.id));
  }
  async function assertOwned(lease) {
    if (!retained) return;
    try {
      await lease.assertCurrent();
    } catch {
      throw new Error('ownership-lost');
    }
  }
  async function assertBound(captured, lease, signal) {
    if (signal.aborted) throw new Error(closed ? 'server-stopped' : 'cancelled');
    await assertOwned(lease);
    const current = await currentContext(true);
    if (!sameContext(captured, current) || !current.policySha256 || !current.runtimeSha256)
      throw new Error('context-changed');
    if (signal.aborted) throw new Error(closed ? 'server-stopped' : 'cancelled');
  }
  async function persistRun(run, lease, bound, recover = false) {
    if (!retained) {
      publish(run);
      return;
    }
    try {
      const rows = await locked(bound, async () => {
        await assertOwned(lease);
        const fresh = await readStore();
        if (fresh.state().status !== 'ready') throw new Error('history-unavailable');
        let rows = fresh.runs;
        if (recover)
          rows = rows.map((row) =>
            row.status === 'running' ? finishRun(row, 'interrupted') : row,
          );
        if (rows.some((row) => row.status === 'running' && row.id !== run.id))
          throw new Error('busy');
        rows = boundedRuns([run, ...rows.filter((row) => row.id !== run.id)], run.id);
        if (!(await fresh.write(rows))) throw new Error('history-unavailable');
        const verified = await readStore();
        if (
          verified.state().status !== 'ready' ||
          JSON.stringify(verified.runs) !== JSON.stringify(rows)
        )
          throw new Error('history-unavailable');
        await assertOwned(lease);
        setStore(verified);
        return rows;
      });
      setRuns(rows);
      for (const id of owned) if (!rows.some((row) => row.id === id)) owned.delete(id);
    } catch (error) {
      if (!['busy', 'ownership-lost'].includes(error?.message))
        historyError = { status: 'error', error: 'write-failed' };
      throw new Error(
        ['busy', 'ownership-lost'].includes(error?.message) ? error.message : 'history-unavailable',
      );
    }
  }
  async function workspaceStage(job, signal) {
    const service = options.workspaceReview;
    if (!service?.check || !service?.getRun || !service?.cancel) throw new Error('engine-failed');
    const accepted = await service.check({});
    if (accepted?.status !== 202)
      throw new Error(
        accepted?.body?.error === 'workspace-review-busy'
          ? 'workspace-review-busy'
          : 'engine-failed',
      );
    const id = accepted.body?.id;
    if (
      !UUID.test(id) ||
      accepted.body.workspaceId !== platformWorkspaceId ||
      accepted.body.status !== 'running'
    )
      throw new Error('invalid-report');
    job.workspaceRunId = id;
    const deadline = Date.now() + 30_000;
    let cancellation = null,
      completed = false;
    try {
      for (;;) {
        if (signal.aborted || Date.now() >= deadline) {
          cancellation ??= service.cancel({ id });
          await cancellation;
          throw new Error(
            signal.aborted ? (closed ? 'server-stopped' : 'cancelled') : 'deadline-exceeded',
          );
        }
        const run = await service.getRun(id);
        if (!run || run.id !== id || run.workspaceId !== platformWorkspaceId)
          throw new Error('invalid-report');
        if (run.status !== 'running') {
          if (run.status !== 'completed') throw new Error(failureCode(new Error(run.error)));
          const result = await protectionEvidence(
            'workspace-review',
            run,
            platformWorkspaceId,
            options.validateProtectionEvidence,
          );
          completed = true;
          return result;
        }
        await delay(50, undefined, { signal }).catch(() => undefined);
      }
    } finally {
      // Only the accepted owned ID is eligible for cancellation. A busy response
      // cannot confer ownership over a watch or another console's check.
      if (!completed && !cancellation) await service.cancel({ id });
      job.workspaceRunId = null;
    }
  }
  async function executeStage(id, job) {
    if (['doctor', 'policy-check', 'guard-test'].includes(id))
      return normalizeReport(
        id,
        await execute({ kind: id }, { ...options, signal: job.controller.signal }),
      );
    if (id === 'workspace-review') return workspaceStage(job, job.controller.signal);
    if (!options.policyCases?.read) throw new Error('policy-cases-unavailable');
    const reply = await options.policyCases.read({ signal: job.controller.signal });
    if (reply?.status !== 200) throw new Error('policy-cases-unavailable');
    const result = await protectionEvidence(
      id,
      reply.body,
      platformWorkspaceId,
      options.validateProtectionEvidence,
    );
    if (
      (result.policy.rawSha ?? sha256('stroq-bundled-default-policy/1')) !== job.bound.policySha256
    )
      throw new Error('context-changed');
    return result;
  }
  async function runParent(run, job) {
    let current = run,
      reason = null;
    const stepChange = (index, values) => {
      current = {
        ...current,
        progress: {
          steps: current.progress.steps.map((step, at) =>
            at === index ? { ...step, ...values } : step,
          ),
        },
      };
    };
    try {
      for (const [index, id] of STEPS.entries()) {
        await assertBound(run.provenance, job.lease, job.controller.signal);
        if (
          ['guard-test', 'saved-policy-checks'].includes(id) &&
          current.progress.steps[1].result?.loaded !== true
        ) {
          stepChange(index, {
            status: 'skipped',
            finishedAt: stamp(current),
            error: 'prerequisite-failed',
          });
          await persistRun(current, job.lease, run.provenance);
          continue;
        }
        stepChange(index, { status: 'running', startedAt: stamp(current) });
        await persistRun(current, job.lease, run.provenance);
        await assertBound(run.provenance, job.lease, job.controller.signal);
        try {
          const result = await executeStage(id, job);
          if (job.controller.signal.aborted)
            throw new Error(closed ? 'server-stopped' : 'cancelled');
          const finishedAt = stamp(current),
            capturedAt = result.generatedAt ?? result.capturedAt;
          if (
            capturedAt &&
            (capturedAt < current.progress.steps[index].startedAt || capturedAt > finishedAt)
          )
            throw new Error('invalid-report');
          stepChange(index, { status: 'completed', finishedAt, result });
        } catch (error) {
          const code = job.controller.signal.aborted
            ? closed
              ? 'server-stopped'
              : 'cancelled'
            : failureCode(error);
          stepChange(index, { status: 'failed', finishedAt: stamp(current), error: code });
          if (
            [
              'cancelled',
              'server-stopped',
              'context-changed',
              'ownership-lost',
              'history-unavailable',
            ].includes(code)
          )
            throw new Error(code);
        }
        await assertBound(run.provenance, job.lease, job.controller.signal);
        await persistRun(current, job.lease, run.provenance);
      }
    } catch (error) {
      reason = failureCode(error);
    }
    if (reason === 'context-changed')
      current = { ...current, provenance: unbound(run.provenance.workspaceId) };
    current = finishParent(current, reason);
    try {
      await persistRun(current, job.lease, run.provenance);
    } catch (error) {
      current = finishParent(current, failureCode(error));
      publish(current);
    }
    await releaseJob(current, job);
  }
  async function releaseJob(current, job) {
    try {
      await job.lease?.release();
    } catch {
      historyError = { status: 'error', error: 'write-failed' };
      publish(finishRun(current, 'ownership-lost'));
    }
    if (active === job) active = null;
  }
  async function runIndividual(run, job, input) {
    let current = run;
    try {
      await assertOwned(job.lease);
      if (job.controller.signal.aborted) throw new Error('server-stopped');
      current = await executeIndividual(input, run, job.controller.signal);
      await assertOwned(job.lease);
      await persistRun(current, job.lease, job.bound);
    } catch (error) {
      current = finishRun(current, failureCode(error));
      // Ownership or persistence failure cannot authorize another write or a
      // successful in-memory receipt. Keep this explicit failure observable.
      publish(current);
    }
    await releaseJob(current, job);
  }
  async function startRun(input) {
    let lease;
    try {
      const bound = await currentContext(true);
      if (
        bound.workspaceId !== workspaceId ||
        (input.kind === 'protection-check' &&
          (!platformWorkspaceId || !bound.policySha256 || !bound.runtimeSha256))
      )
        throw new Error('context-changed');
      if (retained)
        await locked(bound, async () => {
          const fresh = await readStore();
          if (fresh.state().status !== 'ready') throw new Error('history-unavailable');
          // Explicit admission may prepare private lease parents; it never rewrites
          // a foreign report merely to find out whether its owner is still active.
          if (fresh.prepare && !(await fresh.prepare())) throw new Error('history-unavailable');
          setStore(fresh);
        });
      lease = retained
        ? await acquireLease({
            home: options.home,
            storeId: sha256(`stroq-protection-check/1\0${workspaceId}`),
          })
        : null;
      if (retained && !lease) {
        return { status: 409, body: { error: 'busy' } };
      }
      if (closed) throw new Error('server-stopped');
      const controller = new AbortController();
      if (input.kind === 'protection-check') await assertBound(bound, lease, controller.signal);
      else await assertOwned(lease);
      const run = {
        id: randomUUID(),
        kind: input.kind,
        status: 'running',
        startedAt: new Date().toISOString(),
        provenance: clone(bound),
        ...(input.kind === 'protection-check' ? { progress: initialProgress() } : {}),
      };
      await persistRun(run, lease, bound, true);
      const job = { id: run.id, controller, lease, bound, workspaceRunId: null };
      owned.add(run.id);
      active = job;
      pending = Promise.resolve().then(() =>
        input.kind === 'protection-check' ? runParent(run, job) : runIndividual(run, job, input),
      );
      return { status: 202, body: clone(run) };
    } catch (error) {
      if (lease) await lease.release().catch(() => undefined);
      const code = ['busy', 'context-changed', 'server-stopped'].includes(error?.message)
        ? error.message
        : 'history-unavailable';
      return { status: code === 'busy' ? 409 : 503, body: { error: code } };
    }
  }
  return {
    busy: () => active !== null || admission !== null,
    historyError: () => historyError,
    activeRunId: () =>
      active &&
      getRuns().some(
        (run) =>
          run.id === active.id && run.kind === 'protection-check' && run.status === 'running',
      )
        ? active.id
        : null,
    activeControlRunId: () =>
      active && getRuns().some((run) => run.id === active.id && run.status === 'running')
        ? active.id
        : null,
    async observe() {
      if (!retained) return;
      const before = getRuns();
      const fresh = await readStore();
      // A local publication during the read is newer than this observation.
      if (getRuns() !== before) return;
      if (fresh.state().status !== 'ready') {
        setStore(fresh);
        return;
      }
      const rows = new Map(fresh.runs.map((run) => [run.id, run]));
      for (const run of getRuns()) if (owned.has(run.id)) rows.set(run.id, run);
      setRuns(boundedRuns([...rows.values()], active?.id));
      setStore(fresh);
      for (const id of owned) if (!getRuns().some((run) => run.id === id)) owned.delete(id);
    },
    start(input = { kind: 'protection-check' }) {
      if (closed) return { status: 503, body: { error: 'server-stopped' } };
      if (active || admission) return { status: 409, body: { error: 'busy' } };
      if (historyError) return { status: 503, body: { error: 'history-unavailable' } };
      admission = startRun(input);
      return admission.finally(() => {
        admission = null;
      });
    },
    idle: () => (admission ? admission.then(() => pending) : pending),
    async cancel(input) {
      if (
        !input ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        Object.keys(input).length !== 1 ||
        !UUID.test(input.id)
      )
        return { status: 400, body: { error: 'invalid-request' } };
      const run = getRuns().find((row) => row.id === input.id && row.kind === 'protection-check');
      if (!run) return { status: 404, body: { error: 'not-found' } };
      if (run.status === 'running' && active?.id !== run.id)
        return { status: 409, body: { error: 'busy' } };
      if (active?.id === run.id) {
        active.controller.abort();
        await pending;
      }
      return { status: 200, body: clone(getRuns().find((row) => row.id === run.id)) };
    },
    async close() {
      closed = true;
      active?.controller.abort();
      await admission?.catch(() => undefined);
      active?.controller.abort();
      await pending;
    },
  };
}
