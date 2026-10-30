import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeReport } from './control-reports.mjs';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'tsup';
import { executeRun } from './control-engine.mjs';
import { createRunStore } from './run-store.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = await realpath(await mkdtemp(join(tmpdir(), 'stroq-doctor-diagnostics-build-')));
after(() => rm(output, { recursive: true, force: true }));
await writeFile(
  join(output, 'runner.ts'),
  `import {runDoctor} from '${repo}/packages/cli/src/commands/doctor.ts';process.exitCode=await runDoctor(process.argv.slice(2));`,
);
await writeFile(
  join(output, 'helpers.ts'),
  `export {mergeCursorHooks} from '${repo}/packages/cli/src/commands/cursor-hooks.ts';`,
);
await writeFile(
  join(output, 'package.json'),
  await readFile(join(repo, 'packages/cli/package.json')),
);
await build({
  entry: {
    index: join(output, 'runner.ts'),
    helpers: join(output, 'helpers.ts'),
    control: join(repo, 'console/lib/control.ts'),
    diagnostics: join(repo, 'console/lib/doctor-diagnostics.ts'),
  },
  outDir: join(output, 'cli'),
  outExtension: () => ({ js: '.mjs' }),
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  splitting: false,
  config: false,
  dts: false,
  silent: true,
  noExternal: ['@stroq/core', 'yaml', 'zod'],
  banner: {
    js: "import {createRequire as createDoctorFixtureRequire} from 'node:module';const require=createDoctorFixtureRequire(import.meta.url);",
  },
  esbuildOptions(options) {
    options.alias = { '@stroq/core': join(repo, 'packages/core/src/index.ts') };
  },
});
const control = await import(pathToFileURL(join(output, 'cli/control.mjs')).href),
  diagnostics = await import(pathToFileURL(join(output, 'cli/diagnostics.mjs')).href),
  helpers = await import(pathToFileURL(join(output, 'cli/helpers.mjs')).href);
const cli = join(output, 'cli/index.mjs'),
  sha = (v) => createHash('sha256').update(v).digest('hex');
const completed = (result) => ({
  id: '00000000-0000-4000-a000-000000000001',
  kind: 'doctor',
  status: 'completed',
  startedAt: '2026-10-23T12:00:00.000Z',
  finishedAt: '2026-10-23T12:00:01.000Z',
  result,
});
async function fixture(t, { cursor = false } = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'stroq-doctor-diagnostics-'))),
    project = join(base, 'project'),
    userHome = join(base, 'user'),
    home = join(userHome, '.stroq');
  await mkdir(project, { mode: 0o700 });
  await mkdir(userHome, { mode: 0o700 });
  t.after(() => rm(base, { recursive: true, force: true }));
  const cursorFile = join(project, '.cursor/hooks.json');
  if (cursor) {
    await mkdir(dirname(cursorFile), { mode: 0o700 });
    await writeFile(
      cursorFile,
      JSON.stringify(helpers.mergeCursorHooks({}, `"${process.execPath}" "${cli}" hook cursor`)),
      { mode: 0o600 },
    );
  }
  const raw = () =>
    executeRun(
      { kind: 'doctor' },
      { project, userHome, home, paths: { cli }, environment: {}, timeoutMs: 20_000 },
    );
  const store = () =>
    createRunStore({
      home,
      workspaceId: sha(project),
      loadValidator: async () => ({ validateRun: control.validateRun }),
    });
  return {
    base,
    project,
    userHome,
    home,
    cursorFile,
    raw,
    store,
    historyFile: join(home, 'console', `runs-${sha(project)}.json`),
  };
}
const typed = (check) => ({
  version: 1,
  diagnosticsVersion: 1,
  ok: check.ok,
  checks: [structuredClone(check)],
});
const hook = () => ({
  name: 'hooks',
  detail: 'PRIVATE_DETAIL',
  ok: true,
  diagnostic: {
    kind: 'agent-hooks',
    observations: [
      { code: 'not-configured', scope: 'project', agent: 'claude-code', client: null },
    ],
  },
});

