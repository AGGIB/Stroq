import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createControl } from './control.mjs';
import { routeControl } from './control-http.mjs';
import { acquireWorkspaceMonitorLease } from './workspace-monitor-lease.mjs';
import { protectionEvidence } from './control-reports.mjs';
import { runtimeLayout } from './runtime-layout.mjs';
import { executeRun } from './control-engine.mjs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const hash = (v) => createHash('sha256').update(v).digest('hex');
const ids = ['doctor', 'policy-check', 'guard-test', 'saved-policy-checks', 'workspace-review'];
const sha = 'a'.repeat(64),
  other = 'b'.repeat(64);
const raw = {
  doctor: { version: 1, ok: true, checks: [{ name: 'rules', ok: true, detail: 'PRIVATE_TEXT' }] },
  'policy-check': {
    version: 1,
    ok: true,
    loaded: true,
    source: 'default',
    file: null,
    policy: { rules: 12, default: 'allow', threshold: 0.6, sha256: sha },
    faults: [],
    findings: [],
  },
  'guard-test': {
    version: 1,
    ok: true,
    replayed: { attack: 2, ordinary: 3, cases: 0 },
    attacksPassing: [],
    newInterruptions: [],
    relieved: [],
    violations: [],
    notJudged: [],
  },
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(read, predicate) {
  for (let i = 0; i < 150; i++) {
    const value = await read();
    if (predicate(value)) return value;
    await wait(5);
  }
  throw new Error('fixture-deadline');
}
async function fixture(t, extra = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'stroq-protection-check-')));
  const project = join(base, 'project'),
    home = join(base, 'home');
  await mkdir(project, { mode: 0o700 });
  await mkdir(home, { mode: 0o700 });
  t.after(() => rm(base, { recursive: true, force: true }));
  const workspaceId = `workspace-${hash(project).slice(0, 24)}`;
  const context = {
    workspaceId: sha,
    policySha256: hash('stroq-bundled-default-policy/1'),
    runtimeSha256: sha,
  };
  const calls = [],
    controllers = [],
    cancelled = [],
    writes = [];
  let leaseHeld = false,
    leaseValid = true,
    stored = [],
    historyStatus = 'ready',
    failureAt = null;
  const workspaceRun = {
    schema: 'stroq-workspace-review-run/1',
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    workspaceId,
    status: 'completed',
    startedAt: '2026-10-24T00:00:00.000Z',
    finishedAt: '2026-10-24T00:00:01.000Z',
    result: {
      capture: {
        schema: 'stroq-workspace-capture/1',
        workspaceId,
        capturedAt: '2026-10-24T00:00:01.000Z',
        captureSha256: sha,
        profile: {
          id: 'stroq-workspace-surface/1',
          engineVersion: '0.28.0',
          runtimeSha256: sha,
          scopeSha256: sha,
        },
        complete: true,
        coverage: { omittedSources: 0, omittedEntries: 0, exclusions: [], gaps: [] },
        sources: [],
        entries: [],
      },
      baseline: { status: 'missing', revision: null, reviewedAt: null, capture: null },
      comparison: {
        status: 'missing',
        reason: 'no-baseline',
        sources: [],
        entries: { added: [], removed: [], unchanged: 0 },
      },
      canReview: true,
    },
  };
  const saved = {
    schema: 'stroq-policy-cases/1',
    source: 'local',
    workspaceId,
    generatedAt: '2026-10-24T00:00:01.000Z',
    revision: null,
    cases: [],
    report: {
      policy: { source: 'built-in', semanticSha: sha, rawSha: null },
      total: 0,
      passed: 0,
      failed: 0,
      results: [],
      hostEnforcement: false,
    },
  };
  const createStore = async () => ({
    runs: structuredClone(stored),
    state: () =>
      historyStatus === 'ready' ? { status: 'ready' } : { status: 'error', error: historyStatus },
    async write(next) {
      writes.push(structuredClone(next));
      if (failureAt !== null && writes.length >= failureAt) {
        historyStatus = 'write-failed';
        return false;
      }
      stored = structuredClone(next);
      return true;
    },
  });
  const options = {
    project,
    home,
    engine: { available: true, version: '0.28.0' },
    readContext: async () => context,
    createStore,
    withLock: async (_bound, action) => action(),
    acquireLease: async () => {
      if (leaseHeld) return null;
      leaseHeld = true;
      return {
        assertCurrent: async () => {
          if (!leaseValid) throw new Error('lost');
        },
        release: async () => {
          leaseHeld = false;
        },
      };
    },
    validateProtectionEvidence: (kind, value) =>
      kind === 'saved-policy-checks'
        ? value.schema === 'stroq-policy-cases/1' && value.workspaceId === workspaceId
        : value.schema === 'stroq-workspace-review-run/1' && value.workspaceId === workspaceId,
    execute: async (input, execution) => {
      calls.push(input.kind);
      controllers.push(execution.signal);
      return structuredClone(raw[input.kind]);
    },
    policyCases: {
      read: async () => {
        calls.push('saved-policy-checks');
        saved.generatedAt = new Date().toISOString();
        return { status: 200, body: structuredClone(saved) };
      },
    },
    workspaceReview: {
      check: async () => {
        calls.push('workspace-review');
        const at = new Date().toISOString();
        workspaceRun.startedAt = at;
        workspaceRun.finishedAt = at;
        workspaceRun.result.capture.capturedAt = at;
        return {
          status: 202,
          body: {
            schema: workspaceRun.schema,
            id: workspaceRun.id,
            workspaceId,
            status: 'running',
            startedAt: at,
          },
        };
      },
      getRun: () => structuredClone(workspaceRun),
      cancel: async ({ id }) => {
        cancelled.push(id);
        return { status: 200, body: structuredClone(workspaceRun) };
      },
    },
    ...extra,
  };
  const control = await createControl(options);
  t.after(() => control.close());
  return {
    base,
    project,
    home,
    workspaceId,
    context,
    calls,
    controllers,
    cancelled,
    writes,
    control,
    options,
    saved,
    workspaceRun,
    setStored: (value) => {
      stored = structuredClone(value);
    },
    stored: () => structuredClone(stored),
    corrupt: () => {
      historyStatus = 'invalid-history';
    },
    failWrite: (n) => {
      failureAt = n;
    },
    loseLease: () => {
      leaseValid = false;
    },
    leaseHeld: () => leaseHeld,
  };
}

