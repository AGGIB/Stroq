import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { serialize } from 'node:v8';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'tsup';

const output = await mkdtemp(join(tmpdir(), 'stroq-taint-service-build-'));
after(() => rm(output, { recursive: true, force: true }));
await build({
  entry: { control: join(import.meta.dirname, 'session-taint-control.ts') },
  outDir: output,
  outExtension: () => ({ js: '.mjs' }),
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  splitting: false,
  config: false,
  dts: false,
  silent: true,
});
const { createSessionTaintControl } = await import(pathToFileURL(join(output, 'control.mjs')).href);
const evidence = 'a'.repeat(64),
  revision = 'b'.repeat(64),
  id = `incident-${evidence}`;

test('closed requests refuse browser authority and missing acknowledgements before context or worker access', async (t) => {
  let touched = 0;
  const control = await createSessionTaintControl({
    context: {
      current() {
        touched++;
        throw Error('PRIVATE_CONTEXT');
      },
    },
  });
  t.after(() => control.close());
  for (const [method, request] of [
    ['inspect', { id, expectedEvidenceSha: evidence, sessionId: 'RAW-SESSION' }],
    ['inspect', { id: 'incident-' + revision, expectedEvidenceSha: evidence }],
    ['inspect', { id, expectedEvidenceSha: evidence, path: '/private/sessions' }],
    ['preview', { id, expectedEvidenceSha: evidence }],
    ['preview', { id, expectedEvidenceSha: evidence, expectedRevisionSha256: revision, all: true }],
    [
      'clear',
      { previewId: '12345678-1234-1234-1234-123456789abc', acknowledgeWeakenRestrictions: true },
    ],
    [
      'clear',
      {
        previewId: '12345678-1234-1234-1234-123456789abc',
        acknowledgeWeakenRestrictions: true,
        acknowledgeRecoveryRetention: true,
        sessionId: 'RAW-SESSION',
      },
    ],
    ['recheck', { recordId: '../sessions' }],
  ])
    assert.equal((await control[method](request)).status, 400, method);
  assert.equal(touched, 0);
});

test('unavailable context produces finite errors without disclosing runtime details', async (t) => {
  const control = await createSessionTaintControl({
    context: {
      current() {
        throw Error('/PRIVATE/SECRET/STATE');
      },
    },
  });
  t.after(() => control.close());
  for (const [method, input] of [
    ['getState', undefined],
    ['inspect', { id, expectedEvidenceSha: evidence }],
    ['preview', { id, expectedEvidenceSha: evidence, expectedRevisionSha256: revision }],
    ['recheck', { recordId: '12345678-1234-1234-1234-123456789abc' }],
  ]) {
    const reply = await control[method](input);
    assert.equal(reply.status, 503);
    assert.equal(JSON.stringify(reply).includes('PRIVATE'), false);
  }
});

const workspaceId = 'workspace-' + 'c'.repeat(24),
  sessionRef = 'session-' + 'd'.repeat(64);
