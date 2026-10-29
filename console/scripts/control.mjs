import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { ENGINE_PATHS, REPOSITORY, engineAvailability, executeRun } from './control-engine.mjs';
import { normalizeReport, summaryOf, validRunInput } from './control-reports.mjs';
import { createRunStore } from './run-store.mjs';
import { runtimeDigest } from './agent-setup-cli.mjs';
import { rootIdentity, snapshotFile } from './agent-setup-files.mjs';
import { readPolicyState } from './policy-files.mjs';
import { createProtectionCheckCoordinator } from './control-protection-check.mjs';

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
const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const validContext = (value) =>
  value &&
  typeof value === 'object' &&
  Object.keys(value).length === 3 &&
  digest(value.workspaceId) &&
  (value.policySha256 === null || digest(value.policySha256)) &&
  (value.runtimeSha256 === null || digest(value.runtimeSha256));
const unbound = (workspaceId) => ({ workspaceId, policySha256: null, runtimeSha256: null });

/** Bounded code/policy reads only; no CLI, agent, credential or transcript process runs. */
export async function readControlContext(options = {}) {
  const selected = resolve(options.project ?? REPOSITORY);
  let workspaceId = sha256(`stroq-unavailable-workspace/1\0${selected}`);
  try {
    const canonical = await realpath(selected);
    const stat = await lstat(canonical);
    if (!stat.isDirectory()) return unbound(workspaceId);
    workspaceId = sha256(`stroq-workspace/1\0${canonical}\0${stat.dev}\0${stat.ino}`);
  } catch {
    return unbound(workspaceId);
  }
  const paths = options.paths ?? ENGINE_PATHS;
  const [policy, runtime] = await Promise.allSettled([
    readPolicyState(options.home ?? join(options.userHome ?? homedir(), '.stroq')).then(
      (value) => value.rawSha ?? sha256('stroq-bundled-default-policy/1'),
    ),
    (async () => {
      const cli = await runtimeDigest(paths);
      const core = await snapshotFile(
        await rootIdentity(dirname(paths.core)),
        paths.core,
        16 * 1024 * 1024,
      );
      if (core.bytes === null) throw new Error('engine-unavailable');
      return createHash('sha256')
        .update('stroq-control-runtime/1\0')
        .update(cli)
        .update(core.bytes)
        .update(process.version)
        .update(process.platform)
        .update(process.arch)
        .digest('hex');
    })(),
  ]);
  return {
    workspaceId,
    policySha256: policy.status === 'fulfilled' ? policy.value : null,
    runtimeSha256: runtime.status === 'fulfilled' ? runtime.value : null,
  };
}

/** Bounded private history. Submitted text and raw reports are never stored. */
export async function createControl({ engine, execute = executeRun, ...options } = {}) {
  let platformWorkspaceId;
  try {
    const canonical = await realpath(resolve(options.project ?? REPOSITORY));
    if ((await lstat(canonical)).isDirectory())
      platformWorkspaceId = `workspace-${sha256(canonical).slice(0, 24)}`;
  } catch {
    /* An unavailable local identity must not create scoped navigation. */
  }
  const info = engine ?? (await engineAvailability(options.paths));
  const copy = (value) => structuredClone(value);
  const readContext = options.readContext ?? (() => readControlContext(options));
  let context = unbound(
    sha256(`stroq-unavailable-workspace/1\0${resolve(options.project ?? REPOSITORY)}`),
  );
  let contextPending = null;
  function currentContext(fresh = false) {
    if (contextPending)
      return fresh ? contextPending.then(() => currentContext(true)) : contextPending;
    contextPending = Promise.resolve()
      .then(readContext)
      .then((value) => {
        context = validContext(value) ? copy(value) : unbound(context.workspaceId);
        return copy(context);
      })
      .catch(() => {
        context = unbound(context.workspaceId);
        return copy(context);
      })
      .finally(() => {
        contextPending = null;
      });
    return contextPending;
  }
  await currentContext();
  const workspaceId = context.workspaceId;
  const readStore = () =>
    (options.createStore ?? createRunStore)({
      home: options.home,
      workspaceId,
      ...(options.loadValidator ? { loadValidator: options.loadValidator } : {}),
    });
  let store = await readStore();
  let runs = store.runs;
  let closed = false;
  async function executeIndividual(input, run, signal) {
    let result,
      failure = null;
    try {
      result = normalizeReport(input.kind, await execute(input, { ...options, signal }));
      if (signal.aborted) throw new Error('server-stopped');
    } catch (error) {
      failure = FAILURES.has(error?.message) ? error.message : 'engine-failed';
    }
    const after = await currentContext(true);
    const matches = ['workspaceId', 'policySha256', 'runtimeSha256'].every(
      (key) => run.provenance[key] === after[key],
    );
    return {
      ...run,
      status: failure ? 'failed' : 'completed',
      finishedAt: new Date().toISOString(),
      provenance: matches ? run.provenance : unbound(run.provenance.workspaceId),
      ...(failure ? { error: failure } : { summary: summaryOf(input.kind, result), result }),
    };
  }
  const protection = createProtectionCheckCoordinator({
    options,
    info,
    workspaceId,
    platformWorkspaceId,
    currentContext,
    readStore,
    execute,
    executeIndividual,
    setStore: (value) => {
      store = value;
    },
    getRuns: () => runs,
    setRuns: (value) => {
      runs = value;
    },
  });
  return {
    snapshot: async () => {
      await protection.observe();
      return {
        schema: 'stroq-control/1',
        ...(platformWorkspaceId ? { workspaceId: platformWorkspaceId } : {}),
        engine: copy(info),
        context: await currentContext(),
        history: protection.historyError() ?? store.state(),
        activeProtectionCheckId: protection.activeRunId(),
        activeRunId: protection.activeControlRunId(),
        runs: copy(runs),
      };
    },
    getRun: (id) => copy(runs.find((run) => run.id === id) ?? null),
    async readRun(id) {
      await protection.observe();
      return copy(runs.find((run) => run.id === id) ?? null);
    },
    start(input) {
      if (!validRunInput(input)) return { status: 400, body: { error: 'invalid-request' } };
      if (closed || !info.available) return { status: 503, body: { error: 'engine-unavailable' } };
      return protection.start(copy(input));
    },
    idle: () => protection.idle(),
    cancel: (input) => protection.cancel(input),
    async close() {
      closed = true;
      await protection.close();
    },
  };
}