test('one parent runs five real fixed stages, retains finite results and does not invent child IDs', async (t) => {
  const f = await fixture(t);
  const accepted = await f.control.start({ kind: 'protection-check' });
  assert.equal(accepted.status, 202);
  assert.equal(accepted.body.kind, 'protection-check');
  assert.deepEqual(
    accepted.body.progress.steps.map((s) => s.id),
    ids,
  );
  assert.ok(accepted.body.progress.steps.every((s) => s.status === 'queued'));
  await f.control.idle();
  const run = f.control.getRun(accepted.body.id);
  assert.deepEqual(f.calls, ids);
  assert.equal(run.status, 'completed');
  assert.deepEqual(
    run.progress.steps.map((s) => s.status),
    ids.map(() => 'completed'),
  );
  assert.equal(run.result.completed, 5);
  assert.equal(run.result.outcome, 'finished');
  assert.equal(run.result.hostEnforcement, false);
  assert.equal(run.progress.steps[4].result.runId, f.workspaceRun.id);
  assert.equal(run.progress.steps[4].result.captureSha256, sha);
  assert.equal(run.progress.steps[3].result.total, 0);
  assert.deepEqual(run.progress.steps[3].result.results, []);
  assert.ok(!JSON.stringify(run).includes('PRIVATE_TEXT'));
  assert.equal(f.stored().length, 1);
  assert.equal(f.leaseHeld(), false);
});

test('fresh context drift halts remaining stages and preserves historical completed evidence', async (t) => {
  let f;
  f = await fixture(t, {
    execute: async ({ kind }) => {
      f.calls.push(kind);
      f.context.policySha256 = other;
      return raw[kind];
    },
  });
  const accepted = await f.control.start({ kind: 'protection-check' });
  await f.control.idle();
  const run = f.control.getRun(accepted.body.id);
  assert.deepEqual(f.calls, ['doctor']);
  assert.equal(run.status, 'failed');
  assert.equal(run.error, 'context-changed');
  assert.equal(run.progress.steps[0].status, 'completed');
  assert.ok(
    run.progress.steps
      .slice(1)
      .every((s) => s.status === 'skipped' && s.error === 'context-changed'),
  );
  assert.equal(run.provenance.policySha256, null);
  assert.equal(run.result.completed, 1);
});

