import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { executeSecretScan, secretEnvironment } from './secret-scan-process.mjs';
import { projectSecretReport } from './secret-scan-safe.mjs';

test('process environment strips credential values, Node loaders and user-controlled runtime flags', () => {
  const env = secretEnvironment({
    userHome: '/fixture/home',
    home: '/fixture/stroq',
    environment: {
      PATH: '/fixture/bin',
      OPENAI_API_KEY: 'SECRET_SENTINEL',
      NODE_OPTIONS: '--require evil.js',
      NODE_PATH: '/evil',
      NODE_V8_COVERAGE: '/evil',
      CLAUDE_CONFIG_DIR: '/fixture/claude',
    },
  });
  assert.equal(env.HOME, '/fixture/home');
  assert.equal(env.CLAUDE_CONFIG_DIR, '/fixture/claude');
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.NODE_PATH, undefined);
  assert.equal(env.NODE_V8_COVERAGE, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
});

async function fixture(source, run) {
  const root = await mkdtemp(join(tmpdir(), 'stroq-secret-process-'));
  const adapter = join(root, 'adapter.mjs');
  await writeFile(adapter, source);
  try {
    await run({
      adapter,
      project: root,
      userHome: root,
      home: join(root, '.stroq'),
      environment: {},
      timeoutMs: 1000,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
const report = () =>
  projectSecretReport(
    {
      schema: 'stroq-sent/2',
      scope: 'project',
      checked: '2026-10-22T00:00:00.000Z',
      sessions: { total: 0, agents: {} },
      keys: { compared: 0, files: [], env: 0, unreadable: 0 },
      findings: [],
      notChecked: ['no-sessions'],
      complete: false,
    },
    'project',
  );

test('stdout and stderr are discarded; only a strictly projected IPC report reaches caller', async () => {
  await fixture(
    `process.once('message',()=>{process.stdout.write('PRIVATE_STDOUT_SENTINEL');process.stderr.write('PRIVATE_STDERR_SENTINEL');process.send({type:'result',result:${JSON.stringify(report())}},()=>process.disconnect());});`,
    async (options) => {
      const result = await executeSecretScan({ scope: 'project' }, options);
      assert.equal(result.schema, 'stroq-secret-scan-report/1');
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE_.*SENTINEL/);
    },
  );
});

test('raw/unexpected IPC output fails closed without leaking its contents', async () => {
  await fixture(
    `process.once('message',()=>process.send({type:'result',result:{credential:'PRIVATE_TOKEN_SENTINEL'}}));`,
    async (options) => {
      await assert.rejects(executeSecretScan({ scope: 'project' }, options), {
        message: 'invalid-report',
      });
    },
  );
});

test('noisy workers, workers exceeding deadline and cancellation are terminated', async () => {
  await fixture(
    `process.once('message',()=>{process.stdout.write('x'.repeat(65537));setInterval(()=>{},1000)});`,
    async (options) => {
      await assert.rejects(executeSecretScan({ scope: 'project' }, options), {
        message: 'output-limit',
      });
    },
  );
  await fixture(`process.once('message',()=>setInterval(()=>{},1000));`, async (options) => {
    await assert.rejects(executeSecretScan({ scope: 'project' }, { ...options, timeoutMs: 30 }), {
      message: 'deadline-exceeded',
    });
    const controller = new AbortController();
    const running = executeSecretScan(
      { scope: 'project' },
      { ...options, signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(running, { message: 'cancelled' });
  });
});
