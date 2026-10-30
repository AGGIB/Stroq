import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startServer } from './serve.mjs';

test('real local journey: inspect, preview, install, policy impact, review drift and restart history', async (t) => {
  const validate = await import('../.local-engine/local-api-schema.js');
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'stroq-platform-journey-')));
  const userHome = join(dir, 'profile'),
    project = join(dir, 'workspace'),
    home = join(userHome, '.stroq'),
    root = join(dir, 'out');
  await Promise.all([mkdir(userHome), mkdir(project), mkdir(root)]);
  await writeFile(join(root, 'index.html'), '<h1>Platform fixture</h1>');
  const skill = join(project, '.claude', 'skills', 'notes');
  await mkdir(skill, { recursive: true });
  await writeFile(join(skill, 'SKILL.md'), '# Notes\nSummarize documentation.');
  let app = await startServer({ root, home, userHome, project, port: 0 });
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  async function request(path, body) {
    const origin = app.url.split('/#')[0];
    const response = await fetch(origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${app.token}`,
        Origin: origin,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }
  const setup = (await request('/api/agent-setup')).body;
  assert.equal(validate.validateSetupState(setup), true);
  assert.equal(setup.schema, 'stroq-agent-setup/2');
  assert.equal(setup.context.workspace, 'workspace');
  const preview = (
    await request('/api/agent-setup/preview', { agent: 'claude-code', scope: 'project' })
  ).body;
  assert.equal(validate.validateSetupPreview(preview), true);
  assert.equal(preview.verified, false);
  const setupInput = {
    previewId: preview.id,
    confirm: true,
    ...Object.fromEntries(
      Object.entries(preview.needs)
        .filter(([, needed]) => needed)
        .map(([key]) => [key, true]),
    ),
  };
  const install = await request('/api/agent-setup/apply', setupInput);
  assert.equal(install.status, 200);
  assert.equal(validate.validateSetupResult(install.body), true);
  assert.equal(install.body.verified, false);
  assert.ok(
    (await readFile(join(project, '.claude', 'settings.json'), 'utf8')).includes('PreToolUse'),
  );
  assert.equal((await request('/api/agent-setup/apply', setupInput)).status, 409);
  const policy = (await request('/api/policy')).body;
  assert.equal(validate.validatePolicy(policy), true);
  const candidate = await request('/api/policy/preview', {
    expectedRawSha: policy.expectedRawSha,
    changes: { defaultEffect: 'ask' },
  });
  assert.equal(candidate.status, 200);
  assert.equal(validate.validatePolicyPreview(candidate.body), true);
  assert.equal(candidate.body.simulation.replayed.attack > 0, true);
  assert.equal(candidate.body.simulation.newInterruptions > 0, true);
  assert.ok(candidate.body.interruptions.length > 0);
  const commit = {
    previewId: candidate.body.previewId,
    expectedRawSha: candidate.body.expectedRawSha,
    candidateFingerprint: candidate.body.candidateFingerprint,
  };
  assert.equal((await request('/api/policy/apply', commit)).status, 422);
  const applied = await request('/api/policy/apply', { ...commit, acknowledgeInterruptions: true });
  assert.equal(applied.status, 200);
  assert.equal(validate.validatePolicyReceipt(applied.body), true);
  assert.equal((await request('/api/policy')).body.defaultEffect, 'ask');
  const inventory = (await request('/api/inventory')).body;
  assert.equal(validate.validateInventory(inventory), true);
  const item = inventory.items.find((i) => i.name === 'notes');
  assert.ok(item);
  const reviewed = await request('/api/inventory/review', {
    itemId: item.id,
    sha256: item.sha256,
    expectedReviewedSha256: item.reviewedSha256 ?? null,
  });
  assert.equal(reviewed.status, 200);
  assert.equal(validate.validateInventory(reviewed.body), true);
  await writeFile(join(skill, 'SKILL.md'), '# Revised notes\nSummarize release documentation.');
  const drift = (await request('/api/inventory')).body;
  assert.equal(drift.items.find((i) => i.id === item.id).state, 'changed');
  const started = await request('/api/runs', { kind: 'policy-check' });
  assert.equal(started.status, 202);
  assert.equal(validate.validateRun(started.body), true);
  // The engine child is confirmed live by its accepted run; bounded polling waits for that exact ID.
  let run = started.body;
  for (let attempt = 0; attempt < 100 && run.status === 'running'; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    run = (await request(`/api/runs/${run.id}`)).body;
  }
  assert.equal(run.status, 'completed');
  assert.equal(validate.validateRun(run), true);
  const before = (await request('/api/control')).body;
  assert.equal(validate.validateControl(before), true);
  assert.equal(before.history.status, 'ready');
  await app.close();
  app = await startServer({ root, home, userHome, project, port: 0 });
  const restored = (await request('/api/control')).body;
  assert.equal(validate.validateControl(restored), true);
  assert.ok(restored.runs.some((r) => r.id === run.id && r.status === 'completed'));
});