const malformedTyped = {
  version: 1,
  diagnosticsVersion: 1,
  ok: true,
  checks: [
    {
      name: 'PRIVATE_RAW_NAME',
      ok: true,
      detail: '/PRIVATE_PATH secret-value',
      diagnostic: {
        kind: 'agent-hooks',
        observations: [
          { code: 'PRIVATE_UNKNOWN_CODE', scope: 'machine', agent: null, client: null },
        ],
      },
    },
  ],
};

test('unknown typed doctor observations cannot be silently discarded into a passing legacy result', () => {
  assert.throws(() => normalizeReport('doctor', malformedTyped), { message: 'invalid-report' });
});

test('partial typed doctor metadata cannot become a legacy success', () => {
  const raw = {
    version: 1,
    diagnosticsVersion: 1,
    ok: true,
    checks: [
      { name: 'rules', ok: true, detail: 'PRIVATE_RAW' },
      { name: 'hooks', ok: true, detail: 'PRIVATE_NOT_INSTALLED' },
    ],
  };
  assert.throws(() => normalizeReport('doctor', raw), { message: 'invalid-report' });
});

test('real isolated CLI keeps absent Claude typed not-configured when Cursor makes its legacy boolean true', async (t) => {
  const f = await fixture(t, { cursor: true }),
    before = await readFile(f.cursorFile);
  const raw = await f.raw();
  assert.equal(raw.version, 1);
  assert.equal(raw.diagnosticsVersion, 1);
  assert.ok(raw.checks.every((check) => diagnostics.validateDoctorDiagnostic(check.diagnostic)));
  const claude = raw.checks.find(
    (check) =>
      check.diagnostic.kind === 'agent-hooks' &&
      check.diagnostic.observations.some((row) => row.agent === 'claude-code'),
  );
  assert.ok(claude);
  assert.equal(claude.ok, true);
  assert.deepEqual(claude.diagnostic.observations, [
    { code: 'not-configured', scope: 'project', agent: 'claude-code', client: null },
    { code: 'not-configured', scope: 'user', agent: 'claude-code', client: null },
  ]);
  assert.equal(
    claude.diagnostic.observations.some((row) => row.code === 'ready'),
    false,
  );
  const normalized = normalizeReport('doctor', raw);
  assert.equal(normalized.diagnosticsVersion, 1);
  assert.equal(control.validateRun(completed(normalized)), true);
  assert.deepEqual(normalized.checks[raw.checks.indexOf(claude)].diagnostic, claude.diagnostic);
  assert.deepEqual(await readFile(f.cursorFile), before);
  await assert.rejects(lstat(f.home), { code: 'ENOENT' });
});

test('actual CLI producer metadata survives privacy projection even when every rendered name/detail is hostile', async (t) => {
  const f = await fixture(t, { cursor: true }),
    raw = await f.raw();
  const hostile = {
    ...raw,
    checks: raw.checks.map((check) => ({
      ...check,
      name: 'PRIVATE_NAME hooks configured /PRIVATE_PATH',
      detail: 'PRIVATE_SECRET Bearer sk-private-credential installed ready everywhere',
    })),
  };
  const result = normalizeReport('doctor', hostile);
  assert.equal(control.validateRun(completed(result)), true);
  for (const [index, check] of result.checks.entries()) {
    assert.equal(check.label, diagnostics.doctorDiagnosticLabel(raw.checks[index].diagnostic.kind));
    assert.deepEqual(check.diagnostic, raw.checks[index].diagnostic);
  }
  for (const secret of [
    'PRIVATE_NAME',
    'PRIVATE_PATH',
    'PRIVATE_SECRET',
    'sk-private-credential',
    f.project,
    f.userHome,
  ])
    assert.equal(JSON.stringify(result).includes(secret), false);
  const renamed = normalizeReport('doctor', {
    ...raw,
    checks: raw.checks.map((check) => ({
      ...check,
      name: '秘密の表示名',
      detail: 'not installed / installed / BROKEN / LIVE verified',
    })),
  });
  assert.deepEqual(renamed, result);
});