test('invalid policy skips dependent simulations while independent workspace still runs', async (t) => {
  const f = await fixture(t, {
    execute: async ({ kind }) =>
      kind === 'policy-check'
        ? { ...raw[kind], ok: false, loaded: false, policy: null, faults: [{ kind: 'yaml' }] }
        : raw[kind],
  });
  const accepted = await f.control.start({ kind: 'protection-check' });
  await f.control.idle();
  const run = f.control.getRun(accepted.body.id);
  assert.equal(run.status, 'failed');
  assert.equal(run.result.outcome, 'incomplete');
  assert.deepEqual(
    run.progress.steps.map((s) => s.status),
    ['completed', 'completed', 'skipped', 'skipped', 'completed'],
  );
  assert.equal(run.progress.steps[2].error, 'prerequisite-failed');
  assert.equal(run.progress.steps[4].result.runId, f.workspaceRun.id);
});

test('failed independent stage does not discard results or masquerade as protection', async (t) => {
  const f = await fixture(t, {
    execute: async ({ kind }) => {
      if (kind === 'doctor') throw new Error('PRIVATE_ERROR');
      return raw[kind];
    },
  });
  const accepted = await f.control.start({ kind: 'protection-check' });
  await f.control.idle();
  const run = f.control.getRun(accepted.body.id);
  assert.equal(run.status, 'failed');
  assert.equal(run.progress.steps[0].error, 'engine-failed');
  assert.equal(run.result.completed, 4);
  assert.equal(run.progress.steps[4].status, 'completed');
  assert.ok(!JSON.stringify(run).includes('PRIVATE_ERROR'));
});

test('corrupt history refuses fresh parent before execution and remains intact', async (t) => {
  const f = await fixture(t);
  f.corrupt();
  const accepted = await f.control.start({ kind: 'protection-check' });
  assert.equal(accepted.status, 503);
  assert.equal(accepted.body.error, 'history-unavailable');
  assert.deepEqual(f.calls, []);
  assert.equal(f.writes.length, 0);
});

test('persistence failure stops later stages and exposes incomplete memory report', async (t) => {
  const f = await fixture(t);
  f.failWrite(4);
  const accepted = await f.control.start({ kind: 'protection-check' });
  assert.equal(accepted.status, 202);
  await f.control.idle();
  const run = f.control.getRun(accepted.body.id);
  assert.equal(run.status, 'failed');
  assert.equal(run.error, 'history-unavailable');
  assert.ok(f.calls.length < 5);
  assert.equal((await f.control.snapshot()).history.status, 'error');
  assert.equal(run.result.outcome, 'incomplete');
});

test('real parent cancellation aborts owned work, waits termination and skips later stages', async (t) => {
  let onAbort, release;
  const started = new Promise((resolve) => {
    onAbort = resolve;
  });
  const f = await fixture(t, {
    execute: (_input, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            onAbort();
            release = () => reject(new Error('server-stopped'));
          },
          { once: true },
        );
      }),
  });
  const accepted = await f.control.start({ kind: 'protection-check' });
  await until(
    () => f.control.getRun(accepted.body.id),
    (run) => run.progress.steps[0].status === 'running',
  );
  let done = false;
  const cancellation = f.control.cancel({ id: accepted.body.id }).then((r) => {
    done = true;
    return r;
  });
  await started;
  await wait(10);
  assert.equal(done, false);
  release();
  const response = await cancellation;
  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'cancelled');
  assert.equal(response.body.error, 'cancelled');
  assert.ok(response.body.progress.steps.slice(1).every((s) => s.status === 'skipped'));
  assert.equal(f.leaseHeld(), false);
});

test('workspace busy never adopts or cancels another monitor/manual run', async (t) => {
  let reads = 0,
    cancels = 0;
  const f = await fixture(t, {
    workspaceReview: {
      check: async () => ({ status: 409, body: { error: 'workspace-review-busy' } }),
      getRun: () => {
        reads++;
        return null;
      },
      cancel: () => {
        cancels++;
      },
    },
  });
  const accepted = await f.control.start({ kind: 'protection-check' });
  await f.control.idle();
  const run = f.control.getRun(accepted.body.id);
  assert.equal(run.progress.steps[4].status, 'failed');
  assert.equal(run.progress.steps[4].error, 'workspace-review-busy');
  assert.equal(run.result.completed, 4);
  assert.equal(reads, 0);
  assert.equal(cancels, 0);
});

