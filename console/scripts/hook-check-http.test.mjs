import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { createHookCheckService } from './hook-check-service.mjs';
import { startServer } from './serve.mjs';
import * as schema from '../.local-engine/local-api-schema.js';
import { expectedConfiguration } from '../.local-engine/agent-status-engine.js';

const SHA = 'a'.repeat(64);
const finished = () => ({
  status: 'passed',
  standard: { ordinaryAllowed: true, encodedDenied: true },
  probes: ['ordinary', 'encoded-fetch'].map((id) => {
    const effect = id === 'ordinary' ? 'allow' : 'deny';
    return {
      id,
      expectedEffect: effect,
      expectedWire: effect,
      observedEffect: effect,
      wireEffect: effect,
      auditConfirmed: true,
      exitCode: 0,
      durationMs: 1,
      matched: true,
    };
  }),
});
async function fixture(
  t,
  { agent = 'cursor', realSource = false, retainedBytes = 0, ...overrides } = {},
) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'stroq-hook-http-')));
  const project = join(directory, 'workspace'),
    userHome = join(directory, 'profile'),
    home = join(userHome, '.stroq'),
    root = join(directory, 'out');
  await Promise.all([mkdir(project), mkdir(userHome), mkdir(root)]);
  await writeFile(join(root, 'index.html'), 'fixture');
  const workspaceId = `workspace-${createHash('sha256').update(project).digest('hex').slice(0, 24)}`;
  const source = join(project, '.cursor/hooks.json');
  if (realSource) {
    const cli = new URL('../../packages/cli/dist/index.js', import.meta.url).pathname;
    await mkdir(dirname(source));
    await writeFile(
      source,
      JSON.stringify(expectedConfiguration(agent, `"${process.execPath}" "${cli}" hook ${agent}`)),
      { mode: 0o600 },
    );
  }
  let calls = 0;
  const service = await createHookCheckService({
    project,
    userHome,
    home,
    workspaceId,
    available: async () => ({ available: true, version: '0.28.0' }),
    runtimeDigest: async () => SHA,
    loadValidator: async () => schema,
    ...(!realSource
      ? {
          capture: async ({ agent, scope }) => ({
            binding: {
              workspaceId,
              agent,
              scope,
              sourceSha256: SHA,
              policySha256: null,
              policySemanticSha256: SHA,
              runtimeSha256: SHA,
            },
            policyText: null,
            private: { retained: Buffer.alloc(retainedBytes) },
            memoryBytes: retainedBytes + 128,
          }),
        }
      : {}),
    run: async () => {
      calls++;
      return finished();
    },
    ...overrides,
  });
  const app = await startServer({ project, userHome, home, root, hookChecks: service, port: 0 });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const origin = app.url.split('/#')[0];
  async function request(path, body, headers = {}) {
    const response = await fetch(origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${app.token}`,
        Origin: origin,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  }
  const preview = () => request('/api/hook-checks/preview', { agent, scope: 'project' });
  return {
    directory,
    project,
    userHome,
    home,
    source,
    service,
    request,
    preview,
    calls: () => calls,
  };
}
async function terminal(f, id) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await f.request(`/api/hook-checks/jobs/${id}`);
    assert.equal(response.status, 200);
    if (response.body.status !== 'running') return response.body;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('fixture job did not finish');
}

test('actual HTTP hook-check routes enforce auth, origin, methods, media, bounds and closed fields before starting', async (t) => {
  const f = await fixture(t);
  assert.equal(schema.validateHookCheckState((await f.request('/api/hook-checks')).body), true);
  const preview = await f.preview();
  assert.equal(schema.validateHookCheckPreview(preview.body), true);
  assert.equal(f.calls(), 0);
  for (const [input, headers, expected] of [
    [{ previewId: preview.body.id }, { Authorization: '' }, 401],
    [{ previewId: preview.body.id }, { Origin: 'https://foreign.invalid' }, 403],
    [{ previewId: preview.body.id }, { 'Content-Type': 'text/plain' }, 415],
    [Buffer.from([0xff]), {}, 400],
    [Buffer.alloc(4097), {}, 413],
    [{ previewId: preview.body.id, command: 'never', environment: {} }, {}, 400],
    [{ previewId: '../outside' }, {}, 400],
  ])
    assert.equal((await f.request('/api/hook-checks/start', input, headers)).status, expected);
  assert.equal((await f.request('/api/hook-checks/start')).status, 405);
  assert.equal(
    (
      await f.request('/api/hook-checks/preview', {
        agent: 'cursor',
        scope: 'project',
        path: '/outside',
      })
    ).status,
    400,
  );
  assert.equal(f.calls(), 0);
  await assert.rejects(readdir(f.home), { code: 'ENOENT' });
  const started = await f.request('/api/hook-checks/start', { previewId: preview.body.id });
  assert.equal(started.status, 202);
  assert.equal(schema.validateHookCheckJob(started.body), true);
  assert.equal(started.body.previewId, preview.body.id);
  const completed = await terminal(f, started.body.id);
  assert.equal(schema.validateHookCheckJob(completed), true);
  assert.equal(completed.result.hostEnforcement, false);
  assert.equal(completed.result.providerRequests, 0);
  assert.equal(f.calls(), 1);
  assert.equal(
    (await f.request(`/api/hook-checks/jobs/${started.body.id}`, undefined, { Authorization: '' }))
      .status,
    401,
  );
  assert.equal((await f.request('/api/hook-checks/jobs/not-a-uuid')).status, 404);
  assert.equal(schema.validateHookCheckState((await f.request('/api/hook-checks')).body), true);
});

test('actual HTTP hook-check routes do not offer windsurf and refuse a preview for it', async (t) => {
  const f = await fixture(t);
  const state = await f.request('/api/hook-checks');
  assert.equal(schema.validateHookCheckState(state.body), true);
  assert.deepEqual(
    state.body.agents.map((agent) => agent.id),
    ['claude-code', 'codex', 'cursor'],
  );
  for (const scope of ['project', 'user']) {
    const refused = await f.request('/api/hook-checks/preview', { agent: 'windsurf', scope });
    assert.deepEqual(refused, { status: 400, body: { error: 'invalid-request' } });
  }
  assert.equal(f.calls(), 0);
  await assert.rejects(readdir(f.home), { code: 'ENOENT' });
});

test('eight-plan count and aggregate private-capture memory bounds evict only unused previews', async (t) => {
  for (const [retainedBytes, count] of [
    [0, 9],
    [1536 * 1024, 6],
  ])
    await t.test(`${retainedBytes} retained bytes`, async (t) => {
      const f = await fixture(t, { retainedBytes });
      const previews = [];
      for (let index = 0; index < count; index++) previews.push((await f.preview()).body);
      assert.equal(
        (await f.request('/api/hook-checks/start', { previewId: previews[0].id })).status,
        409,
      );
      assert.equal(f.calls(), 0);
      const accepted = await f.request('/api/hook-checks/start', { previewId: previews.at(-1).id });
      assert.equal(accepted.status, 202);
      assert.equal((await terminal(f, accepted.body.id)).status, 'completed');
      assert.equal(f.calls(), 1);
    });
});

test('terminal reports remain running until persistence resolves and failed persistence never exposes a pass', async (t) => {
  for (const succeeds of [true, false])
    await t.test(String(succeeds), async (t) => {
      let release,
        entered,
        state = { status: 'ready' };
      const saving = new Promise((resolve) => {
        entered = resolve;
      });
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      const store = {
        runs: [],
        state: () => state,
        write: async (jobs) => {
          if (!jobs.some((job) => job.status === 'completed')) return true;
          entered();
          await gate;
          if (!succeeds) state = { status: 'error', error: 'write-failed' };
          return succeeds;
        },
      };
      const f = await fixture(t, { store });
      const preview = await f.preview(),
        accepted = await f.request('/api/hook-checks/start', { previewId: preview.body.id });
      await saving;
      assert.equal(f.service.getJob(accepted.body.id).status, 'running');
      release();
      const done = await terminal(f, accepted.body.id);
      assert.equal(done.status, succeeds ? 'completed' : 'failed');
      if (!succeeds) {
        assert.equal(done.error, 'history-unavailable');
        assert.equal(done.result, undefined);
      }
    });
});

test('disabled Windows and invalid sources/policy are explicit refusals', async (t) => {
  for (const kind of ['windows', 'missing-hooks', 'duplicate-json', 'invalid-policy'])
    await t.test(kind, async (t) => {
      const f = await fixture(t, {
        realSource: true,
        agent: 'cursor',
        ...(kind === 'windows' ? { platform: 'win32' } : {}),
      });
      if (kind === 'missing-hooks') await writeFile(f.source, '{}');
      if (kind === 'duplicate-json') await writeFile(f.source, '{"hooks":{},"hooks":{}}');
      if (kind === 'invalid-policy') {
        await mkdir(f.home, { mode: 0o700 });
        await writeFile(join(f.home, 'policy.yaml'), '{broken');
      }
      const preview = await f.preview();
      assert.equal(preview.status, 200, JSON.stringify(preview));
      assert.equal(schema.validateHookCheckPreview(preview.body), true);
      assert.equal(preview.body.canStart, false);
      assert.equal(preview.body.binding, null);
      const expected = {
        windows: 'platform-unsupported',
        'missing-hooks': 'hooks-not-configured',
        'duplicate-json': 'configuration-unreadable',
        'invalid-policy': 'policy-unavailable',
      };
      assert.equal(preview.body.reason, expected[kind]);
      assert.equal(f.calls(), 0);
      assert.ok(!JSON.stringify(preview).includes('SOURCE_PRIVATE_SENTINEL'));
    });
});

test('creating an unsafe home during the running-intent write cannot be adopted as current policy context', async (t) => {
  let home;
  const store = {
    runs: [],
    state: () => ({ status: 'ready' }),
    write: async () => {
      await mkdir(home, { recursive: true });
      await chmod(home, 0o777);
      return true;
    },
  };
  const f = await fixture(t, { realSource: true, store });
  home = f.home;
  const preview = await f.preview();
  assert.equal(preview.body.canStart, true);
  const refused = await f.request('/api/hook-checks/start', { previewId: preview.body.id });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, 'preview-stale');
  assert.equal(f.calls(), 0);
  assert.equal((await f.request('/api/hook-checks')).body.jobs[0].status, 'failed');
});