test('typed MCP and skill families use fixed labels without disclosing source names or paths', async (t) => {
  const f = await fixture(t, { cursor: true });
  await mkdir(f.home, { mode: 0o700 });
  await writeFile(join(f.home, 'passports.json'), '{PRIVATE_BAD_PASSPORTS');
  const mcpFile = join(f.project, '.cursor/mcp.json');
  await writeFile(
    mcpFile,
    JSON.stringify({
      mcpServers: {
        PRIVATE_SERVER: {
          command: '/PRIVATE_SERVER_EXECUTABLE',
          args: ['PRIVATE_SERVER_ARGUMENT'],
        },
      },
    }),
    { mode: 0o600 },
  );
  const raw = await f.raw(),
    result = normalizeReport('doctor', raw);
  assert.equal(control.validateRun(completed(result)), true);
  for (const kind of ['mcp-proxy', 'skill-integrity']) {
    const checks = result.checks.filter((check) => check.diagnostic.kind === kind);
    assert.ok(checks.length > 0, kind);
    for (const check of checks) assert.equal(check.label, diagnostics.doctorDiagnosticLabel(kind));
  }
  const proxy = result.checks.find((check) => check.diagnostic.kind === 'mcp-proxy');
  assert.ok(
    proxy.diagnostic.observations.some(
      (row) =>
        row.code === 'unwrapped-servers' && row.client === 'cursor' && row.scope === 'project',
    ),
  );
  for (const rawValue of [
    'PRIVATE_SERVER',
    'PRIVATE_SERVER_EXECUTABLE',
    'PRIVATE_SERVER_ARGUMENT',
    'PRIVATE_BAD_PASSPORTS',
    f.project,
    f.userHome,
  ])
    assert.equal(JSON.stringify(result).includes(rawValue), false);
});

test('finite typed diagnostics refuse unknown fields, incompatible families and incomplete versioned reports', () => {
  const valid = hook();
  assert.equal(control.validateRun(completed(normalizeReport('doctor', typed(valid)))), true);
  const changes = [
    (check) => (check.diagnostic.extra = 'PRIVATE'),
    (check) => (check.diagnostic.kind = 'PRIVATE_KIND'),
    (check) => (check.diagnostic.observations[0].code = 'PRIVATE_CODE'),
    (check) => (check.diagnostic.observations[0].scope = 'PRIVATE_SCOPE'),
    (check) => (check.diagnostic.observations[0].agent = 'PRIVATE_AGENT'),
    (check) => (check.diagnostic.observations[0].client = 'PRIVATE_CLIENT'),
    (check) => (check.diagnostic.observations[0].extra = 'PRIVATE'),
    (check) => (check.diagnostic.observations[0].client = 'cursor'),
    (check) => (check.diagnostic.observations[0].scope = 'data'),
    (check) => (check.diagnostic.observations = []),
  ];
  for (const change of changes) {
    const check = structuredClone(valid);
    change(check);
    assert.throws(() => normalizeReport('doctor', typed(check)), { message: 'invalid-report' });
  }
  for (const version of [null, 0, 2, '1'])
    assert.throws(
      () => normalizeReport('doctor', { ...typed(valid), diagnosticsVersion: version }),
      { message: 'invalid-report' },
    );
  assert.throws(() => normalizeReport('doctor', { version: 1, ok: true, checks: [valid] }), {
    message: 'invalid-report',
  });
  const missing = typed(valid);
  delete missing.checks[0].diagnostic;
  assert.throws(() => normalizeReport('doctor', missing), { message: 'invalid-report' });
  const result = normalizeReport('doctor', typed(valid));
  for (const mutate of [
    (value) => delete value.checks[0].diagnostic,
    (value) => delete value.diagnosticsVersion,
    (value) => (value.checks[0].diagnostic.observations[0].scope = 'PRIVATE_SCOPE'),
  ]) {
    const candidate = structuredClone(result);
    mutate(candidate);
    assert.equal(control.validateRun(completed(candidate)), false);
  }
});