test('owned workspace cancellation uses exact accepted ID and waits finalization', async (t) => {
  let job,
    cancelled = null,
    started = false;
  const f = await fixture(t, {
    workspaceReview: {
      check: async () => {
        started = true;
        job = { ...f.workspaceRun, status: 'running' };
        delete job.result;
        return { status: 202, body: job };
      },
      getRun: () => job,
      cancel: async ({ id }) => {
        cancelled = id;
        await wait(10);
        job = { ...job, status: 'cancelled', error: 'cancelled' };
        return { status: 200, body: job };
      },
    },
  });
  const accepted = await f.control.start({ kind: 'protection-check' });
  await until(() => started, Boolean);
  const result = await f.control.cancel({ id: accepted.body.id });
  assert.equal(cancelled, f.workspaceRun.id);
  assert.equal(result.body.status, 'cancelled');
  assert.equal(result.body.progress.steps[4].result, null);
});

test('parent lease serializes different consoles and stale recovery never resumes old work', async (t) => {
  const f = await fixture(t);
  const second = await createControl(f.options);
  t.after(() => second.close());
  let finish,
    hold = true;
  f.options.execute = async ({ kind }) => {
    if (!hold) return raw[kind];
    hold = false;
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
  const held = await createControl(f.options);
  t.after(() => held.close());
  const accepted = await held.start({ kind: 'protection-check' });
  await until(() => finish, Boolean);
  const busy = await second.start({ kind: 'protection-check' });
  assert.equal(busy.status, 409);
  finish(raw.doctor);
  await held.idle();
  const previous = held.getRun(accepted.body.id);
  previous.status = 'running';
  delete previous.result;
  delete previous.finishedAt;
  f.setStored([previous]);
  const restarted = await createControl(f.options);
  t.after(() => restarted.close());
  assert.equal(restarted.getRun(previous.id).status, 'running');
  const next = await restarted.start({ kind: 'protection-check' });
  assert.equal(next.status, 202);
  assert.equal(restarted.getRun(previous.id).error, 'interrupted');
  await restarted.idle();
});

test('lease loss and bad stage evidence cannot allow later stages', async (t) => {
  let f;
  f = await fixture(t, {
    execute: async ({ kind }) => {
      f.loseLease();
      return raw[kind];
    },
  });
  const accepted = await f.control.start({ kind: 'protection-check' });
  await f.control.idle();
  const run = f.control.getRun(accepted.body.id);
  assert.equal(run.error, 'ownership-lost');
  assert.equal(run.status, 'failed');
  assert.ok(run.result.completed <= 1);
});

test('read-only observations follow another console without claiming its job or mutating history', async (t) => {
  const f = await fixture(t);
  const reader = await createControl(f.options);
  t.after(() => reader.close());
  let release;
  f.options.execute = ({ kind }) =>
    kind === 'doctor'
      ? new Promise((resolve) => {
          release = resolve;
        })
      : Promise.resolve(raw[kind]);
  const owner = await createControl(f.options);
  t.after(() => owner.close());
  const accepted = await owner.start({ kind: 'protection-check' });
  await until(() => release, Boolean);
  const before = f.writes.length,
    observed = await reader.snapshot();
  assert.equal(observed.activeProtectionCheckId, null);
  assert.equal(observed.runs[0].id, accepted.body.id);
  assert.equal(observed.runs[0].status, 'running');
  assert.equal(f.writes.length, before);
  assert.equal((await owner.snapshot()).activeProtectionCheckId, accepted.body.id);
  release(raw.doctor);
  await owner.idle();
  const count = f.writes.length;
  const exact = await routeControl(
    { method: 'GET' },
    `/api/runs/${accepted.body.id}`,
    'http://fixture',
    reader,
  );
  assert.equal(exact.status, 200);
  assert.equal(exact.body.status, 'completed');
  assert.equal(f.writes.length, count);
  assert.equal(
    owner.getRun(accepted.body.id).status,
    'completed',
    JSON.stringify(owner.getRun(accepted.body.id)),
  );
  const final = await reader.snapshot();
  assert.equal(final.runs[0].status, 'completed');
  assert.equal(final.activeProtectionCheckId, null);
});

test('all offline kinds share ownership and another console cannot rewrite a live individual run', async (t) => {
  const f = await fixture(t);
  let release;
  const owner = await createControl({
    ...f.options,
    execute: (_input, { signal }) =>
      new Promise((resolve, reject) => {
        release = resolve;
        signal.addEventListener('abort', () => reject(new Error('server-stopped')), { once: true });
      }),
  });
  t.after(() => owner.close());
  const accepted = await owner.start({ kind: 'doctor' });
  await until(() => release, Boolean);
  const before = f.writes.length;
  const reader = await createControl(f.options);
  t.after(() => reader.close());
  assert.equal(f.writes.length, before, 'startup cannot rewrite a foreign running row');
  assert.equal((await owner.snapshot()).activeRunId, accepted.body.id);
  const observed = await reader.snapshot();
  assert.equal(observed.activeRunId, null);
  assert.equal(observed.activeProtectionCheckId, null);
  assert.equal(observed.runs[0].status, 'running');
  for (const kind of ['doctor', 'protection-check'])
    assert.equal((await reader.start({ kind })).status, 409);
  assert.equal(f.writes.length, before, 'busy attempts and reads cannot rewrite history');
  release(raw.doctor);
  await owner.idle();
  const exact = await reader.readRun(accepted.body.id);
  assert.equal(exact.status, 'completed');
  assert.deepEqual(exact, owner.getRun(accepted.body.id));
  assert.deepEqual(exact, f.stored()[0]);
  assert.equal((await owner.snapshot()).activeRunId, null);
});

test('invalid history and rejected running writes prevent every individual engine dispatch', async (t) => {
  const inputs = [
    { kind: 'doctor' },
    { kind: 'policy-check' },
    { kind: 'guard-test' },
    { kind: 'content-scan', content: 'fixture text', target: 'skill' },
  ];
  for (const input of inputs) {
    const f = await fixture(t);
    f.corrupt();
    const accepted = await f.control.start(input);
    await f.control.idle();
    assert.equal(accepted.status, 503, input.kind);
    assert.equal(accepted.body.error, 'history-unavailable');
    assert.deepEqual(f.calls, []);
    assert.equal(f.writes.length, 0);
    const blocked = await fixture(t);
    blocked.failWrite(1);
    assert.equal((await blocked.control.start(input)).status, 503);
    await blocked.control.idle();
    assert.deepEqual(blocked.calls, []);
  }
});

test('a true write without a fresh exact retained row cannot authorize execution or completion', async (t) => {
  for (const kind of ['doctor', 'protection-check'])
    for (const rejectTerminal of [false, true]) {
      const f = await fixture(t);
      const control = await createControl({
        ...f.options,
        createStore: async () => {
          const store = await f.options.createStore();
          return {
            ...store,
            write: async (rows) => {
              if (rows.some((r) => (r.status === 'completed') === rejectTerminal)) return true;
              return store.write(rows);
            },
          };
        },
      });
      t.after(() => control.close());
      const accepted = await control.start({ kind });
      await control.idle();
      if (!rejectTerminal) {
        assert.equal(accepted.status, 503);
        assert.deepEqual(f.calls, []);
      } else {
        assert.equal(accepted.status, 202);
        const result = control.getRun(accepted.body.id);
        assert.equal(result.status, 'failed');
        assert.equal(result.error, 'history-unavailable');
        if (kind === 'doctor') assert.equal(result.result, undefined);
        else assert.equal(result.result.outcome, 'incomplete');
        assert.equal((await control.snapshot()).history.status, 'error');
        assert.equal((await control.start({ kind: 'doctor' })).status, 503);
      }
    }
});

test('individual terminal publication waits for durable finalization and a lost owner cannot publish success', async (t) => {
  const f = await fixture(t);
  let finishWrite;
  const control = await createControl({
    ...f.options,
    createStore: async () => {
      const store = await f.options.createStore();
      return {
        ...store,
        write: async (rows) => {
          if (rows.some((r) => r.status === 'completed'))
            await new Promise((resolve) => {
              finishWrite = resolve;
              setTimeout(resolve, 1500);
            });
          return store.write(rows);
        },
      };
    },
  });
  t.after(() => control.close());
  const accepted = await control.start({ kind: 'doctor' });
  await until(() => finishWrite, Boolean);
  assert.equal(control.getRun(accepted.body.id).status, 'running');
  assert.equal((await control.snapshot()).activeRunId, accepted.body.id);
  assert.equal(f.leaseHeld(), true);
  finishWrite();
  await control.idle();
  assert.equal(control.getRun(accepted.body.id).status, 'completed');
  const lost = await fixture(t, {
    execute: async () => {
      lost.loseLease();
      return raw.doctor;
    },
  });
  const started = await lost.control.start({ kind: 'doctor' });
  await lost.control.idle();
  assert.equal(lost.control.getRun(started.body.id).status, 'failed');
  assert.equal(lost.control.getRun(started.body.id).error, 'ownership-lost');
  assert.equal(lost.control.getRun(started.body.id).result, undefined);
});

test('a readable policy is not a prerequisite for individual installation or content checks', async (t) => {
  for (const kind of ['doctor', 'content-scan']) {
    const f = await fixture(t);
    f.context.policySha256 = null;
    f.context.runtimeSha256 = null;
    const control = await createControl({
      ...f.options,
      execute: async () =>
        kind === 'doctor'
          ? raw.doctor
          : {
              target: 'skill',
              verdict: 'clean',
              score: 0,
              timedOut: false,
              characters: 4,
              sha256: sha,
              matches: [],
            },
    });
    t.after(() => control.close());
    const accepted = await control.start(
      kind === 'doctor' ? { kind } : { kind, content: 'text', target: 'skill' },
    );
    assert.equal(accepted.status, 202);
    await control.idle();
    assert.equal(control.getRun(accepted.body.id).status, 'completed');
    assert.equal(control.getRun(accepted.body.id).provenance.policySha256, null);
  }
});

test('content-worker shutdown drains actual termination before publishing and releasing shared ownership', async (t) => {
  let worker, terminate;
  class HeldWorker extends EventEmitter {
    constructor() {
      super();
      worker = this;
      this.stdout = new PassThrough();
      this.stderr = new PassThrough();
    }
    terminate() {
      return new Promise((resolve) => {
        terminate = resolve;
        setTimeout(resolve, 1500);
      });
    }
  }
  const f = await fixture(t, {
    execute: (input, options) => executeRun(input, { ...options, Worker: HeldWorker }),
  });
  const accepted = await f.control.start({
    kind: 'content-scan',
    content: 'fixture',
    target: 'skill',
  });
  assert.equal(accepted.status, 202);
  await until(() => worker, Boolean);
  let closed = false;
  const closing = f.control.close().then(() => {
    closed = true;
  });
  await until(() => terminate, Boolean);
  try {
    assert.equal(closed, false);
    assert.equal(f.leaseHeld(), true);
    assert.equal(f.control.getRun(accepted.body.id).status, 'running');
    const reader = await createControl(f.options);
    t.after(() => reader.close());
    assert.equal((await reader.start({ kind: 'doctor' })).status, 409);
  } finally {
    terminate(0);
    await closing;
  }
  assert.equal(f.leaseHeld(), false);
  assert.equal(f.control.getRun(accepted.body.id).error, 'server-stopped');
  assert.equal(f.stored()[0].status, 'failed');
});

test('cancel route has an explicit action gate and closed ID input', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.control.cancel({ id: 'x' })).status, 400);
  assert.equal(
    (await f.control.cancel({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })).status,
    404,
  );
  const read = await routeControl(
    { method: 'GET' },
    '/api/runs/cancel',
    'http://fixture',
    f.control,
  );
  assert.equal(read.status, 405);
});

