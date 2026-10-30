import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, after } from 'node:test';
import { build } from 'tsup';
const output = await realpath(await mkdtemp(join(tmpdir(), 'stroq-network-check-service-build-')));
after(() => rm(output, { recursive: true, force: true }));
await build({
  entry: { service: join(import.meta.dirname, 'codex-network-check-service.ts') },
  outDir: output,
  outExtension: () => ({ js: '.mjs' }),
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  config: false,
  dts: false,
  splitting: false,
  silent: true,
});
const { createCodexNetworkCheckService } = await import(
  pathToFileURL(join(output, 'service.mjs')).href
);
const sha = 'a'.repeat(64),
  context = 'codex-context-' + 'b'.repeat(64),
  workspace = 'workspace-' + 'c'.repeat(24);
const root = { path: '/fixture', dev: 1, ino: 2, uid: 501, mode: 0o40700 };
const preparation = {
  binding: {
    controlContextId: context,
    captureSha256: sha,
    configSha256: sha,
    runtimeSha256: sha,
    nativeBinarySha256: sha,
    sourceGraphSha256: sha,
  },
  kind: 'profile',
  profiles: { source: { extends: ':workspace', network: { enabled: false } } },
  selectedProfile: 'source',
  networkOff: true,
  managedUnverified: true,
  native: {
    path: '/fixture/codex',
    sha256: sha,
    version: 'codex-cli 0.164.0-alpha.11.1',
    platform: 'darwin',
    file: { dev: 1, ino: 3, uid: 501, mode: 0o100700, nlink: 1, size: 1, mtimeMs: 1, ctimeMs: 1 },
    parents: [root],
  },
  sourcePins: [
    {
      id: 'config-source-' + 'd'.repeat(24),
      scope: 'user',
      path: '/fixture/config.toml',
      root,
      sha256: 'absent',
      file: null,
      directories: [root],
    },
  ],
};
const copy = (v) => structuredClone(v);
function result(binding) {
  return {
    scope: 'isolated-permission-copy',
    outcome: 'passed',
    nativeBinarySha256: binding.nativeBinarySha256,
    profileCopySha256: binding.profileCopySha256,
    suiteSha256: binding.suiteSha256,
    nativeExitCode: 0,
    cleanupConfirmed: true,
    checks: ['tcp', 'unix'].map((id) => ({
      id,
      positiveConnections: 1,
      attempted: true,
      effect: 'denied',
      connections: 0,
      errno: 'EPERM',
    })),
    modelCalls: 0,
    providerCalls: 0,
  };
}
async function fixture(t, extra = {}) {
  const writes = [],
    calls = [];
  let starts = 0,
    current = copy(preparation),
    finish;
  let retained = copy(extra.runs ?? []);
  const store = {
    runs: copy(retained),
    refresh: async () => {
      await extra.beforeRefresh?.();
      return copy(retained);
    },
    state: () => ({ status: 'ready' }),
    prepare: async () => {
      await extra.beforeStorePrepare?.();
      return true;
    },
    write: async (rows) => {
      await extra.beforeWrite?.(rows);
      writes.push(copy(rows));
      retained = copy(rows);
      return true;
    },
  };
  const inventory = {
    codexNetworkRuntime: async () => sha,
    codexNetworkOperation: async (op, data) => {
      calls.push({ op, data });
      if (op === 'codex-network-check-prepare') await extra.beforePrepare?.();
      if (
        op === 'codex-network-check-prepare' &&
        JSON.stringify(data) !==
          JSON.stringify({ request: { controlContextId: context, captureSha256: sha } })
      )
        return { status: 409, body: { error: 'codex-network-stale' } };
      return {
        status: 200,
        body: op === 'codex-network-state' ? { controlContextId: context } : copy(current),
      };
    },
  };
  const run = async (input, options) => {
    starts++;
    options.onProgress('native');
    if (extra.wait)
      return new Promise((resolve, reject) => {
        finish = () => reject(Error(extra.cleanupFailure ? 'cleanup-failed' : 'cancelled'));
        options.signal.addEventListener('abort', () => setTimeout(finish, 20), { once: true });
      });
    return result(
      extra.binding ?? {
        ...input.binding,
        profileCopySha256: extra.copySha,
        suiteSha256: extra.suiteSha,
      },
    );
  };
  const service = await createCodexNetworkCheckService({
    workspaceId: workspace,
    inventory,
    store,
    run,
    acquireLease:
      extra.acquireLease ??
      (async () => ({ assertCurrent: async () => {}, release: async () => {} })),
  });
  t.after(() => service.close());
  const preview = async () => {
    const response = await service.preview({ controlContextId: context, captureSha256: sha });
    assert.equal(response.status, 200);
    extra.copySha = response.body.binding.profileCopySha256;
    extra.suiteSha = response.body.binding.suiteSha256;
    return response.body;
  };
  return {
    service,
    writes,
    calls,
    preview,
    starts: () => starts,
    change: () => {
      current.sourcePins[0].sha256 = 'e'.repeat(64);
      current.sourcePins[0].file = copy(current.native.file);
    },
  };
}
test('passive history and one-use Preview never execute native or write history', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.service.read()).status, 200);
  const p = await f.preview();
  assert.equal(f.starts(), 0);
  assert.equal(f.writes.length, 0);
  assert.equal(p.modelCalls, 0);
  assert.equal(JSON.stringify(p).includes('/fixture'), false);
  assert.equal(
    (await f.service.start({ previewId: p.id, controlContextId: context, command: 'evil' })).status,
    400,
  );
  assert.equal((await f.service.start({ previewId: p.id, controlContextId: context })).status, 409);
});
test('exact Start persists known job before launch and exposes only validated historical copy result', async (t) => {
  const f = await fixture(t),
    p = await f.preview(),
    started = await f.service.start({ previewId: p.id, controlContextId: context });
  assert.equal(started.status, 200);
  assert.equal(started.body.id, p.jobId);
  assert.equal(started.body.operationId, p.operationId);
  assert.equal(f.writes[0][0].status, 'running');
  await f.service.wait();
  const state = (await f.service.read()).body;
  assert.equal(state.jobs[0].status, 'completed');
  assert.equal(state.jobs[0].result.outcome, 'passed');
  assert.equal(f.starts(), 1);
  assert.equal((await f.service.start({ previewId: p.id, controlContextId: context })).status, 409);
});
test('source metadata drift consumes Preview and refuses before launch/history write', async (t) => {
  const f = await fixture(t),
    p = await f.preview();
  f.change();
  const r = await f.service.start({ previewId: p.id, controlContextId: context });
  assert.equal(r.body.error, 'codex-network-check-stale');
  assert.equal(f.starts(), 0);
  assert.equal(f.writes.length, 0);
});
test('Cancel waits for cleanup and binds exact job, operation, and context', async (t) => {
  const f = await fixture(t, { wait: true }),
    p = await f.preview();
  await f.service.start({ previewId: p.id, controlContextId: context });
  assert.equal(
    (
      await f.service.cancel({
        jobId: p.jobId,
        operationId: p.operationId,
        controlContextId: 'codex-context-' + '0'.repeat(64),
      })
    ).status,
    409,
  );
  const cancelled = await f.service.cancel({
    jobId: p.jobId,
    operationId: p.operationId,
    controlContextId: context,
  });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.status, 'cancelled');
  assert.equal(cancelled.body.result, null);
});
test('cleanup failure wins over cancellation and cannot become a passed report', async (t) => {
  const f = await fixture(t, { wait: true, cleanupFailure: true }),
    p = await f.preview();
  await f.service.start({ previewId: p.id, controlContextId: context });
  const r = await f.service.cancel({
    jobId: p.jobId,
    operationId: p.operationId,
    controlContextId: context,
  });
  assert.equal(r.body.status, 'failed');
  assert.equal(r.body.error, 'codex-network-check-cleanup-failed');
  assert.equal(r.body.result, null);
});

