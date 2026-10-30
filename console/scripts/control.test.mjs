import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createControl as createService, readControlContext } from './control.mjs';
import { normalizeReport, summaryOf, validRunInput } from './control-reports.mjs';

test('recorded diagnostic summaries do not equate aggregate CLI success with agent setup', () => {
  assert.equal(summaryOf('doctor', { passed: 20, total: 21 }), '21 installation checks recorded');
});

const doctor = {
  version: 1,
  ok: true,
  checks: [{ name: 'rules', ok: true, detail: 'secret-value' }],
};
const engine = { available: true, version: '0.28.0' };
const context = {
  workspaceId: 'a'.repeat(64),
  policySha256: 'b'.repeat(64),
  runtimeSha256: 'c'.repeat(64),
};
const createControl = (options = {}) =>
  createService({ readContext: async () => context, ...options });
const historyFile = (home) => join(home, 'console', `runs-${context.workspaceId}.json`);
const policy = {
  version: 1,
  ok: true,
  source: 'file',
  file: '/private/secret-value',
  loaded: true,
  policy: { rules: 12, default: 'allow', threshold: 0.6, sha256: 'a'.repeat(64) },
  faults: [],
  findings: [],
};

test('input is a closed action union with bounded text and no arbitrary paths or arguments', () => {
  for (const kind of ['doctor', 'policy-check', 'guard-test']) {
    assert.equal(validRunInput({ kind }), true);
    assert.equal(validRunInput({ kind, content: 'ignored?' }), false);
    assert.equal(validRunInput({ kind, args: ['--help'] }), false);
  }
  assert.equal(validRunInput({ kind: 'content-scan', content: 'hello', target: 'skill' }), true);
  for (const value of [
    null,
    [],
    {},
    { kind: 'exec' },
    { kind: 'doctor', cwd: '/' },
    { kind: 'content-scan', content: '', target: 'skill' },
    { kind: 'content-scan', content: 'a', target: 'command' },
    { kind: 'content-scan', content: {}, target: 'skill' },
    { kind: 'content-scan', content: '\u0000', target: 'skill' },
    { kind: 'content-scan', content: '🔥'.repeat(13000), target: 'tool-result' },
    { kind: 'content-scan', content: 'a'.repeat(49153), target: 'skill' },
    JSON.parse('{"kind":"doctor","__proto__":{}}'),
  ])
    assert.equal(validRunInput(value), false, JSON.stringify(value).slice(0, 100));
});

test('doctor and policy reports project only derived fields, never raw labels, details or paths', () => {
  const result = normalizeReport('doctor', {
    ...doctor,
    checks: [...doctor.checks, { name: 'secret-value', ok: true, detail: 'raw-command' }],
  });
  assert.equal(result.evidence, 'configuration');
  assert.equal(result.total, 2);
  assert.equal(result.passed, 2);
  assert.equal(result.checks[1].label, 'Additional installation check');
  assert.ok(!JSON.stringify(result).includes('secret-value'));
  assert.ok(!JSON.stringify(result).includes('raw-command'));
  const checked = normalizeReport('policy-check', {
    ...policy,
    ok: false,
    findings: [
      { kind: 'unknown-field', severity: 'warning', message: 'secret-value' },
      { kind: 'unknown-field', severity: 'warning', message: 'raw-command' },
    ],
  });
  assert.deepEqual(checked.findings, [{ kind: 'unknown-field', severity: 'warning', count: 2 }]);
  assert.equal(checked.rules, 12);
  assert.ok(!JSON.stringify(checked).includes('secret-value'));
});