test('typed reports and legacy derived history survive durable restart without automatic migration or fabricated metadata', async (t) => {
  const f = await fixture(t, { cursor: true }),
    result = normalizeReport('doctor', await f.raw());
  const missing = await f.store();
  assert.deepEqual(missing.state(), { status: 'ready' });
  assert.deepEqual(missing.runs, []);
  await assert.rejects(lstat(f.home), { code: 'ENOENT' });
  const fresh = completed(result),
    legacy = {
      ...completed({
        source: 'local',
        evidence: 'configuration',
        ok: true,
        checks: [{ id: 'check-1', label: 'Legacy installation check', ok: true }],
        passed: 1,
        total: 1,
      }),
      id: '00000000-0000-4000-a000-000000000002',
    };
  assert.equal(control.validateRun(legacy), true);
  assert.equal(await missing.write([fresh, legacy]), true);
  const bytes = await readFile(f.historyFile),
    pin = await lstat(f.historyFile, { bigint: true });
  const restored = await f.store();
  assert.deepEqual(restored.state(), { status: 'ready' });
  assert.deepEqual(restored.runs, [fresh, legacy]);
  assert.equal(Object.hasOwn(restored.runs[1].result, 'diagnosticsVersion'), false);
  assert.equal(Object.hasOwn(restored.runs[1].result.checks[0], 'diagnostic'), false);
  assert.deepEqual(await readFile(f.historyFile), bytes);
  const after = await lstat(f.historyFile, { bigint: true });
  assert.equal(after.ino, pin.ino);
  assert.equal(after.mtimeNs, pin.mtimeNs);
  assert.equal(after.ctimeNs, pin.ctimeNs);
  for (const value of [f.project, f.userHome, 'PRIVATE_DETAIL', 'PRIVATE_RAW_NAME'])
    assert.equal(bytes.includes(Buffer.from(value)), false);
});

test('an unbuilt fixed schema adapter cannot break normalizer startup or downgrade a typed report', async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'stroq-unbuilt-doctor-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const absent = join(directory, 'unbuilt', 'control-schema.js');
  await writeFile(
    join(directory, 'runtime-layout.mjs'),
    `export const requests=[];export function runtimeLayout(){return {adapter(name){requests.push(name);if(name!=='control-schema.js')throw Error('unexpected-adapter');return ${JSON.stringify(absent)};}};}`,
  );
  await writeFile(
    join(directory, 'control-reports.mjs'),
    await readFile(new URL('./control-reports.mjs', import.meta.url)),
  );
  const imported = await import(pathToFileURL(join(directory, 'control-reports.mjs')).href);
  const layout = await import(pathToFileURL(join(directory, 'runtime-layout.mjs')).href);
  assert.deepEqual(layout.requests, ['control-schema.js']);
  const legacy = imported.normalizeReport('doctor', {
    version: 1,
    ok: true,
    checks: [{ name: 'hooks', ok: true, detail: 'PRIVATE_LEGACY_TEXT' }],
  });
  assert.equal(control.validateRun(completed(legacy)), true);
  assert.equal(Object.hasOwn(legacy, 'diagnosticsVersion'), false);
  assert.equal(Object.hasOwn(legacy.checks[0], 'diagnostic'), false);
  assert.equal(JSON.stringify(legacy).includes('PRIVATE_LEGACY_TEXT'), false);
  assert.throws(() => imported.normalizeReport('doctor', typed(hook())), {
    message: 'invalid-report',
  });
  await assert.rejects(lstat(absent), { code: 'ENOENT' });
});