test('closing during Start preparation cannot launch a native job after shutdown', async (t) => {
  const extra = {},
    f = await fixture(t, extra),
    p = await f.preview();
  let release, entered;
  const seen = new Promise((r) => {
    entered = r;
  });
  extra.beforePrepare = () =>
    new Promise((r) => {
      release = r;
      entered();
    });
  const starting = f.service.start({ previewId: p.id, controlContextId: context });
  await seen;
  const closing = f.service.close();
  release();
  const response = await starting;
  await closing;
  assert.equal(response.status, 503);
  assert.equal(f.starts(), 0);
  assert.equal(f.writes.length, 0);
});

test('closing during storage admission cannot execute a job after shutdown', async (t) => {
  const extra = {},
    f = await fixture(t, extra),
    p = await f.preview();
  let release, entered;
  const seen = new Promise((r) => {
    entered = r;
  });
  extra.beforeStorePrepare = () =>
    new Promise((r) => {
      release = r;
      entered();
    });
  const starting = f.service.start({ previewId: p.id, controlContextId: context });
  await seen;
  const closing = f.service.close();
  release();
  const response = await starting;
  await closing;
  assert.equal(response.status, 503);
  assert.equal(f.starts(), 0);
  assert.equal(f.writes.length, 0);
});

test('opening a second console cannot mark another console running check as stopped', async (t) => {
  const f = await fixture(t, { wait: true }),
    p = await f.preview();
  await f.service.start({ previewId: p.id, controlContextId: context });
  const retained = copy(f.writes[0]),
    writes = [];
  const observer = await createCodexNetworkCheckService({
    workspaceId: workspace,
    inventory: {
      codexNetworkRuntime: async () => sha,
      codexNetworkOperation: async () => ({ status: 200, body: { controlContextId: context } }),
    },
    store: {
      runs: retained,
      refresh: async () => copy(retained),
      state: () => ({ status: 'ready' }),
      prepare: async () => true,
      write: async (rows) => {
        writes.push(copy(rows));
        return true;
      },
    },
    run: async () => {
      throw Error('must-not-run');
    },
    acquireLease: async () => null,
  });
  t.after(() => observer.close());
  assert.equal(writes.length, 0);
  assert.equal((await observer.read()).body.jobs[0].status, 'running');
});

