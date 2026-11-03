import { randomUUID } from 'node:crypto';
import { runtimeDigest } from './agent-setup-cli.mjs';
import { lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { ensureInventoryStore } from './inventory-safe.mjs';
import { runtimeLayout } from './runtime-layout.mjs';

const layout = runtimeLayout();
const REPOSITORY = layout.repository;
const WORKER = layout.adapter('inventory-worker.js');
const CORE = layout.core;
const runtimePaths = Object.freeze({
  cli: layout.cli,
  package: layout.package,
  manifest: layout.manifest,
  manifestRoot: layout.manifestRoot,
});
const loadSchema = () => import(pathToFileURL(layout.adapter('inventory-schema.js')).href);
const uuid = (value) =>
  typeof value === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const fields = (value, names) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...names].sort().join(',');
const validSignalPreview = (value) =>
  fields(value, ['id', 'expectedSha256', 'expectedDecisionId', 'decision', 'reason']) &&
  validInspect({ id: value.id, expectedSha256: value.expectedSha256 }) &&
  (value.expectedDecisionId === null || uuid(value.expectedDecisionId));
const invalid = () => ({ status: 400, body: { error: 'invalid-request' } });
const conflict = () => ({ status: 409, body: { error: 'signal-conflict' } });
const known = new Set([
  'inventory-unavailable',
  'baseline-invalid',
  'review-conflict',
  'review-incomplete',
  'inspect-conflict',
  'signal-conflict',
  'signal-incomplete',
  'signal-store-unavailable',
  'signal-store-full',
]);
const validReview = (value) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === 3 &&
  Object.keys(value).every((key) => ['itemId', 'sha256', 'expectedReviewedSha256'].includes(key)) &&
  typeof value.itemId === 'string' &&
  /^item-[a-f0-9]{24}$/.test(value.itemId) &&
  typeof value.sha256 === 'string' &&
  /^[a-f0-9]{64}$/.test(value.sha256) &&
  (value.expectedReviewedSha256 === null ||
    (typeof value.expectedReviewedSha256 === 'string' &&
      /^[a-f0-9]{64}$/.test(value.expectedReviewedSha256)));
const validInspect = (value) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === 'expectedSha256,id' &&
  typeof value.id === 'string' &&
  /^item-[a-f0-9]{24}$/.test(value.id) &&
  typeof value.expectedSha256 === 'string' &&
  /^[a-f0-9]{64}$/.test(value.expectedSha256);

const validCompare = (value) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === 'expectedReviewedSha256,expectedSha256,id' &&
  validInspect({ id: value.id, expectedSha256: value.expectedSha256 }) &&
  (value.expectedReviewedSha256 === null ||
    (typeof value.expectedReviewedSha256 === 'string' &&
      /^[a-f0-9]{64}$/.test(value.expectedReviewedSha256)));