function inspection(at) {
  return {
    schema: 'stroq-session-taint-inspection/1',
    workspaceId,
    incident: { id, evidenceSha256: evidence, sequence: 7, recordedAt: '2026-10-24T00:00:00.000Z' },
    sessionRef,
    checkedAt: at,
    revisionSha256: revision,
    taint: {
      status: 'suspect',
      sources: 1,
      since: '2026-10-24T00:00:00.000Z',
      sha256: 'e'.repeat(64),
    },
    provenance: {
      sha256: 'f'.repeat(64),
      records: 2,
      suspect: 1,
      incomplete: false,
      digestsLost: false,
      pending: 0,
    },
  };
}
async function fixture(t, overrides = {}) {
  let clock = Date.parse('2026-10-24T00:01:00.000Z'),
    runtime = '1'.repeat(64),
    selected = 0,
    activeLocks = 0;
  const calls = [];
  const context = {
    workspaceId,
    storeId: '2'.repeat(64),
    project: '/synthetic/project',
    roots: { project: { path: '/synthetic/project' }, user: { path: '/synthetic/user' } },
    options: { home: '/synthetic/user/.stroq', paths: { cli: '/synthetic/runtime.js' } },
    current: async () => ({ engineVersion: '0.28.0', runtimeSha256: runtime }),
    assert: async (bound) => {
      if (bound.runtimeSha256 !== runtime) throw Error('stale-capture');
    },
  };
  const execute = async (operation, input, options) => {
    calls.push({ operation, input, options });
    if (overrides.execute)
      return overrides.execute(operation, input, options, { calls, activeLocks });
    const at = options.context.now,
      before = inspection(at);
    if (operation === 'taint-state')
      return {
        schema: 'stroq-session-taint/1',
        workspaceId,
        generatedAt: at,
        available: true,
        history: 'missing',
        error: null,
        records: [],
      };
    if (operation === 'taint-inspect') return before;
    if (operation === 'taint-preview') {
      const report = {
        schema: 'stroq-session-taint-preview/1',
        id: input.previewId,
        recordId: input.recordId,
        createdAt: at,
        expiresAt: new Date(input.expiresAt).toISOString(),
        inspection: before,
        weakensRestrictions: true,
        provenancePreserved: true,
        privateRecovery: true,
        hostEnforcement: false,
      };
      const plan = {
        schema: 'stroq-session-taint-plan/1',
        recordId: input.recordId,
        expiresAt: input.expiresAt,
        before,
        binding: {
          rawSession: 'PRIVATE-SESSION-SENTINEL',
          nativeBytes: Buffer.from('PRIVATE-RECOVERY-SENTINEL'),
        },
      };
      overrides.mutatePreview?.({ report, plan });
      return { report, plan };
    }
    if (operation === 'taint-apply' || operation === 'taint-recheck') {
      assert.equal(options.context.configurationLockHeld, true);
      assert.equal(activeLocks, 1, 'Real service admission encloses the whole worker lifetime');
      const record = {
        id: input.plan?.recordId ?? input.recordId,
        revisionSha256: '3'.repeat(64),
        createdAt: at,
        updatedAt: at,
        status: 'cleared',
        before: input.plan?.before ?? before,
        afterTaintSha256: '4'.repeat(64),
        preservedProvenanceSha256: 'f'.repeat(64),
        recoveryAvailable: true,
        current: {
          ...before,
          taint: { status: 'clear', sources: 0, since: null, sha256: '4'.repeat(64) },
          revisionSha256: '5'.repeat(64),
        },
        error: null,
      };
      const reply = {
        schema: 'stroq-session-taint-receipt/1',
        operation: operation === 'taint-apply' ? 'clear' : 'recheck',
        checkedAt: at,
        writeConfirmed: true,
        record,
      };
      overrides.mutateReceipt?.(reply);
      return reply;
    }
    throw Error('unexpected-fixture-operation');
  };
  const control = await createSessionTaintControl({
    context,
    execute,
    now: () => clock,
    selectEvidence: async (input) => {
      selected++;
      return (
        overrides.selectEvidence?.(input, selected) ?? { seq: 7, ts: '2026-10-24T00:00:00.000Z' }
      );
    },
    withLock: async (_context, action) => {
      activeLocks++;
      try {
        return await action();
      } finally {
        activeLocks--;
      }
    },
  });
  t.after(() => control.close());
  return {
    control,
    calls,
    context,
    advance(ms) {
      clock += ms;
    },
    setRuntime(value) {
      runtime = value;
    },
    selected: () => selected,
    locks: () => activeLocks,
    preview: () =>
      control.preview({ id, expectedEvidenceSha: evidence, expectedRevisionSha256: revision }),
  };
}
const consent = (previewId) => ({
  previewId,
  acknowledgeWeakenRestrictions: true,
  acknowledgeRecoveryRetention: true,
});
test('inspection privately selects exact journal metadata and never locks or exposes raw session material', async (t) => {
  const f = await fixture(t),
    reply = await f.control.inspect({ id, expectedEvidenceSha: evidence });
  assert.equal(reply.status, 200);
  assert.equal(reply.body.incident.sequence, 7);
  assert.equal(f.selected(), 2, 'Reselect after the worker before publishing inspection');
  assert.deepEqual(f.calls[0].input, {
    id,
    expectedEvidenceSha: evidence,
    sequence: 7,
    recordedAt: '2026-10-24T00:00:00.000Z',
  });
  assert.equal(f.calls[0].options.context.configurationLockHeld, false);
  assert.equal(f.locks(), 0);
});
test('private preview is consumed once and clear preserves exact receipt provenance under the configuration lock', async (t) => {
  const f = await fixture(t),
    preview = await f.preview();
  assert.equal(preview.status, 200, JSON.stringify(preview));
  assert.equal(JSON.stringify(preview).includes('PRIVATE-'), false);
  assert.equal(Date.parse(preview.body.expiresAt) - Date.parse(preview.body.createdAt), 120000);
  const receipt = await f.control.clear(consent(preview.body.id));
  assert.equal(receipt.status, 200, JSON.stringify(receipt));
  assert.equal(receipt.body.writeConfirmed, true);
  assert.equal(receipt.body.record.before.incident.id, id);
  assert.equal(JSON.stringify(receipt).includes('PRIVATE-'), false);
  assert.equal((await f.control.clear(consent(preview.body.id))).status, 409);
  const applied = f.calls.filter((c) => c.operation === 'taint-apply');
  assert.equal(applied.length, 1);
  // The person's two acknowledgements on this preview are what the clear is given, and records.
  assert.deepEqual(applied[0].input.confirmation, {
    weakensRestrictions: true,
    recoveryRetention: true,
    previewId: preview.body.id,
  });
  assert.equal(f.locks(), 0);
});
test('every clear attempt consumes its preview, including failed consent and runtime drift', async (t) => {
  const f = await fixture(t),
    first = await f.preview();
  assert.equal(first.status, 200);
  assert.equal(
    (await f.control.clear({ previewId: first.body.id, acknowledgeWeakenRestrictions: true }))
      .status,
    400,
  );
  assert.equal((await f.control.clear(consent(first.body.id))).status, 409);
  const second = await f.preview();
  assert.equal(second.status, 200);
  f.setRuntime('9'.repeat(64));
  assert.notEqual((await f.control.clear(consent(second.body.id))).status, 200);
  assert.equal((await f.control.clear(consent(second.body.id))).status, 409);
  assert.equal(
    f.calls.some((c) => c.operation === 'taint-apply'),
    false,
  );
});
test('expired previews and the ninth retained preview refuse without starting a clear', async (t) => {
  const f = await fixture(t),
    previews = [];
  for (let i = 0; i < 8; i++) {
    const reply = await f.preview();
    assert.equal(reply.status, 200);
    previews.push(reply.body.id);
  }
  assert.equal((await f.preview()).status, 409);
  f.advance(120000);
  assert.equal((await f.control.clear(consent(previews[0]))).status, 409);
  assert.equal((await f.preview()).status, 200);
  assert.equal(
    f.calls.some((c) => c.operation === 'taint-apply'),
    false,
  );
});
test('mismatched worker selection, plan identity and recovery receipt are refused', async (t) => {
  const badPlan = await fixture(t, {
    mutatePreview({ plan }) {
      plan.before.incident.sequence = 8;
    },
  });
  assert.notEqual((await badPlan.preview()).status, 200);
  const badWorkspace = await fixture(t, {
    mutatePreview({ report }) {
      report.inspection.workspaceId = 'workspace-' + '9'.repeat(24);
    },
  });
  assert.notEqual((await badWorkspace.preview()).status, 200);
  const badReceipt = await fixture(t, {
    mutateReceipt(reply) {
      reply.record.id = randomUUID();
    },
  });
  const preview = await badReceipt.preview();
  assert.equal(preview.status, 200);
  assert.notEqual((await badReceipt.control.clear(consent(preview.body.id))).status, 200);
});
test('recheck returns only the exact requested record and does not retry clear', async (t) => {
  const recordId = randomUUID(),
    f = await fixture(t);
  assert.equal((await f.control.recheck({ recordId })).status, 200);
  assert.equal(f.calls.at(-1).operation, 'taint-recheck');
  assert.equal(f.calls.at(-1).input.recordId, recordId);
  const wrong = await fixture(t, {
    mutateReceipt(reply) {
      reply.record.id = randomUUID();
    },
  });
  assert.notEqual((await wrong.control.recheck({ recordId })).status, 200);
});
test('changed evidence during inspection is refused and no later operation can dispatch after close', async (t) => {
  const f = await fixture(t, {
    selectEvidence(_input, count) {
      return { seq: count === 1 ? 7 : 8, ts: '2026-10-24T00:00:00.000Z' };
    },
  });
  assert.equal((await f.control.inspect({ id, expectedEvidenceSha: evidence })).status, 409);
  await f.control.close();
  const before = f.calls.length;
  assert.equal(
    (await f.control.inspect({ id, expectedEvidenceSha: evidence })).body.error,
    'server-stopped',
  );
  assert.equal(f.calls.length, before);
});
test('private preview memory remains bounded and uncertain writes cannot be retried with the same consent', async (t) => {
  const large = await fixture(t, {
    mutatePreview({ plan }) {
      plan.binding.extra = Buffer.alloc(8 * 1024 * 1024);
    },
  });
  assert.equal((await large.preview()).status, 409);
  const f = await fixture(t, {
    execute(operation, input, options) {
      if (operation === 'taint-preview') {
        const before = inspection(options.context.now);
        return {
          report: {
            schema: 'stroq-session-taint-preview/1',
            id: input.previewId,
            recordId: input.recordId,
            createdAt: options.context.now,
            expiresAt: new Date(input.expiresAt).toISOString(),
            inspection: before,
            weakensRestrictions: true,
            provenancePreserved: true,
            privateRecovery: true,
            hostEnforcement: false,
          },
          plan: {
            schema: 'stroq-session-taint-plan/1',
            recordId: input.recordId,
            expiresAt: input.expiresAt,
            before,
            binding: {},
          },
        };
      }
      if (operation === 'taint-apply') throw Error('write-unconfirmed');
      throw Error('unexpected-automatic-recheck');
    },
  });
  const preview = await f.preview();
  assert.equal(preview.status, 200);
  assert.equal((await f.control.clear(consent(preview.body.id))).body.error, 'write-unconfirmed');
  assert.equal((await f.control.clear(consent(preview.body.id))).status, 409);
  assert.equal(f.calls.filter((call) => call.operation === 'taint-apply').length, 1);
  assert.equal(
    f.calls.some((call) => call.operation === 'taint-recheck'),
    false,
  );
});
test('close aborts an actual fixture worker and awaits termination before releasing the mutation lock', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'stroq-taint-service-worker-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = join(root, 'started'),
    workerPath = join(root, 'worker.mjs');
  await writeFile(
    workerPath,
    `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'started');setInterval(()=>{},1000);`,
  );
  let held = false,
    finished = false;
  const context = {
    workspaceId,
    storeId: '2'.repeat(64),
    project: root,
    roots: { project: { path: root }, user: { path: root } },
    options: { home: root, paths: { cli: join(root, 'inert.js') } },
    current: async () => ({ engineVersion: '0.28.0', runtimeSha256: '1'.repeat(64) }),
    assert: async () => {},
  };
  const control = await createSessionTaintControl({
    context,
    workerPath,
    withLock: async (_bound, action) => {
      held = true;
      try {
        return await action();
      } finally {
        held = false;
        finished = true;
      }
    },
  });
  t.after(() => control.close());
  const operation = control.recheck({ recordId: randomUUID() });
  for (let i = 0; i < 100; i++) {
    if (await readFile(marker).catch(() => null)) break;
    await delay(10);
  }
  assert.equal(
    await readFile(marker, 'utf8'),
    'started',
    'Actual separate worker reached its inert barrier',
  );
  assert.equal(held, true);
  assert.equal(finished, false);
  await control.close();
  assert.equal((await operation).body.error, 'server-stopped');
  assert.equal(held, false);
  assert.equal(finished, true);
});