test('malformed or contradictory engine reports cannot become passing results', () => {
  for (const [kind, value] of [
    ['doctor', { ...doctor, version: 2 }],
    ['doctor', { ...doctor, checks: [] }],
    ['doctor', { ...doctor, checks: [{ name: 'rules', ok: 'yes' }] }],
    ['doctor', { ...doctor, checks: [{ name: 'rules', ok: false }] }],
    ['doctor', { ...doctor, checks: Array(129).fill(doctor.checks[0]) }],
    ['policy-check', { ...policy, loaded: false }],
    ['policy-check', { ...policy, policy: { ...policy.policy, default: 'ignore' } }],
    ['policy-check', { ...policy, policy: { ...policy.policy, threshold: Infinity } }],
    ['policy-check', { ...policy, findings: [{ kind: 'new-unhandled', severity: 'info' }] }],
    ['policy-check', { ...policy, findings: [{ kind: 'unknown-field', severity: 'warning' }] }],
    ['content-scan', { verdict: 'unknown', score: 0, matches: [] }],
  ])
    assert.throws(() => normalizeReport(kind, value), /invalid-report/);
});

test('policy scenario outcomes retain escaping attacks and inconclusive counts', () => {
  const result = normalizeReport('guard-test', {
    version: 1,
    ok: false,
    replayed: { attack: 2, ordinary: 3, cases: 0 },
    attacksPassing: [{ id: 'secret-value' }],
    newInterruptions: [],
    relieved: [],
    violations: [],
    notJudged: [{ reason: 'secret-value' }],
  });
  assert.equal(result.evidence, 'simulation');
  assert.equal(result.attacksPassing, 1);
  assert.equal(result.notJudged, 1);
  assert.equal(result.ok, false);
  assert.ok(!JSON.stringify(result).includes('secret-value'));
  assert.throws(
    () => normalizeReport('guard-test', { ...result, version: 1, ok: true }),
    /invalid-report/,
  );
});

