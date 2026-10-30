import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'tsup';
const output = await realpath(await mkdtemp(join(tmpdir(), 'stroq-path-service-unit-')));
after(() => rm(output, { recursive: true, force: true }));
await build({
  entry: { service: join(import.meta.dirname, 'codex-path-service.ts') },
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
const { createCodexPathGuardService } = await import(
  pathToFileURL(join(output, 'service.mjs')).href
);
function fixture() {
  const calls = [],
    runtime = 'e'.repeat(64);
  let hold = null;
  const inventory = {
    codexPathGuardRuntime: async () => runtime,
    codexPathGuardOperation: async (op, data, options) => {
      calls.push({ op, data, options });
      return hold ? await hold : { status: 200, body: { marker: 'transport-sentinel' } };
    },
  };
  return {
    calls,
    inventory,
    runtime,
    service: createCodexPathGuardService({ inventory }),
    hold(p) {
      hold = p;
    },
  };
}
test('read and capture use fixed operations without automatic write/native actions', async () => {
  const f = fixture();
  await f.service.read();
  await f.service.capture({});
  assert.deepEqual(
    f.calls.map((c) => c.op),
    ['codex-path-state', 'codex-path-capture'],
  );
  assert(f.calls.every((c) => !c.options?.writer));
  await f.service.close();
});
test('closed inputs refuse arbitrary paths and unbound requests before worker admission', async () => {
  const f = fixture();
  for (const reply of [
    await f.service.capture({ path: '/private/credential' }),
    await f.service.preview({ path: '/private/credential' }),
    await f.service.recheck({ recordId: 'any' }),
    await f.service.apply({ previewId: 'any' }),
  ])
    assert([400, 409].includes(reply.status));
  assert.equal(f.calls.length, 0);
  await f.service.close();
});
test('shared slot refuses concurrent work and close waits for admitted read', async () => {
  const f = fixture();
  let release;
  f.hold(
    new Promise((r) => {
      release = r;
    }),
  );
  const reading = f.service.read();
  await Promise.resolve();
  assert.equal((await f.service.capture({})).body.error, 'codex-path-guard-busy');
  let ended = false;
  const closing = f.service.close().then(() => {
    ended = true;
  });
  await Promise.resolve();
  assert.equal(ended, false);
  release({ status: 200, body: {} });
  await reading;
  await closing;
  assert.equal((await f.service.read()).status, 503);
});
const { createPathGuardPrivatePlanFixture, privateSchema } =
  await import('./codex-path-guard-private.test-helpers.mjs');
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function plannedFixture(t, { operation = 'guard' } = {}) {
  let clock = Date.now(),
    plan = createPathGuardPrivatePlanFixture({ operation, now: clock }),
    runtime = plan.capture.binding.runtimeSha256;
  const calls = [],
    control = { beforeRuntime: null, readGate: null, applyError: null };
  const inventory = {
    codexPathGuardRuntime: async () => {
      await control.beforeRuntime?.();
      return runtime;
    },
    codexPathGuardOperation: async (op, data, options) => {
      calls.push({ op, data, options });
      if (op === 'codex-path-preview')
        return {
          status: 200,
          body: { preview: structuredClone(plan.preview), privatePlan: structuredClone(plan) },
        };
      if (op === 'codex-path-state' && control.readGate) return await control.readGate;
      if (op === 'codex-path-apply' && control.applyError) throw control.applyError;
      return { status: 200, body: { writeConfirmed: true } };
    },
  };
  const service = createCodexPathGuardService({ inventory, now: () => clock });
  t.after(() => service.close());
  return {
    service,
    calls,
    control,
    get plan() {
      return plan;
    },
    stage(options = {}) {
      plan = createPathGuardPrivatePlanFixture({ operation, now: clock, ...options });
      return plan;
    },
    runtime(value) {
      runtime = value;
    },
    advance(ms) {
      clock += ms;
    },
    preview() {
      return service.preview(plan.request);
    },
    confirm(preview = plan.preview) {
      return {
        previewId: preview.id,
        controlContextId: preview.controlContextId,
        acknowledgeSharedUserConfig: true,
        acknowledgeRetention: true,
        ...(preview.operation === 'restore' ? { acknowledgeWeakening: true } : {}),
      };
    },
  };
}
test('real private-plan validator is used, public preview hides config bytes and path metadata', async (t) => {
  const f = plannedFixture(t);
  assert.equal(privateSchema.validateCodexPathGuardPrivatePlan(f.plan), true);
  const r = await f.preview();
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, f.plan.preview);
  assert.notEqual(r.body.id, r.body.operationId);
  assert.equal(Object.hasOwn(r.body, 'privatePlan'), false);
  assert.doesNotMatch(JSON.stringify(r.body), /fixture\/user|default_permissions|targetPath/);
});
test('one-use guard Apply forwards exact private plan, deadline and runtime to shared writer', async (t) => {
  const f = plannedFixture(t),
    p = (await f.preview()).body;
  assert.equal((await f.service.apply(f.confirm(p))).status, 200);
  const write = f.calls.at(-1);
  assert.equal(write.op, 'codex-path-apply');
  assert.equal(write.options.writer, true);
  assert.equal(write.options.expectedRuntime, f.plan.capture.binding.runtimeSha256);
  assert.equal(write.options.deadline, Date.parse(p.expiresAt));
  assert.deepEqual(write.data.privatePlan, structuredClone(f.plan));
  assert.equal(write.data.writerLockHeld, undefined);
  assert.equal((await f.service.apply(f.confirm(p))).status, 409);
  assert.equal(f.calls.filter((c) => c.op === 'codex-path-apply').length, 1);
});
test('recognized preview is consumed before malformed consent, foreign context or extra path fields', async (t) => {
  const f = plannedFixture(t);
  for (const patch of [
    { acknowledgeRetention: false },
    { controlContextId: 'codex-context-' + 'f'.repeat(64) },
    { path: '/private/credential' },
    { acknowledgeWeakening: true },
  ]) {
    const p = (await f.preview()).body;
    assert.equal((await f.service.apply({ ...f.confirm(p), ...patch })).status, 400);
    assert.equal((await f.service.apply(f.confirm(p))).body.error, 'codex-path-guard-stale');
  }
  assert.equal(f.calls.filter((c) => c.op === 'codex-path-apply').length, 0);
});
test('Restore requires weakening in its closed shape and preserves private exact operation', async (t) => {
  const f = plannedFixture(t, { operation: 'restore' }),
    p = (await f.preview()).body,
    body = f.confirm(p);
  delete body.acknowledgeWeakening;
  assert.equal((await f.service.apply(body)).status, 400);
  assert.equal((await f.service.apply(f.confirm(p))).status, 409);
  const q = (await f.preview()).body;
  assert.equal((await f.service.apply(f.confirm(q))).status, 200);
  assert.equal(f.calls.at(-1).data.acknowledgeWeakening, true);
  assert.equal(f.calls.at(-1).data.privatePlan.preview.operationId, q.operationId);
});
test('busy admission consumes the recognized preview before returning busy', async (t) => {
  const f = plannedFixture(t),
    p = (await f.preview()).body;
  let release;
  f.control.readGate = new Promise((r) => {
    release = r;
  });
  const reading = f.service.read();
  await Promise.resolve();
  assert.equal((await f.service.apply(f.confirm(p))).body.error, 'codex-path-guard-busy');
  release({ status: 200, body: {} });
  await reading;
  assert.equal((await f.service.apply(f.confirm(p))).body.error, 'codex-path-guard-stale');
  assert.equal(f.calls.filter((c) => c.op === 'codex-path-apply').length, 0);
});
test('expiry, runtime changes and worker errors cannot replay a known preview', async (t) => {
  for (const mode of ['expired', 'runtime', 'worker']) {
    await t.test(mode, async (t) => {
      const f = plannedFixture(t),
        p = (await f.preview()).body;
      if (mode === 'expired') f.advance(120000);
      if (mode === 'runtime') f.runtime('b'.repeat(64));
      if (mode === 'worker') f.control.applyError = Error('PRIVATE_SENTINEL');
      const r = await f.service.apply(f.confirm(p));
      assert([409, 503].includes(r.status));
      assert.doesNotMatch(JSON.stringify(r), /PRIVATE_SENTINEL/);
      assert.equal((await f.service.apply(f.confirm(p))).body.error, 'codex-path-guard-stale');
      assert.equal(
        f.calls.filter((c) => c.op === 'codex-path-apply').length,
        mode === 'worker' ? 1 : 0,
      );
    });
  }
});
test('preview slots are capped at eight and expiry frees them without worker retries', async (t) => {
  const f = plannedFixture(t);
  for (let i = 0; i < 8; i++) {
    f.stage({ recordId: uuid(20 + i), operationId: uuid(40 + i), previewId: uuid(60 + i) });
    assert.equal((await f.preview()).status, 200);
  }
  const count = f.calls.length;
  f.stage({ recordId: uuid(99), operationId: uuid(98), previewId: uuid(97) });
  assert.equal((await f.preview()).body.error, 'codex-path-guard-store-full');
  assert.equal(f.calls.length, count);
  f.advance(120001);
  f.stage({ previewId: uuid(96) });
  assert.equal((await f.preview()).status, 200);
});
test('aggregate private configuration storage is bounded using actual private-plan accounting', async (t) => {
  const f = plannedFixture(t),
    sources = [];
  for (let i = 0; i < 20; i++) {
    const source = structuredClone(f.plan.capture.sources[0]);
    source.id = 'config-source-' + i.toString(16).padStart(24, '0');
    source.snapshot.bytes = new Uint8Array(256 * 1024);
    source.snapshot.file.size = source.snapshot.bytes.byteLength;
    sources.push(source);
  }
  f.plan.capture.sources = structuredClone(sources);
  f.plan.capture.base.sources = structuredClone(sources);
  assert.equal(privateSchema.validateCodexPathGuardPrivatePlan(f.plan), true);
  assert(privateSchema.codexPathGuardPrivatePlanBytes(f.plan) > 8 * 1024 * 1024);
  assert.equal((await f.preview()).body.error, 'codex-path-guard-store-full');
});
test('worker preview mismatch, duplicate IDs and mismatched runtime cannot replace saved plans', async (t) => {
  const f = plannedFixture(t),
    request = { ...f.plan.request, presetId: 'npmrc' };
  assert.equal((await f.service.preview(request)).status, 503);
  assert.equal((await f.preview()).status, 200);
  assert.equal((await f.preview()).body.error, 'codex-path-guard-stale');
  assert.equal((await f.service.apply(f.confirm())).status, 200);
  f.stage({ previewId: uuid(90) });
  f.runtime('b'.repeat(64));
  assert.equal((await f.preview()).body.error, 'codex-path-guard-runtime-changed');
});
test('input is cloned before preview admission and later response mutation cannot change the write', async (t) => {
  const f = plannedFixture(t),
    request = { ...f.plan.request };
  const pending = f.service.preview(request);
  request.presetId = 'npmrc';
  const p = (await pending).body;
  assert.equal(p.presetId, 'aws-credentials');
  const before = f.plan.candidate[0];
  f.plan.candidate[0] = 255;
  assert.equal((await f.service.apply(f.confirm(p))).status, 200);
  assert.equal(f.calls.at(-1).data.privatePlan.candidate[0], before);
});
test('shutdown while Apply awaits runtime consumes plan and never invokes writer after closing', async (t) => {
  const f = plannedFixture(t),
    p = (await f.preview()).body;
  let release, entered;
  const seen = new Promise((r) => {
    entered = r;
  });
  f.control.beforeRuntime = () =>
    new Promise((r) => {
      release = r;
      entered();
    });
  const applying = f.service.apply(f.confirm(p));
  await seen;
  let ended = false;
  const closing = f.service.close().then(() => {
    ended = true;
  });
  await Promise.resolve();
  assert.equal(ended, false);
  release();
  assert.equal((await applying).status, 503);
  await closing;
  assert.equal(f.calls.filter((c) => c.op === 'codex-path-apply').length, 0);
});
test('recheck forwards only exact record operation under the shared writer lease', async (t) => {
  const f = plannedFixture(t),
    request = {
      controlContextId: f.plan.preview.controlContextId,
      recordId: f.plan.preview.recordId,
      recordRevision: 'a'.repeat(64),
      operationId: f.plan.preview.operationId,
    };
  assert.equal((await f.service.recheck(request)).status, 200);
  assert.deepEqual(f.calls.at(-1), {
    op: 'codex-path-recheck',
    data: { request },
    options: { writer: true },
  });
  assert.equal((await f.service.recheck({ ...request, path: '/private/credential' })).status, 400);
});
test('non-plain empty objects cannot bypass closed Capture input', async () => {
  const f = fixture();
  for (const input of [new Date(), new Map(), Object.create({ path: 'PRIVATE' })])
    assert.equal((await f.service.capture(input)).status, 400);
  assert.equal(f.calls.length, 0);
  await f.service.close();
});