test('preview capacity charges the complete retained evidence envelope rather than only its private plan', async (t) => {
  const f = await fixture(t, {
    mutatePreview({ plan }) {
      plan.binding.extra = Buffer.alloc(8 * 1024 * 1024 - serialize(plan).byteLength - 100);
      assert(serialize(plan).byteLength < 8 * 1024 * 1024, 'Plan alone still fits');
    },
  });
  assert.equal(
    (await f.preview()).status,
    409,
    'Retained public report and runtime binding also consume memory',
  );
});

test('unref timers release private previews at TTL even without another request and are cleared on consume/close', async (t) => {
  const timers = [],
    cleared = [];
  t.mock.method(globalThis, 'setTimeout', (callback, ms) => {
    const timer = {
      callback,
      ms,
      unreferenced: false,
      unref() {
        this.unreferenced = true;
      },
    };
    timers.push(timer);
    return timer;
  });
  t.mock.method(globalThis, 'clearTimeout', (timer) => cleared.push(timer));
  const f = await fixture(t),
    expired = await f.preview();
  assert.equal(expired.status, 200);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 120000);
  assert.equal(timers[0].unreferenced, true);
  timers[0].callback();
  assert.equal(
    (await f.control.clear(consent(expired.body.id))).status,
    409,
    'Expired private evidence is already removed',
  );
  const consumed = await f.preview();
  await f.control.clear({ previewId: consumed.body.id });
  assert(cleared.includes(timers[1]));
  await f.preview();
  await f.control.close();
  assert(cleared.includes(timers[2]));
});

