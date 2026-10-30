import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { tsImport } from 'tsx/esm/api';
import { fileURLToPath } from 'node:url';
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const loader = await mkdtemp(join(tmpdir(), 'stroq-call-proxy-loader-'));
after(() => rm(loader, { recursive: true, force: true }));
const tsconfig = join(loader, 'tsconfig.json');
await writeFile(
  tsconfig,
  JSON.stringify({
    compilerOptions: {
      baseUrl: repositoryRoot,
      paths: { '@stroq/core': ['packages/core/src/index.ts'] },
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
    },
  }),
);
const { callControlProxy } = await tsImport('./mcp-call-control-proxy.ts', {
  parentURL: import.meta.url,
  tsconfig,
});
const uuid = '00000000-0000-4000-8000-000000000001';
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'stroq-call-proxy-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const x of ['project', 'user', 'dist']) await mkdir(join(root, x), { mode: 0o700 });
  return {
    project: join(root, 'project'),
    runtime: {
      command: process.execPath,
      entry: join(root, 'dist', 'index.js'),
      home: join(root, 'user', '.stroq'),
      userHome: join(root, 'user'),
      fingerprint: 'a'.repeat(64),
    },
  };
}
test('plain setup preserves siblings and launch, adds ordinary paused control without execution', async (t) => {
  const f = await fixture(t),
    original = {
      command: '/never-execute',
      args: ['--strict'],
      env: { TOKEN: 'private' },
      custom: { a: 1 },
    };
  const p = callControlProxy(original, 'notes', 'claude-code', f.runtime, f.project, uuid);
  assert.equal(p.invocation.command, original.command);
  assert.deepEqual(p.invocation.args, original.args);
  assert.equal(p.invocation.strict, undefined);
  assert.equal(p.invocation.callControlId, uuid);
  assert.equal(p.entry.env.STROQ_HOME, f.runtime.home);
  assert.deepEqual(p.entry.custom, { a: 1 });
  assert.equal(p.entry.env.TOKEN, 'private');
});
test('legal current wrapper modes survive without a security downgrade', async (t) => {
  const f = await fixture(t);
  for (const flags of [
    [],
    ['--strict'],
    ['--strict', '--tool-approval'],
    ['--cloak'],
    ['--strict', '--cloak'],
    ['--pin', 'sha256:' + 'b'.repeat(64)],
  ]) {
    const args = [
      f.runtime.entry,
      'mcp',
      '--server',
      'notes',
      '--client',
      'claude-code',
      '--cwd',
      f.project,
      '--pass-env',
      'TOKEN',
      ...flags,
      '--',
      '/never-execute',
      'x',
    ];
    const original = {
      command: process.execPath,
      args,
      env: {
        STROQ_HOME: f.runtime.home,
        HOME: f.runtime.userHome,
        USERPROFILE: f.runtime.userHome,
        TOKEN: 'private',
      },
    };
    const p = callControlProxy(original, 'notes', 'claude-code', f.runtime, f.project, uuid);
    assert.deepEqual(
      p.entry.args.filter((x) => x !== uuid && x !== '--call-control'),
      args,
    );
    assert.equal(p.invocation.callControlId, uuid);
  }
});
test('foreign runtime, implicit profile and unknown environment are refused', async (t) => {
  const f = await fixture(t);
  const args = [
    f.runtime.entry,
    'mcp',
    '--server',
    'notes',
    '--client',
    'claude-code',
    '--cwd',
    f.project,
    '--pass-env',
    '',
    '--',
    '/never',
  ];
  assert.throws(
    () =>
      callControlProxy(
        { command: process.execPath, args },
        'notes',
        'claude-code',
        f.runtime,
        f.project,
        uuid,
      ),
    /mcp-call-control-unsupported/,
  );
  assert.throws(
    () =>
      callControlProxy(
        { command: '/never', env: { NODE_OPTIONS: '--eval=bad' } },
        'notes',
        'claude-code',
        f.runtime,
        f.project,
        uuid,
      ),
    /mcp-call-control-unsupported/,
  );
});
