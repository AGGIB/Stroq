import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLog } from '../../packages/core/dist/index.js';
import { startServer } from './serve.mjs';
import { createLiveProofService } from './live-proof-service.mjs';

test('agent, incident and live routes preserve browser schemas, consent and source evidence', async (t) => {
  const schemas = await import('../.local-engine/local-api-schema.js');
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'stroq-operational-http-')));
  const userHome = join(dir, 'user'),
    home = join(userHome, '.stroq'),
    project = join(dir, 'project'),
    root = join(dir, 'out');
  await Promise.all([mkdir(userHome), mkdir(project), mkdir(root)]);
  await mkdir(home, { mode: 0o700 });
  await writeFile(join(root, 'index.html'), 'fixture');
  let calls = 0;
  const live = await createLiveProofService({
    platform: 'darwin',
    home,
    userHome,
    project,
    available: async () => ({ available: true, version: '0.28.0' }),
    inspect: async () => ({ policySha256: 'a'.repeat(64), proofs: {} }),
    detect: async () => ({ available: true, version: '1.0.0' }),
    fingerprint: async () => 'b'.repeat(64),
    run: async () => {
      calls++;
      return {
        state: 'inconclusive',
        mode: 'stand-in',
        hostVersion: '1.0.0',
        requestsMade: 0,
        probes: [],
        caveats: [],
        advice: [],
      };
    },
  });
  const app = await startServer({ home, userHome, project, root, port: 0, live });
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const origin = app.url.split('/#')[0],
    headers = {
      Authorization: `Bearer ${app.token}`,
      Origin: origin,
      'Content-Type': 'application/json',
    };
  async function request(path, body, overrides = {}) {
    const response = await fetch(origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...headers, ...overrides },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  }
  for (const path of ['/api/context', '/api/agents', '/api/incidents', '/api/live'])
    assert.equal((await request(path, undefined, { Authorization: 'Bearer wrong' })).status, 401);
  for (const path of [
    '/api/incidents/review',
    '/api/incidents/verify',
    '/api/live/preview',
    '/api/live/start',
    '/api/live/cancel',
  ]) {
    assert.equal((await request(path, {}, { Origin: 'https://other.invalid' })).status, 403);
    assert.equal((await request(path, {}, { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await request(path, { command: 'never-execute', path: '/outside' })).status, 400);
  }
  const context = (await request('/api/context')).body;
  assert.equal(schemas.validateLocalContext(context), true);
  assert.equal(context.workspace.label, 'project');
  assert.equal(JSON.stringify(context).includes(dir), false);
  const agents = (await request('/api/agents')).body;
  assert.equal(schemas.validateAgentStatus(agents), true);
  assert.equal(
    agents.agents.every((a) => a.hostVersion === null),
    true,
  );
  const journal = new AuditLog(join(home, 'audit.jsonl'));
  await journal.append({
    sessionId: 'private-session',
    phase: 'pre',
    tool: 'Bash',
    summary: 'SECRET_SENTINEL',
    classes: ['shell.network'],
    decision: { effect: 'deny', reason: 'private reason' },
  });
  const queue = (await request('/api/incidents')).body;
  assert.equal(schemas.validateIncidents(queue), true);
  assert.equal(queue.incidents.length, 1);
  assert.equal(JSON.stringify(queue).includes('SECRET_SENTINEL'), false);
  const item = queue.incidents[0];
  assert.equal(
    (
      await request('/api/incidents/review', {
        id: item.id,
        expectedEvidenceSha: 'c'.repeat(64),
        status: 'reviewed',
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request('/api/incidents/review', {
        id: item.id,
        expectedEvidenceSha: item.evidenceSha,
        status: 'reviewed',
      })
    ).status,
    200,
  );
  assert.equal((await request('/api/incidents')).body.incidents[0].status, 'reviewed');
  const verified = (await request('/api/incidents/verify', {})).body;
  assert.equal(schemas.validateJournalVerification(verified), true);
  assert.equal(verified.status, 'consistent');
  const state = (await request('/api/live')).body;
  assert.equal(schemas.validateLiveState(state), true);
  assert.equal(calls, 0);
  const preview = (await request('/api/live/preview', { agent: 'claude-code', maxRequests: 3 }))
    .body;
  assert.equal(schemas.validateLivePreview(preview), true);
  assert.equal(calls, 0);
  assert.equal(
    (
      await request('/api/live/start', {
        previewId: preview.id,
        maxRequests: 3,
        acknowledgeSubscriptionUsage: false,
      })
    ).status,
    400,
  );
  const started = await request('/api/live/start', {
    previewId: preview.id,
    maxRequests: 3,
    acknowledgeSubscriptionUsage: true,
  });
  assert.equal(started.status, 202);
  assert.equal(schemas.validateLiveJob(started.body), true);
  let job = started.body;
  for (let i = 0; i < 100 && job.status === 'running'; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    job = (await request(`/api/live/jobs/${job.id}`)).body;
  }
  assert.equal(schemas.validateLiveJob(job), true);
  assert.equal(job.status, 'completed');
  assert.equal(job.result.state, 'inconclusive');
  assert.equal(calls, 1);
});
