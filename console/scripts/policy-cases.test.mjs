import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'tsup';
import { createPolicyCasesService } from './policy-cases.mjs';
import { createPolicyCasesStore, policyCaseId } from './policy-cases-store.mjs';
import { ACTION_CLASSES, DEFAULT_POLICY, evaluatePolicy } from '../../packages/core/dist/index.js';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import { Worker } from 'node:worker_threads';
import { runPolicyCaseEvaluation } from './policy-worker.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = await mkdtemp(join(tmpdir(), 'stroq-cases-schema-'));
after(() => rm(output, { recursive: true, force: true }));
await build({
  entry: { schema: resolve(repository, 'console/scripts/local-api-schema.ts') },
  outDir: output,
  outExtension: () => ({ js: '.mjs' }),
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  splitting: false,
  sourcemap: false,
  dts: false,
  config: false,
  silent: true,
});
const schema = await import(pathToFileURL(join(output, 'schema.mjs')).href);
const semantic = 'a'.repeat(64);
const workspaceId = `workspace-${'c'.repeat(24)}`;
const evidenceSha = 'b'.repeat(64);
const incidentId = `incident-${evidenceSha}`;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function fixture(t, overrides = {}) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'stroq-cases-service-')));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const home = join(parent, 'home');
  const store = createPolicyCasesStore({ home });
  let classes = ['shell.network'];
  let effects = ['allow', 'deny'];
  const compare = async ({ id, expectedEvidenceSha }) => ({
    schema: 'stroq-incident-comparison/1',
    source: 'local',
    incidentId: id,
    evidenceSha: expectedEvidenceSha,
    comparedAt: '2026-10-23T01:02:03.000Z',
    currentPolicy: { source: 'built-in', semanticSha: semantic, rawSha: null, rules: 21 },
    previousEffect: 'deny',
    classes,
    scopeRecorded: false,
    scenarios: effects.map((effect, i) => ({
      taint: ['none', 'suspect'][i],
      effect,
      matchedRule: null,
    })),
    relation: effects.every((effect) => effect === 'deny')
      ? 'matchesRecorded'
      : effects.every((effect) => effect !== 'deny')
        ? 'changed'
        : 'mixed',
    limitations: [
      ...(schema.COMPARISON_LIMITATIONS ?? [
        'The original taint state was not recorded. These are two current-policy scenarios, not a replay of the original decision.',
        'Only the recorded action classes and current server policy are evaluated. Task scope, trust exemptions, host adapters and runtime guards are not evaluated.',
        'The current server policy is not proof that an installed host loaded this policy. The original policy version was not recorded.',
        'Agreement or a changed decision does not establish host execution, blocking, credential rotation or remediation.',
        'Commands, content, session identifiers, paths, custom rule identifiers and reasons are withheld. The journal hash chain is not verified by this comparison.',
        'Policy scan threshold is not used when evaluating recorded action classes.',
      ]),
    ],
  });
  const evaluate = async (text, records) => {
    const policy = text === null ? DEFAULT_POLICY : parse(text);
    const results = records.map((record) => {
      const scenarios = record.expected.map((row) => ({
        taint: row.taint,
        expected: row.effect,
        actual: evaluatePolicy(policy, record.classes, row.taint === 'none' ? null : 'suspect')
          .effect,
      }));
      return {
        caseId: record.id,
        passed: scenarios.every((s) => s.expected === s.actual),
        scenarios,
      };
    });
    return {
      policyFingerprint: semantic,
      total: results.length,
      passed: results.filter((r) => r.passed).length,
      failed: results.filter((r) => !r.passed).length,
      results,
    };
  };
  const service = createPolicyCasesService({
    home,
    store,
    compare,
    evaluate,
    workspaceId,
    now: () => new Date('2026-10-23T01:02:03.000Z'),
    loadSchema: async () => schema,
    ...overrides,
  });
  t.after(() => service.close());
  return {
    parent,
    home,
    store,
    service,
    compare,
    evaluate,
    setClasses(v) {
      classes = v;
    },
    setEffects(v) {
      effects = v;
    },
  };
}
const save = (expectedStoreRevision = null) => ({
  incidentId,
  expectedEvidenceSha: evidenceSha,
  expectedPolicyFingerprint: semantic,
  expectedPolicyRawSha: null,
  expectedStoreRevision,
  acknowledgeSharedScope: true,
});