for (const lost of [
  'deadline-exceeded',
  'server-stopped',
  'runtime-unavailable',
  'PRIVATE_WORKER_FAILURE',
]) {
  test(`launched clear ${lost} has unknown completion and consumed consent`, async (t) => {
    const f = await fixture(t, {
      execute(operation, input, options) {
        if (operation === 'taint-preview') {
          const before = inspection(options.context.now);
          return {
            report: {
              schema: 'stroq-session-taint-preview/1',
              id: input.previewId,
              recordId: input.recordId,
              createdAt: options.context.now,
              expiresAt: new Date(input.expiresAt).toISOString(),
              inspection: before,
              weakensRestrictions: true,
              provenancePreserved: true,
              privateRecovery: true,
              hostEnforcement: false,
            },
            plan: {
              schema: 'stroq-session-taint-plan/1',
              recordId: input.recordId,
              expiresAt: input.expiresAt,
              before,
              binding: {},
            },
          };
        }
        options.onStart?.();
        throw Error(lost);
      },
    });
    const preview = await f.preview();
    assert.equal(preview.status, 200);
    assert.equal((await f.control.clear(consent(preview.body.id))).body.error, 'write-unconfirmed');
    assert.equal((await f.control.clear(consent(preview.body.id))).status, 409);
  });
}
test('runtime context is checked again after a confirmed worker receipt', async (t) => {
  const f = await fixture(t, {
    mutateReceipt() {
      f.setRuntime('9'.repeat(64));
    },
  });
  const preview = await f.preview();
  assert.equal(preview.status, 200);
  const receipt = await f.control.clear(consent(preview.body.id));
  assert.equal(receipt.body.error, 'write-unconfirmed');
});