export function createInventory({
  project = REPOSITORY,
  userHome = homedir(),
  home = process.env.STROQ_HOME ?? join(userHome, '.stroq'),
  workerPath = WORKER,
  timeoutMs = 25_000,
  mcpEnvironment = {},
} = {}) {
  let pending = null;
  let reviewing = false;
  let inspecting = false;
  let closed = false;
  let stop = null;
  const plans = new Map();
  const prune = () => {
    for (const [key, plan] of plans) if (plan.expiresAt <= Date.now()) plans.delete(key);
  };
  function exclusive(action) {
    if (pending || reviewing || inspecting)
      return Promise.resolve({ status: 409, body: { error: 'busy' } });
    inspecting = true;
    pending = Promise.resolve()
      .then(action)
      .finally(() => {
        pending = null;
        inspecting = false;
      });
    return pending;
  }
  async function run(operation, input = {}, deadline = Date.now() + timeoutMs) {
    let validate, runtimeSha256;
    try {
      const stat = await lstat(workerPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024)
        throw new Error();
      const schema = await loadSchema();
      runtimeSha256 = await runtimeDigest(runtimePaths);
      validate = operation.startsWith('signal-')
        ? schema.validateInventorySignalState
        : operation === 'inspect'
          ? schema.validateInventoryEvidence
          : operation === 'compare'
            ? schema.validateInventoryComparison
            : schema.validateInventory;
      if (typeof validate !== 'function') throw new Error();
    } catch {
      return { status: 503, body: { error: 'engine-unavailable' } };
    }
    if (closed) return { status: 503, body: { error: 'inventory-unavailable' } };
    if (Date.now() >= deadline) return { status: 503, body: { error: 'deadline-exceeded' } };
    return new Promise((resolveRun) => {
      const worker = new Worker(workerPath, {
        workerData: {
          operation,
          project,
          userHome,
          home,
          deadline,
          mcpEnvironment,
          ...input,
          runtimeSha256,
          runtimePaths,
        },
        env: {},
        execArgv: [],
        resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 },
        stdout: true,
        stderr: true,
      });
      let settled = false;
      let received = false;
      const finish = async (status, body) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        stop = null;
        // The caller may own the review lock. A worker must be stopped before
        // that lock is released, including on deadline, error and server close.
        await worker.terminate().catch(() => undefined);
        resolveRun({ status, body });
      };
      const timer = setTimeout(
        () => finish(503, { error: 'deadline-exceeded' }),
        Math.max(1, deadline - Date.now()),
      );
      stop = () => finish(503, { error: 'inventory-unavailable' });
      worker.stdout.resume();
      worker.stderr.resume();
      worker.once('message', async (value) => {
        received = true;
        if (known.has(value?.error))
          return finish(value.error === 'inventory-unavailable' ? 503 : 409, {
            error: value.error,
          });
        try {
          if (!validate(value) || JSON.stringify(value).length > 512 * 1024) throw new Error();
        } catch {
          return finish(503, { error: 'inventory-unavailable' });
        }
        try {
          // Bind accepted captures to the runtime that actually completed them.
          if ((await runtimeDigest(runtimePaths)) !== runtimeSha256) throw new Error();
        } catch {
          return finish(503, { error: 'engine-unavailable' });
        }
        finish(200, value);
      });
      worker.once('error', () => finish(503, { error: 'inventory-unavailable' }));
      worker.once('exit', () => {
        if (!received) finish(503, { error: 'inventory-unavailable' });
      });
    });
  }
  async function performReview(input) {
    const deadline = Date.now() + timeoutMs;
    // Preserve the first scan before creating the store, then rescan while
    // locked. Refresh never acquires a lock or creates anything on disk.
    const before = await run('read', {}, deadline);
    if (before.status !== 200) return before;
    if (before.body.baseline.status === 'invalid')
      return { status: 409, body: { error: 'baseline-invalid' } };
    const chosen = before.body.items.find((item) => item.id === input.itemId);
    if (
      !chosen ||
      chosen.sha256 !== input.sha256 ||
      chosen.reviewedSha256 !== input.expectedReviewedSha256
    )
      return { status: 409, body: { error: 'review-conflict' } };
    if (chosen.scan.status === 'incomplete')
      return { status: 409, body: { error: 'review-incomplete' } };
    try {
      const { withLock } = await import(pathToFileURL(CORE).href);
      const store = resolve(home);
      if (closed) return { status: 503, body: { error: 'inventory-unavailable' } };
      if (Date.now() >= deadline) return { status: 503, body: { error: 'deadline-exceeded' } };
      await ensureInventoryStore(store);
      // Workers share the server PID. Owning this lock in a worker would leave
      // it looking permanently live after that worker was terminated.
      return await withLock(
        join(store, 'console', 'inventory.lock'),
        () => run('review', { ...input, reviewLockHeld: true }, deadline),
        { timeoutMs: Math.max(1, Math.min(3000, deadline - Date.now())) },
      );
    } catch (error) {
      return {
        status: error?.message === 'baseline-invalid' ? 409 : 503,
        body: {
          error:
            error?.message === 'baseline-invalid'
              ? 'baseline-invalid'
              : Date.now() >= deadline
                ? 'deadline-exceeded'
                : 'inventory-unavailable',
        },
      };
    }
  }
  return {
    // Internal scheduler only. The browser cannot select a worker operation.
    observe() {
      return exclusive(() => run('observe'));
    },
    read() {
      if (reviewing || inspecting) return Promise.resolve({ status: 409, body: { error: 'busy' } });
      if (pending) return pending;
      pending = run('read').finally(() => {
        pending = null;
      });
      return pending;
    },
    async review(input) {
      if (!validReview(input)) return { status: 400, body: { error: 'invalid-request' } };
      input = Object.freeze({ ...input });
      if (pending || reviewing) return { status: 409, body: { error: 'busy' } };
      reviewing = true;
      pending = performReview(input).finally(() => {
        pending = null;
        reviewing = false;
      });
      return pending;
    },
    async inspect(input) {
      if (!validInspect(input)) return { status: 400, body: { error: 'invalid-request' } };
      if (pending || reviewing) return { status: 409, body: { error: 'busy' } };
      inspecting = true;
      pending = run('inspect', input).finally(() => {
        pending = null;
        inspecting = false;
      });
      return pending;
    },
    async compare(input) {
      if (!validCompare(input)) return { status: 400, body: { error: 'invalid-request' } };
      if (pending || reviewing) return { status: 409, body: { error: 'busy' } };
      inspecting = true;
      pending = run('compare', { ...input }).finally(() => {
        pending = null;
        inspecting = false;
      });
      return pending;
    },
    async signalState(input) {
      if (!validInspect(input)) return invalid();
      return exclusive(() => run('signal-state', { ...input }));
    },
    async signalPreview(input) {
      if (!validSignalPreview(input)) return invalid();
      input = Object.freeze({ ...input });
      let schema;
      try {
        schema = await loadSchema();
      } catch {
        return { status: 503, body: { error: 'engine-unavailable' } };
      }
      if (typeof schema.signalReasonMatches !== 'function')
        return { status: 503, body: { error: 'engine-unavailable' } };
      if (!schema.signalReasonMatches(input.decision, input.reason)) return invalid();
      return exclusive(async () => {
        prune();
        if (plans.size >= 8) return { status: 409, body: { error: 'signal-preview-limit' } };
        const response = await run('signal-preview', input);
        if (response.status !== 200) return response;
        const state = response.body,
          previewId = randomUUID(),
          expiresAt = Date.parse(state.generatedAt) + 120000;
        const preview = {
          schema: 'stroq-inventory-signal-preview/1',
          source: 'local',
          workspaceId: state.workspaceId,
          previewId,
          expiresAt: new Date(expiresAt).toISOString(),
          decision: input.decision,
          reason: input.reason,
          expectedDecisionId: input.expectedDecisionId,
          state,
          limitations: schema.INVENTORY_SIGNAL_LIMITATIONS,
        };
        if (closed || Date.now() >= expiresAt || !schema.validateInventorySignalPreview(preview))
          return { status: 503, body: { error: 'inventory-unavailable' } };
        plans.set(
          previewId,
          Object.freeze({
            expiresAt,
            binding: structuredClone(state.binding),
            decision: input.decision,
            reason: input.reason,
            expectedDecisionId: input.expectedDecisionId,
          }),
        );
        return { status: 200, body: preview };
      });
    },
    async signalApply(input) {
      if (
        !fields(input, ['previewId', 'acknowledgeSignalOnly']) ||
        !uuid(input.previewId) ||
        input.acknowledgeSignalOnly !== true
      )
        return invalid();
      const previewId = input.previewId;
      return exclusive(async () => {
        const plan = plans.get(previewId);
        plans.delete(previewId);
        prune();
        if (!plan || plan.expiresAt <= Date.now()) return conflict();
        const deadline = Math.min(Date.now() + timeoutMs, plan.expiresAt);
        try {
          const schema = await loadSchema();
          const { withLock } = await import(pathToFileURL(CORE).href);
          if (closed) return { status: 503, body: { error: 'inventory-unavailable' } };
          // Only an explicit, live preview can create this private metadata store.
          await ensureInventoryStore(resolve(home));
          return await withLock(
            join(resolve(home), 'console', 'inventory.lock'),
            async () => {
              if (closed) return { status: 503, body: { error: 'inventory-unavailable' } };
              if (Date.now() >= deadline) return conflict();
              const response = await run(
                'signal-apply',
                { ...plan, previewExpiresAt: plan.expiresAt, signalLockHeld: true },
                deadline,
              );
              if (response.status !== 200) return response;
              const state = response.body,
                record = state.decision;
              if (!record) return { status: 503, body: { error: 'inventory-unavailable' } };
              const receipt = {
                schema: 'stroq-inventory-signal-receipt/1',
                source: 'local',
                workspaceId: state.workspaceId,
                previewId,
                recordId: record.id,
                decision: record.decision,
                recordedAt: record.recordedAt,
                state,
                baselineChanged: false,
                permissionsChanged: false,
              };
              return schema.validateInventorySignalReceipt(receipt)
                ? { status: 200, body: receipt }
                : { status: 503, body: { error: 'inventory-unavailable' } };
            },
            { timeoutMs: Math.max(1, Math.min(3000, deadline - Date.now())) },
          );
        } catch {
          return {
            status: 503,
            body: { error: Date.now() >= deadline ? 'deadline-exceeded' : 'inventory-unavailable' },
          };
        }
      });
    },
    async close() {
      closed = true;
      plans.clear();
      stop?.();
      await pending;
    },
  };
}