test('runs are serial, drop submitted text, normalize reports, and preserve failures', async (t) => {
  let release;
  const control = await createControl({
    engine,
    execute: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  t.after(() => control.close());
  const started = await control.start({ kind: 'doctor' });
  assert.equal(started.status, 202);
  assert.equal(started.body.status, 'running');
  assert.equal(control.start({ kind: 'policy-check' }).status, 409);
  await new Promise((resolve) => setImmediate(resolve));
  release(doctor);
  await control.idle();
  const run = control.getRun(started.body.id);
  assert.equal(run.status, 'completed');
  assert.equal(run.result.source, 'local');
  assert.ok(!JSON.stringify(await control.snapshot()).includes('secret-value'));
  assert.equal(control.getRun('missing'), null);
  run.result.ok = false;
  assert.equal(control.getRun(started.body.id).result.ok, true);
});

test('run failure hides raw errors and scan text, history stays bounded and unavailable engines refuse work', async (t) => {
  const control = await createControl({
    engine,
    execute: async () => {
      throw new Error('secret-value');
    },
  });
  t.after(() => control.close());
  for (let index = 0; index < 35; index++) {
    await control.start({ kind: 'content-scan', content: 'secret-value', target: 'skill' });
    await control.idle();
  }
  const state = await control.snapshot();
  assert.equal(state.runs.length, 32);
  assert.ok(state.runs.every((run) => run.status === 'failed' && run.error === 'engine-failed'));
  assert.ok(!JSON.stringify(state).includes('secret-value'));
  const unavailable = await createControl({ engine: { available: false, version: null } });
  t.after(() => unavailable.close());
  assert.equal(unavailable.start({ kind: 'doctor' }).status, 503);
  assert.equal(unavailable.start({ kind: 'exec' }).status, 400);
});

async function privateHome(t) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'stroq-control-history-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

test('normalized completed results survive restart without submitted text or raw reports', async (t) => {
  const home = await privateHome(t);
  const control = await createControl({ home, engine, execute: async () => doctor });
  const started = await control.start({ kind: 'doctor' });
  await control.idle();
  const completed = control.getRun(started.body.id);
  assert.equal(completed.status, 'completed');
  assert.deepEqual((await control.snapshot()).history, { status: 'ready' });
  await control.close();
  const persisted = await readFile(historyFile(home), 'utf8');
  assert.ok(!persisted.includes('secret-value'));
  const restored = await createControl({ home, engine, execute: async () => doctor });
  t.after(() => restored.close());
  assert.deepEqual(restored.getRun(completed.id), completed);
});

test('startup preserves unowned running records; only explicit admission can record interruption', async (t) => {
  const home = await privateHome(t);
  await mkdir(join(home, 'console'), { mode: 0o700 });
  const interrupted = {
    id: '00000000-0000-4000-a000-000000000001',
    kind: 'doctor',
    status: 'running',
    startedAt: '2026-10-23T00:00:00.000Z',
  };
  await writeFile(
    historyFile(home),
    JSON.stringify({
      schema: 'stroq-runs/2',
      workspaceId: context.workspaceId,
      runs: [interrupted],
    }),
    { mode: 0o600 },
  );
  const restored = await createControl({ home, engine, execute: async () => doctor });
  t.after(() => restored.close());
  const recovered = restored.getRun(interrupted.id);
  assert.deepEqual(recovered, interrupted);
  const persisted = JSON.parse(await readFile(historyFile(home), 'utf8'));
  assert.deepEqual(persisted.runs, [interrupted]);
  const accepted = await restored.start({ kind: 'doctor' });
  assert.equal(accepted.status, 202);
  assert.equal(restored.getRun(interrupted.id).error, 'interrupted');
  await restored.idle();
});

test('invalid retained history is visible and refuses new diagnostics without overwriting it', async (t) => {
  const home = await privateHome(t);
  await mkdir(join(home, 'console'), { mode: 0o700 });
  const original = JSON.stringify({
    schema: 'stroq-runs/2',
    workspaceId: context.workspaceId,
    runs: [],
    content: 'secret-value',
  });
  await writeFile(historyFile(home), original, { mode: 0o600 });
  const control = await createControl({ home, engine, execute: async () => doctor });
  t.after(() => control.close());
  assert.deepEqual((await control.snapshot()).history, {
    status: 'error',
    error: 'invalid-history',
  });
  const started = await control.start({ kind: 'doctor' });
  await control.idle();
  assert.equal(started.status, 503);
  assert.equal(started.body.error, 'history-unavailable');
  assert.deepEqual((await control.snapshot()).runs, []);
  assert.equal(await readFile(historyFile(home), 'utf8'), original);
  assert.ok(!JSON.stringify(await control.snapshot()).includes('secret-value'));
});

test('scan history retains derived fingerprints and known failure codes, with at most 32 entries after restart', async (t) => {
  const home = await privateHome(t);
  const content = 'submitted-secret-value-only-for-scanning';
  let count = 0;
  const control = await createControl({
    home,
    engine,
    execute: async () => {
      count += 1;
      if (count === 2) throw new Error(content);
      return {
        target: 'skill',
        verdict: 'clean',
        score: 0,
        timedOut: false,
        characters: content.length,
        sha256: 'a'.repeat(64),
        matches: [],
        content,
      };
    },
  });
  for (let i = 0; i < 33; i++) {
    assert.equal(
      (await control.start({ kind: 'content-scan', content, target: 'skill' })).status,
      202,
    );
    await control.idle();
  }
  await control.close();
  const text = await readFile(historyFile(home), 'utf8');
  assert.ok(!text.includes(content));
  const restored = await createControl({ home, engine });
  t.after(() => restored.close());
  const state = await restored.snapshot();
  assert.deepEqual(state.history, { status: 'ready' });
  assert.equal(state.runs.length, 32);
  assert.equal(state.runs.filter((run) => run.status === 'failed').length, 1);
  assert.equal(state.runs.at(-1).error, 'engine-failed');
  assert.equal(state.runs[0].result.sha256, 'a'.repeat(64));
  assert.ok(!JSON.stringify(state).includes(content));
});

async function contextFixture(t) {
  const root = await privateHome(t);
  const home = join(root, 'stroq');
  const project = join(root, 'project-a');
  const other = join(root, 'project-b');
  const paths = {
    cli: join(root, 'runtime', 'index.js'),
    core: join(root, 'core', 'index.js'),
    package: join(root, 'package.json'),
  };
  for (const dir of [home, project, other, join(root, 'runtime'), join(root, 'core')])
    await mkdir(dir, { mode: 0o700 });
  for (const path of [paths.cli, paths.core])
    await writeFile(path, 'export {};\n', { mode: 0o600 });
  await writeFile(paths.package, '{"version":"0.28.0"}', { mode: 0o600 });
  return { root, home, project, other, paths, engine, execute: async () => doctor };
}

test('canonical workspaces have distinct persisted diagnostics for the same user', async (t) => {
  const options = await contextFixture(t);
  const first = await createService(options);
  const started = await first.start({ kind: 'doctor' });
  await first.idle();
  const state = await first.snapshot();
  assert.match(state.context.workspaceId, /^[a-f0-9]{64}$/);
  assert.deepEqual(first.getRun(started.body.id).provenance, state.context);
  await first.close();
  const second = await createService({ ...options, project: options.other });
  t.after(() => second.close());
  const secondState = await second.snapshot();
  assert.notEqual(secondState.context.workspaceId, state.context.workspaceId);
  assert.deepEqual(secondState.runs, []);
  const alias = join(options.root, 'alias');
  await symlink(options.project, alias);
  const restored = await createService({ ...options, project: alias });
  t.after(() => restored.close());
  assert.equal((await restored.snapshot()).context.workspaceId, state.context.workspaceId);
  assert.equal(restored.getRun(started.body.id).status, 'completed');
  assert.ok(!JSON.stringify(state).includes(options.root));
});

test('policy and runtime edits keep earlier reports historical while context reads execute nothing', async (t) => {
  const options = await contextFixture(t);
  let executions = 0;
  const service = await createService({
    ...options,
    execute: async () => {
      executions++;
      return doctor;
    },
  });
  t.after(() => service.close());
  const started = await service.start({ kind: 'doctor' });
  await service.idle();
  const original = service.getRun(started.body.id).provenance;
  await writeFile(join(options.home, 'policy.yaml'), 'default: deny\n', { mode: 0o600 });
  const changedPolicy = (await service.snapshot()).context;
  assert.notEqual(changedPolicy.policySha256, original.policySha256);
  await writeFile(options.paths.core, 'export const changed = true;\n');
  const changedRuntime = (await service.snapshot()).context;
  assert.notEqual(changedRuntime.runtimeSha256, original.runtimeSha256);
  assert.deepEqual(service.getRun(started.body.id).provenance, original);
  assert.equal(executions, 1);
  const unknown = await readControlContext({
    ...options,
    paths: { ...options.paths, core: join(options.root, 'missing') },
  });
  assert.equal(unknown.runtimeSha256, null);
});

test('context changed during a run cannot regain current binding after the policy is restored', async (t) => {
  const options = await contextFixture(t);
  const service = await createService({
    ...options,
    execute: async () => {
      await writeFile(join(options.home, 'policy.yaml'), 'default: deny\n', { mode: 0o600 });
      return doctor;
    },
  });
  t.after(() => service.close());
  const before = (await service.snapshot()).context;
  const started = await service.start({ kind: 'doctor' });
  await service.idle();
  const run = service.getRun(started.body.id);
  assert.equal(run.status, 'completed');
  assert.equal(run.provenance.policySha256, null);
  assert.equal(run.provenance.runtimeSha256, null);
  await rm(join(options.home, 'policy.yaml'));
  assert.deepEqual((await service.snapshot()).context, before);
  assert.equal(service.getRun(run.id).provenance.policySha256, null);
});

test('replacing a workspace directory at the same path changes its evidence identity', async (t) => {
  const options = await contextFixture(t);
  const before = await readControlContext(options);
  await rename(options.project, join(options.root, 'old-project'));
  await mkdir(options.project, { mode: 0o700 });
  const after = await readControlContext(options);
  assert.notEqual(after.workspaceId, before.workspaceId);
  assert.equal(after.policySha256, before.policySha256);
  assert.equal(after.runtimeSha256, before.runtimeSha256);
});
