import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from './serve.mjs';
import { createSecretScanService } from './secret-scan-service.mjs';
import { SECRET_LIMITATIONS } from './secret-scan-safe.mjs';

test('credential HTTP routes enforce consent, exact schemas and read-only state', async (t) => {
  const schemas = await import('../.local-engine/local-api-schema.js');
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'stroq-secrets-http-')));
  const root = join(dir, 'out'),
    userHome = join(dir, 'user'),
    project = join(dir, 'project');
  await Promise.all([mkdir(root), mkdir(userHome), mkdir(project)]);
  const home = join(userHome, '.stroq');
  await writeFile(join(root, 'index.html'), 'fixture');
  let scans = 0;
  const result = {
    schema: 'stroq-secret-scan-report/1',
    source: 'local',
    scope: 'project',
    checkedAt: '2026-10-23T06:00:00.000Z',
    evidence: 'recorded-transcripts',
    complete: true,
    sessions: { total: 1, claudeCode: 1, codex: 0, cursor: 0, skipped: 0 },
    keys: {
      compared: 1,
      sourceFiles: 1,
      environment: 0,
      unreadableFiles: 0,
      partialFiles: 0,
      skippedFiles: 0,
      rejectedLines: 0,
      truncated: false,
    },
    totals: {
      findings: 0,
      external: 0,
      uncertain: 0,
      modelVisible: 0,
      ownService: 0,
      reportedStopped: 0,
    },
    findings: [],
    omittedFindings: 0,
    notChecked: [],
    limitations: [...SECRET_LIMITATIONS],
  };
  const secrets = await createSecretScanService({
    home,
    userHome,
    project,
    environment: {},
    available: async () => ({ available: true, version: '0.28.0' }),
    fingerprint: async () => 'runtime-fixture',
    run: async () => {
      scans++;
      return result;
    },
  });
  const app = await startServer({ root, userHome, project, home, port: 0, secrets });
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const origin = app.url.split('/#')[0];
  const headers = {
    Authorization: `Bearer ${app.token}`,
    Origin: origin,
    'Content-Type': 'application/json',
  };
  const request = async (path, body, extra = {}) => {
    const response = await fetch(origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...headers, ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  assert.equal(
    (await request('/api/secrets', undefined, { Authorization: 'Bearer wrong' })).status,
    401,
  );
  const state = await request('/api/secrets');
  assert.equal(state.status, 200);
  assert.equal(schemas.validateSecretScanState(state.body), true);
  assert.deepEqual(state.body.jobs, []);
  assert.equal(scans, 0);
  for (const action of ['preview', 'start', 'cancel']) {
    const path = `/api/secrets/${action}`;
    assert.equal((await request(path)).status, 405);
    assert.equal((await request(path, {}, { Origin: 'https://other.invalid' })).status, 403);
    assert.equal((await request(path, {}, { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await request(path, { path: '/outside', command: 'never-run' })).status, 400);
  }
  assert.equal((await request('/api/secrets/preview', { scope: 'machine' })).status, 400);
  const preview = await request('/api/secrets/preview', { scope: 'project' });
  assert.equal(preview.status, 200);
  assert.equal(schemas.validateSecretScanPreview(preview.body), true);
  assert.equal(scans, 0);
  const start = { previewId: preview.body.id, acknowledgeCredentialRead: true };
  assert.equal(
    (await request('/api/secrets/start', { ...start, acknowledgeCredentialRead: false })).status,
    400,
  );
  const started = await request('/api/secrets/start', start);
  assert.equal(started.status, 202);
  assert.equal(schemas.validateSecretScanJob(started.body), true);
  let job;
  for (let i = 0; i < 30; i++) {
    job = await request(`/api/secrets/jobs/${started.body.id}`);
    if (job.body.status !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(job.status, 200);
  assert.equal(job.body.status, 'completed');
  assert.equal(schemas.validateSecretScanJob(job.body), true);
  assert.equal(schemas.validateSecretScanReport(job.body.result), true);
  assert.equal(scans, 1);
  assert.equal((await request('/api/secrets/start', start)).status, 409);
  assert.equal(
    (await request('/api/secrets/cancel', { jobId: started.body.id })).body.status,
    'completed',
  );
  assert.equal((await request('/api/secrets/jobs/not-a-job')).status, 404);
  const final = await request('/api/secrets');
  assert.equal(schemas.validateSecretScanState(final.body), true);
  assert.equal(final.body.jobs.length, 1);
  assert.equal(JSON.stringify(final.body).includes(dir), false);
});