test('cancelling an owned read terminates its real evaluator and leaves the shared service usable', async (t) => {
  let worker, announce;
  const online = new Promise((resolve) => {
    announce = resolve;
  });
  const f = await fixture(t, {
    evaluate: (text, records, options) =>
      runPolicyCaseEvaluation(text, records, {
        ...options,
        createWorker: (entry, configuration) => {
          worker = new Worker(entry, configuration);
          worker.once('online', announce);
          return worker;
        },
      }),
  });
  const controller = new AbortController();
  const attempt = f.service.read({ signal: controller.signal });
  await online;
  controller.abort();
  const cancelledWorker = worker,
    result = await attempt;
  assert.equal(result.status, 503);
  assert.equal(result.body.error, 'policy-cases-unavailable');
  assert.equal(cancelledWorker.threadId, -1);
  const next = await f.service.read();
  assert.equal(next.status, 200);
  assert.equal(schema.validatePolicyCases(next.body), true);
});

test('read is read-only when missing, saves derived decisions, survives restart and preserves first source', async (t) => {
  const f = await fixture(t);
  const empty = await f.service.read();
  assert.equal(empty.status, 200);
  assert.equal(schema.validatePolicyCases(empty.body), true);
  assert.equal(empty.body.revision, null);
  assert.deepEqual(empty.body.cases, []);
  await assert.rejects(readFile(join(f.home, 'console', 'policy-cases.json')), { code: 'ENOENT' });
  const saved = await f.service.save(save());
  assert.equal(saved.status, 200);
  assert.equal(schema.validatePolicyCaseReceipt(saved.body), true);
  assert.equal(saved.body.status, 'saved');
  assert.deepEqual(saved.body.record.classes, ['shell.network']);
  const before = await readFile(join(f.home, 'console', 'policy-cases.json'));
  const unchanged = await f.service.save({
    ...save(saved.body.revision),
    incidentId: `incident-${'d'.repeat(64)}`,
    expectedEvidenceSha: 'd'.repeat(64),
  });
  assert.equal(unchanged.body.status, 'unchanged');
  assert.deepEqual(unchanged.body.record, saved.body.record);
  assert.deepEqual(await readFile(join(f.home, 'console', 'policy-cases.json')), before);
  const restarted = createPolicyCasesService({
    home: f.home,
    store: createPolicyCasesStore({ home: f.home }),
    compare: f.compare,
    evaluate: f.evaluate,
    workspaceId: `workspace-${'f'.repeat(24)}`,
    loadSchema: async () => schema,
  });
  t.after(() => restarted.close());
  assert.equal((await restarted.read()).body.cases.length, 1);
  assert.equal((await restarted.read()).body.cases[0].source.workspaceId, workspaceId);
});

test('save rejects client predicates, acknowledgements, stale revisions and empty evidence', async (t) => {
  const f = await fixture(t);
  for (const patch of [
    { classes: ['secret.egress'] },
    { expected: ['deny'] },
    { acknowledgeSharedScope: false },
    { expectedPolicyFingerprint: 'x' },
    { expectedStoreRevision: 'a'.repeat(64) },
    { expectedPolicyFingerprint: 'd'.repeat(64) },
  ]) {
    assert.notEqual((await f.service.save({ ...save(), ...patch })).status, 200);
  }
  f.setClasses([]);
  assert.deepEqual(await f.service.save(save()), {
    status: 422,
    body: { error: 'unsupported-evidence' },
  });
  assert.equal((await f.store.capture()).records.length, 0);
});

test('a changed expectation conflicts until explicit removal, removal does not change active policy', async (t) => {
  const f = await fixture(t);
  const saved = await f.service.save(save());
  f.setEffects(['deny', 'deny']);
  const conflict = await f.service.save(save(saved.body.revision));
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error, 'policy-case-conflict');
  const request = {
    caseId: saved.body.caseId,
    expectedStoreRevision: saved.body.revision,
    acknowledgeWeakenChecks: true,
    acknowledgeSharedScope: true,
  };
  assert.notEqual(
    (await f.service.remove({ ...request, acknowledgeWeakenChecks: false })).status,
    200,
  );
  const removed = await f.service.remove(request);
  assert.equal(schema.validatePolicyCaseReceipt(removed.body), true);
  assert.equal(removed.body.status, 'removed');
  assert.equal(removed.body.record, null);
  assert.deepEqual((await f.store.capture()).records, []);
  await assert.rejects(readFile(join(f.home, 'policy.yaml')), { code: 'ENOENT' });
});