test('production store, shared lock and PID lease retain the exact parent across consoles and restart', async (t) => {
  const f = await fixture(t),
    output = join(f.base, 'schema');
  const { build } = await import('tsup');
  await build({
    entry: {
      control: join(import.meta.dirname, '../lib/control.ts'),
      api: join(import.meta.dirname, 'local-api-schema.ts'),
    },
    outDir: output,
    outExtension: () => ({ js: '.mjs' }),
    format: ['esm'],
    platform: 'node',
    target: 'node22',
    splitting: false,
    dts: false,
    config: false,
    silent: true,
  });
  const schema = await import(pathToFileURL(join(output, 'control.mjs')).href);
  const api = await import(pathToFileURL(join(output, 'api.mjs')).href);
  f.saved.limitations = [...api.CASE_LIMITATIONS];
  const options = {
    ...f.options,
    loadValidator: async () => schema,
    acquireLease: acquireWorkspaceMonitorLease,
  };
  for (const key of ['createStore', 'withLock', 'validateProtectionEvidence']) delete options[key];
  let release,
    hold = true;
  options.execute = async ({ kind }, { signal }) => {
    if (kind !== 'doctor' || !hold) return raw[kind];
    hold = false;
    return new Promise((resolve, reject) => {
      release = resolve;
      signal.addEventListener('abort', () => reject(new Error('server-stopped')), { once: true });
    });
  };
  const owner = await createControl(options);
  t.after(() => owner.close());
  const accepted = await owner.start({ kind: 'protection-check' });
  assert.equal(accepted.status, 202);
  await until(() => release, Boolean);
  const filename = join(f.home, 'console', `runs-${sha}.json`);
  const before = await readFile(filename, 'utf8');
  const reader = await createControl(options);
  t.after(() => reader.close());
  assert.equal(await readFile(filename, 'utf8'), before);
  const observed = await reader.snapshot();
  assert.equal(schema.validateControl(observed), true);
  assert.equal(observed.activeProtectionCheckId, null);
  assert.equal((await reader.start({ kind: 'protection-check' })).status, 409);
  assert.equal((await reader.cancel({ id: accepted.body.id })).status, 409);
  release(raw.doctor);
  await owner.idle();
  const report = await reader.snapshot();
  assert.equal(schema.validateControl(report), true);
  assert.equal(report.runs[0].status, 'completed');
  assert.equal(report.runs[0].progress.steps[3].result.total, 0);
  assert.equal(report.runs[0].progress.steps[4].result.runId, f.workspaceRun.id);
  const persisted = await readFile(filename, 'utf8');
  assert.ok(!persisted.includes('PRIVATE_TEXT'));
  const restarted = await createControl(options);
  t.after(() => restarted.close());
  assert.deepEqual(restarted.getRun(accepted.body.id), owner.getRun(accepted.body.id));
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import {createControl} from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, 'control.mjs')).href)};
    import {acquireWorkspaceMonitorLease} from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, 'workspace-monitor-lease.mjs')).href)};
    const service=await createControl({project:${JSON.stringify(f.project)},home:${JSON.stringify(f.home)},
      engine:{available:true,version:'0.28.0'},readContext:async()=>(${JSON.stringify(f.context)}),
      loadValidator:()=>import(${JSON.stringify(pathToFileURL(join(output, 'control.mjs')).href)}),
      acquireLease:acquireWorkspaceMonitorLease,
      execute:async()=>new Promise(()=>{})});
    const started=await service.start({kind:'protection-check'});
    process.stdout.write(JSON.stringify(started));process.exit(started.status===202?0:2);
  `,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 },
  );
  let childOutput = '',
    childErrors = '';
  child.stdout.on('data', (chunk) => {
    childOutput += chunk;
  });
  child.stderr.on('data', (chunk) => {
    childErrors += chunk;
  });
  const exit = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  assert.equal(exit, 0, childErrors);
  const crashedId = JSON.parse(childOutput).body.id;
  const interruptedBytes = await readFile(filename, 'utf8');
  const observation = await restarted.snapshot();
  assert.equal(observation.activeProtectionCheckId, null);
  assert.equal(observation.runs.find((run) => run.id === crashedId).status, 'running');
  assert.equal(await readFile(filename, 'utf8'), interruptedBytes);
  const lockPath = join(
    f.home,
    'console',
    'workspace-monitor-leases',
    `${hash(`stroq-protection-check/1\0${sha}`)}.lock`,
  );
  const old = new Date(Date.now() - 70_000);
  await utimes(lockPath, old, old);
  const recovered = await restarted.start({ kind: 'protection-check' });
  assert.equal(recovered.status, 202);
  assert.equal(restarted.getRun(crashedId).error, 'interrupted');
  assert.equal(restarted.getRun(crashedId).status, 'failed');
  await restarted.idle();
  assert.equal(restarted.getRun(recovered.body.id).status, 'completed');
  await writeFile(filename, '{"PRIVATE_CORRUPT":true}', { mode: 0o600 });
  assert.equal((await restarted.start({ kind: 'protection-check' })).status, 503);
  assert.equal(await readFile(filename, 'utf8'), '{"PRIVATE_CORRUPT":true}');
});

test('a saved-check result from another policy is refused even when its fields are well formed', async (t) => {
  const f = await fixture(t);
  f.saved.report.policy = { source: 'file', semanticSha: sha, rawSha: other };
  const accepted = await f.control.start({ kind: 'protection-check' });
  await f.control.idle();
  const run = f.control.getRun(accepted.body.id);
  assert.equal(run.status, 'failed');
  assert.equal(run.error, 'context-changed');
  assert.equal(run.progress.steps[3].status, 'failed');
  assert.equal(run.progress.steps[4].status, 'skipped');
  assert.ok(!f.calls.includes('workspace-review'));
});

test('saved-check evidence retains exact finite action classes and both mismatching decisions', async (t) => {
  const f = await fixture(t),
    id = `case-${sha}`;
  f.saved.revision = other;
  f.saved.cases = [
    {
      id,
      classes: ['shell.network'],
      createdAt: '2026-10-24T00:00:00.000Z',
      source: { incidentId: `incident-${sha}`, evidenceSha: sha, workspaceId: f.workspaceId },
      expected: [
        { taint: 'none', effect: 'deny' },
        { taint: 'suspect', effect: 'deny' },
      ],
    },
  ];
  f.saved.report = {
    ...f.saved.report,
    total: 1,
    passed: 0,
    failed: 1,
    results: [
      {
        caseId: id,
        passed: false,
        scenarios: [
          { taint: 'none', expected: 'deny', actual: 'allow' },
          { taint: 'suspect', expected: 'deny', actual: 'deny' },
        ],
      },
    ],
  };
  const accepted = await f.control.start({ kind: 'protection-check' });
  await f.control.idle();
  const result = f.control.getRun(accepted.body.id).progress.steps[3].result;
  assert.deepEqual(result.cases, [{ id, classes: ['shell.network'] }]);
  assert.deepEqual(result.results, f.saved.report.results);
  assert.ok(!JSON.stringify(result).includes('incident-'));
  const api = await import(pathToFileURL(runtimeLayout().adapter('local-api-schema.js')).href);
  f.saved.limitations = [...api.CASE_LIMITATIONS];
  const projected = await protectionEvidence('saved-policy-checks', f.saved, f.workspaceId);
  assert.deepEqual(projected.cases, result.cases);
  for (const mutate of [
    (value) => {
      value.cases[0].classes = ['PRIVATE_CLASS'];
    },
    (value) => {
      value.cases[0].classes = ['shell.network', 'shell.network'];
    },
    (value) => {
      value.report.results[0].caseId = `case-${other}`;
    },
    (value) => {
      value.cases = Array(65).fill(value.cases[0]);
    },
    (value) => {
      value.workspaceId = `workspace-${'b'.repeat(24)}`;
    },
  ]) {
    const bad = structuredClone(f.saved);
    mutate(bad);
    await assert.rejects(
      protectionEvidence('saved-policy-checks', bad, f.workspaceId),
      /^Error: invalid-report$/,
    );
  }
});

test('a read during individual-run finalization cannot replace its writer with a stale CAS revision', async (t) => {
  const f = await fixture(t);
  let revision = 0,
    saved = [],
    pause = true,
    announce,
    release;
  const entered = new Promise((resolve) => {
    announce = resolve;
  });
  const released = new Promise((resolve) => {
    release = resolve;
  });
  const createStore = async () => {
    let expected = revision,
      error = null;
    return {
      runs: structuredClone(saved),
      state: () => (error ? { status: 'error', error } : { status: 'ready' }),
      async write(next) {
        if (pause && next[0]?.status === 'completed') {
          pause = false;
          announce();
          await released;
        }
        if (expected !== revision) {
          error = 'write-failed';
          return false;
        }
        saved = structuredClone(next);
        expected = ++revision;
        return true;
      },
    };
  };
  const control = await createControl({
    ...f.options,
    createStore,
    execute: async () => raw.doctor,
  });
  t.after(() => control.close());
  const first = await control.start({ kind: 'doctor' });
  assert.equal(first.status, 202);
  await entered;
  const finalizing = await control.snapshot();
  assert.equal(finalizing.activeRunId, first.body.id);
  assert.equal(finalizing.runs.find((run) => run.id === first.body.id).status, 'running');
  release();
  await control.idle();
  const second = await control.start({ kind: 'doctor' });
  assert.equal(second.status, 202);
  await control.idle();
  const final = await control.snapshot();
  assert.equal(final.history.status, 'ready');
  assert.equal(final.activeRunId, null);
  assert.equal(saved.length, 2);
  assert.deepEqual(new Set(saved.map((run) => run.id)), new Set([first.body.id, second.body.id]));
  for (const id of [first.body.id, second.body.id]) {
    const retained = saved.find((run) => run.id === id);
    assert.equal(retained.status, 'completed');
    assert.deepEqual(retained, control.getRun(id));
    assert.deepEqual(retained, await control.readRun(id));
  }
});
