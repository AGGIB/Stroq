import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after } from 'node:test';
import { build } from 'tsup';
import { createRunStore } from './run-store.mjs';
import { acquireWorkspaceMonitorLease } from './workspace-monitor-lease.mjs';

const output = await realpath(await mkdtemp(join(tmpdir(), 'stroq-network-ownership-build-')));
after(() => rm(output, { recursive: true, force: true }));
await build({
  entry: {
    service: join(import.meta.dirname, 'codex-network-check-service.ts'),
    schema: join(import.meta.dirname, '../lib/codex-network-check.ts'),
    protocol: join(import.meta.dirname, 'codex-network-check-protocol.ts'),
  },
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
export { createCodexNetworkCheckService };
export const schemaURL = pathToFileURL(join(output, 'schema.mjs')).href;
const schema = await import(schemaURL);
const protocol = await import(pathToFileURL(join(output, 'protocol.mjs')).href);
export const sha = 'a'.repeat(64),
  context = 'codex-context-' + 'b'.repeat(64),
  workspace = 'workspace-' + 'c'.repeat(24);
const root = { path: '/fixture', dev: 1, ino: 2, uid: 501, mode: 0o40700 };
export const preparation = {
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
export const binding = {
  ...preparation.binding,
  workspaceId: workspace,
  profileCopySha256: protocol.getProfileCopySha(preparation),
  suiteSha256: protocol.getSuiteSha(),
  copyKind: 'profile',
};
export function result() {
  return {
    scope: 'isolated-permission-copy',
    outcome: 'passed',
    nativeBinarySha256: sha,
    profileCopySha256: binding.profileCopySha256,
    suiteSha256: binding.suiteSha256,
    nativeExitCode: 0,
    cleanupConfirmed: true,
    modelCalls: 0,
    providerCalls: 0,
    checks: ['tcp', 'unix'].map((id) => ({
      id,
      positiveConnections: 1,
      attempted: true,
      effect: 'denied',
      connections: 0,
      errno: 'EPERM',
    })),
  };
}
export const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
export function runningJob() {
  return {
    schema: 'stroq-codex-network-check-job/1',
    id: randomUUID(),
    operationId: randomUUID(),
    binding,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    status: 'running',
    progress: 'preparing',
    error: null,
    result: null,
  };
}
export async function fixture(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'stroq-network-ownership-'))),
    home = join(base, 'state');
  await mkdir(home, { mode: 0o700 });
  const storeId = 'e'.repeat(64),
    leaseId = 'f'.repeat(64),
    controllers = [],
    gates = [],
    children = [];
  const history = join(home, 'console', `codex-network-checks-${storeId}.json`),
    leasePath = join(home, 'console', 'workspace-monitor-leases', `${leaseId}.lock`);
  const acquire = () => acquireWorkspaceMonitorLease({ home, storeId: leaseId });
  t.after(async () => {
    for (const gate of gates) gate.resolve();
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await new Promise((resolve) => child.once('exit', resolve));
      }
    await Promise.allSettled(controllers.map((c) => c.service.close()));
    await rm(base, { recursive: true, force: true });
  });
  async function controller({ wait = false, terminalGate = false } = {}) {
    const store = await createRunStore({
      home,
      workspaceId: storeId,
      namespace: 'codex-network-checks',
      loadValidator: async () => ({
        validateRun: (j) =>
          schema.validateCodexNetworkCheckJob(j) && j.binding.workspaceId === workspace,
      }),
    });
    assert.equal(store.state().status, 'ready');
    const ready = deferred(),
      beginCleanup = deferred(),
      cleaning = deferred(),
      finishCleanup = deferred(),
      publishing = deferred(),
      finishPublish = deferred();
    gates.push(beginCleanup, finishCleanup, finishPublish);
    let starts = 0,
      signal;
    const observedStore = {
      ...store,
      write: async (rows) => {
        if (rows[0]?.status !== 'running') {
          publishing.resolve();
          if (terminalGate) await finishPublish.promise;
        }
        return store.write(rows);
      },
    };
    const inventory = {
      codexNetworkRuntime: async () => sha,
      codexNetworkOperation: async (op, data) => {
        if (op === 'codex-network-check-prepare')
          assert.deepEqual(data, { request: { controlContextId: context, captureSha256: sha } });
        return {
          status: 200,
          body:
            op === 'codex-network-state'
              ? { controlContextId: context }
              : structuredClone(preparation),
        };
      },
    };
    const service = await createCodexNetworkCheckService({
      workspaceId: workspace,
      inventory,
      store: observedStore,
      acquireLease: acquire,
      run: async (_input, options) => {
        starts++;
        signal = options.signal;
        ready.resolve();
        options.onProgress('native');
        if (wait) {
          await beginCleanup.promise;
          options.onProgress('cleanup');
          cleaning.resolve();
          await finishCleanup.promise;
        }
        return result();
      },
    });
    const preview = async () => {
      const r = await service.preview({ controlContextId: context, captureSha256: sha });
      assert.equal(r.status, 200);
      return r.body;
    };
    const start = (p) => service.start({ previewId: p.id, controlContextId: context });
    const value = {
      service,
      store,
      preview,
      start,
      ready,
      beginCleanup,
      cleaning,
      finishCleanup,
      publishing,
      finishPublish,
      starts: () => starts,
      signal: () => signal,
    };
    controllers.push(value);
    return value;
  }
  return { base, home, storeId, leaseId, history, leasePath, acquire, controller, children };
}