test('GET reports failed saved checks as evidence without replacing them or inventing success', async (t) => {
  const f = await fixture(t);
  const saved = await f.service.save(save());
  const text = 'version: 1\nthreshold: 0.6\ndefault: deny\nrules: []\n';
  await writeFile(join(f.home, 'policy.yaml'), text, { mode: 0o600 });
  const result = await f.service.read();
  assert.equal(result.status, 200);
  assert.equal(schema.validatePolicyCases(result.body), true);
  assert.equal(result.body.report.failed, 1);
  assert.equal(result.body.report.hostEnforcement, false);
  assert.equal(result.body.report.policy.rawSha, hash(Buffer.from(text)));
  assert.equal(result.body.revision, saved.body.revision);
});

test('malformed store or unavailable evaluator never returns a successful zero-case report', async (t) => {
  const f = await fixture(t);
  await f.service.save(save());
  const path = join(f.home, 'console', 'policy-cases.json');
  await writeFile(path, 'PRIVATE_MALFORMED_SENTINEL', { mode: 0o600 });
  assert.deepEqual(await f.service.read(), {
    status: 503,
    body: { error: 'policy-cases-unavailable' },
  });
  assert.equal(await readFile(path, 'utf8'), 'PRIVATE_MALFORMED_SENTINEL');
  const g = await fixture(t, {
    evaluate: async () => {
      throw new Error('PRIVATE_ENGINE_PATH');
    },
  });
  assert.deepEqual(await g.service.read(), {
    status: 503,
    body: { error: 'policy-cases-unavailable' },
  });
});

test('policy change while evaluating save refuses durable writes and leaves expectations unchanged', async (t) => {
  let home;
  const f = await fixture(t, {
    evaluate: async (_text, records) => {
      await writeFile(join(home, 'policy.yaml'), 'version: 1\ndefault: deny\nrules: []\n', {
        mode: 0o600,
      });
      return f.evaluate(null, records);
    },
  });
  home = f.home;
  const result = await f.service.save(save());
  assert.equal(result.status, 409);
  assert.equal(result.body.error, 'stale-policy');
  assert.deepEqual((await f.store.capture()).records, []);
});

test('server close aborts evaluation before a delayed save can commit', async (t) => {
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const f = await fixture(t, {
    evaluate: async (_text, _records, { signal }) => {
      entered();
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      throw new Error('server-stopped');
    },
  });
  const pending = f.service.save(save());
  await started;
  await f.service.close();
  assert.equal((await pending).body.error, 'server-stopped');
  assert.deepEqual((await f.store.capture()).records, []);
});

test('the full shared store refuses a new combination without evicting an older check', async (t) => {
  const f = await fixture(t);
  const records = Array.from({ length: 64 }, (_, index) => {
    const classes = ACTION_CLASSES.slice(0, 7)
      .filter((_, bit) => (index + 1) & (1 << bit))
      .sort();
    const expected = ['none', 'suspect'].map((taint) => ({
      taint,
      effect: evaluatePolicy(DEFAULT_POLICY, classes, taint === 'none' ? null : taint).effect,
    }));
    return {
      id: policyCaseId(classes, expected),
      createdAt: '2026-10-23T01:02:03.000Z',
      source: { incidentId, evidenceSha, workspaceId },
      classes,
      expected,
    };
  });
  const saved = await f.store.withSnapshotLock(await f.store.capture(), async (_fresh, replace) =>
    replace(records),
  );
  f.setClasses(['mcp.call']);
  f.setEffects(['allow', 'allow']);
  const before = await readFile(join(f.home, 'console', 'policy-cases.json'));
  const result = await f.service.save(save(saved.revision));
  assert.deepEqual(result, { status: 422, body: { error: 'policy-cases-full' } });
  assert.deepEqual(await readFile(join(f.home, 'console', 'policy-cases.json')), before);
  assert.equal((await f.service.read()).body.cases.length, 64);
});
