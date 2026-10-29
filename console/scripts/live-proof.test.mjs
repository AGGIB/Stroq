import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLiveProofService } from './live-proof-service.mjs';

const VERSION = '0.28.0';
const SHA = 'a'.repeat(64);
const report = (state = 'inconclusive') => ({
  state,
  mode: 'live',
  hostVersion: '2.1.271',
  requestsMade: 1,
  probes: [],
  caveats: [],
  advice: [],
});
function fixture(overrides = {}) {
  const calls = [];
  let clock = Date.parse('2026-10-23T10:00:00.000Z');
  let runtime = SHA;
  let policy = SHA;
  let host = '2.1.271';
  const service = createLiveProofService({
    platform: 'darwin',
    now: () => clock,
    available: async () => ({ available: true, version: VERSION }),
    fingerprint: async () => runtime,
    inspect: async () => ({ policySha256: policy, proofs: {} }),
    detect: async () => ({ available: true, version: host }),
    run: async (input, options) => {
      calls.push({ input, options });
      return report();
    },
    ...overrides,
  });
  return {
    service,
    calls,
    advance: (n) => (clock += n),
    changeRuntime: () => (runtime = 'b'.repeat(64)),
    changePolicy: () => (policy = 'b'.repeat(64)),
    changeHost: () => (host = '2.1.272'),
  };
}
async function plan(f) {
  return (await (await f.service).preview({ agent: 'claude-code', maxRequests: 3 })).body;
}
async function start(f, preview) {
  return (await f.service).start({
    previewId: preview.id,
    acknowledgeSubscriptionUsage: true,
    maxRequests: 3,
  });
}
async function terminal(service, id) {
  for (let i = 0; i < 100; i++) {
    const job = service.getJob(id);
    if (job.status !== 'running') return job;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('fixture job did not finish');
}

test('offline GET does not detect a host or spend a request', async () => {
  const f = fixture({
    detect: async () => {
      throw new Error('must not detect');
    },
  });
  const service = await f.service;
  assert.equal((await service.getState()).target, 'isolated-host');
  assert.equal(f.calls.length, 0);
  await service.close();
});
test('preview discloses cap and isolated target; explicit matching acknowledgement starts one job', async () => {
  const f = fixture();
  const service = await f.service;
  const preview = await plan(f);
  assert.equal(preview.canStart, true);
  assert.equal(preview.target, 'isolated-host');
  assert.equal(preview.disclosure.maxRequests, 3);
  assert.equal(preview.disclosure.externalRequests, true);
  assert.equal(f.calls.length, 0);
  const started = await start(f, preview);
  assert.equal(started.status, 202);
  const job = await terminal(service, started.body.id);
  assert.equal(job.status, 'completed');
  assert.equal(job.result.state, 'inconclusive');
  assert.equal(f.calls.length, 1);
  assert.equal((await start(f, preview)).status, 409);
  await service.close();
});
test('closed bounded inputs reject arbitrary commands, paths, unknown agent and invalid budgets', async () => {
  const service = await fixture().service;
  for (const input of [
    null,
    {},
    { agent: 'cursor', maxRequests: 3 },
    { agent: 'claude-code', maxRequests: 2 },
    { agent: 'claude-code', maxRequests: 7 },
    { agent: 'claude-code', maxRequests: '3' },
    { agent: 'claude-code', maxRequests: 3, command: 'echo x' },
    { agent: 'claude-code', maxRequests: 3, scope: 'user' },
  ]) {
    assert.equal((await service.preview(input)).status, 400);
  }
  await service.close();
});
test('absent consent, changed cap and additional properties never spend', async () => {
  const f = fixture();
  const service = await f.service;
  const p = await plan(f);
  for (const input of [
    { previewId: p.id, maxRequests: 3 },
    { previewId: p.id, maxRequests: 3, acknowledgeSubscriptionUsage: false },
    { previewId: p.id, maxRequests: 4, acknowledgeSubscriptionUsage: true },
    { previewId: p.id, maxRequests: 3, acknowledgeSubscriptionUsage: true, command: 'x' },
  ])
    assert.equal((await service.start(input)).status, 400);
  assert.equal(f.calls.length, 0);
  await service.close();
});
for (const mutation of ['changeRuntime', 'changePolicy', 'changeHost'])
  test(`stale preview refuses ${mutation} before spending`, async () => {
    const f = fixture();
    const service = await f.service;
    const p = await plan(f);
    f[mutation]();
    const result = await start(f, p);
    assert.equal(result.status, 409);
    assert.equal(result.body.error, 'preview-stale');
    assert.equal(f.calls.length, 0);
    await service.close();
  });
test('expired preview and missing host never start a live request', async () => {
  const f = fixture();
  const service = await f.service;
  const p = await plan(f);
  f.advance(120001);
  assert.equal((await start(f, p)).body.error, 'preview-expired');
  assert.equal(f.calls.length, 0);
  await service.close();
  const missing = fixture({ detect: async () => ({ available: false, version: null }) });
  const ms = await missing.service;
  assert.equal((await plan(missing)).canStart, false);
  assert.equal(missing.calls.length, 0);
  await ms.close();
});
test('Codex on unmeasured POSIX platform does not invoke detect', async () => {
  const f = fixture({
    detect: async () => {
      throw new Error('must not detect');
    },
  });
  const service = await f.service;
  const p = await service.preview({ agent: 'codex', maxRequests: 3 });
  assert.equal(p.body.reason, 'platform-unmeasured');
  assert.equal(p.body.canStart, false);
  await service.close();
});
test('cancellation and shutdown abort active runner and await its cleanup', async () => {
  let cleanup = false;
  let started = false;
  const f = fixture({
    run: (_input, { signal }) =>
      new Promise((_resolve, reject) => {
        started = true;
        signal.addEventListener(
          'abort',
          () => {
            setImmediate(() => {
              cleanup = true;
              reject(new Error('cancelled'));
            });
          },
          { once: true },
        );
      }),
  });
  const service = await f.service;
  const p = await plan(f);
  const result = await start(f, p);
  while (!started) await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await service.preview({ agent: 'claude-code', maxRequests: 3 })).status, 409);
  const cancelled = await service.cancel({ jobId: result.body.id });
  assert.equal(cancelled.status, 200);
  assert.equal(cleanup, true);
  assert.equal(service.getJob(result.body.id).status, 'cancelled');
  await service.close();
  assert.equal((await service.preview({ agent: 'claude-code', maxRequests: 3 })).status, 503);
});
test('runner errors expose only a fixed error code and omit raw host output', async () => {
  const f = fixture({
    run: async () => {
      throw new Error('secret-user-token /private/path');
    },
  });
  const service = await f.service;
  const p = await plan(f);
  const started = await start(f, p);
  const job = await terminal(service, started.body.id);
  assert.equal(job.status, 'failed');
  assert.equal(job.error, 'live-check-failed');
  assert.doesNotMatch(JSON.stringify(await service.getState()), /secret-user-token|private\/path/);
  await service.close();
});

test('concurrent GETs share one bounded offline inspection and cached reads keep job state current', async () => {
  let inspections = 0;
  let release;
  const f = fixture({
    inspect: () => {
      inspections++;
      return new Promise((resolve) => {
        release = () => resolve({ policySha256: SHA, proofs: {} });
      });
    },
  });
  const service = await f.service;
  const reads = Array.from({ length: 30 }, () => service.getState());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(inspections, 1);
  release();
  const states = await Promise.all(reads);
  assert.equal(states.length, 30);
  assert.equal(inspections, 1);
  const cached = await service.getState();
  assert.equal(inspections, 1);
  cached.agents[0].supported = false;
  assert.equal((await service.getState()).agents[0].supported, true);
  await service.close();
});