test('busy lease refuses before job publication and consumes the known preview', async (t) => {
  const f = await fixture(t, { acquireLease: async () => null }),
    p = await f.preview();
  assert.equal(
    (await f.service.start({ previewId: p.id, controlContextId: context })).body.error,
    'codex-network-check-busy',
  );
  assert.equal(f.starts(), 0);
  assert.equal(f.writes.length, 0);
  assert.equal(
    (await f.service.start({ previewId: p.id, controlContextId: context })).body.error,
    'codex-network-check-stale',
  );
});

test('terminal success stays unpublished in memory and the lease stays held until durable publication', async (t) => {
  let releaseWrite,
    enteredWrite,
    released = false;
  const seen = new Promise((r) => {
    enteredWrite = r;
  });
  const f = await fixture(t, {
      acquireLease: async () => ({
        assertCurrent: async () => {
          assert.equal(released, false);
        },
        release: async () => {
          released = true;
        },
      }),
      beforeWrite: (rows) =>
        rows[0].status === 'completed'
          ? new Promise((r) => {
              releaseWrite = r;
              enteredWrite();
            })
          : undefined,
    }),
    p = await f.preview();
  await f.service.start({ previewId: p.id, controlContextId: context });
  await seen;
  try {
    const state = (await f.service.read()).body;
    assert.equal(state.jobs[0].status, 'running');
    assert.equal(state.jobs[0].result, null);
    assert.equal(state.ownedJobId, p.jobId);
    assert.equal(released, false);
  } finally {
    releaseWrite();
    await f.service.wait();
  }
  assert.equal(released, true);
  assert.equal((await f.service.read()).body.jobs[0].status, 'completed');
});
