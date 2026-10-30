import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { startServer } from './serve.mjs';

test('real HTTP Codex path disable and retained Restore survive source removal and server restart', async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'stroq-skill-control-http-')));
  const project = join(base, 'project'),
    userHome = join(base, 'user'),
    root = join(base, 'out');
  const config = join(userHome, '.codex', 'config.toml');
  const document = join(project, '.agents', 'skills', 'notes', 'SKILL.md');
  const other = join(userHome, '.agents', 'skills', 'notes', 'SKILL.md');
  const original = Buffer.from('# original retained comment\nmodel_reasoning_effort = "low"\n');
  const skill =
    '---\nname: notes\ndescription: Summarize inert fixture notes.\n---\nSummarize inert fixture notes.\n';
  await Promise.all([mkdir(project), mkdir(userHome), mkdir(root)]);
  for (const path of [config, document, other])
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await Promise.all([
    writeFile(config, original, { mode: 0o600 }),
    writeFile(document, skill),
    writeFile(other, skill),
    writeFile(join(root, 'index.html'), 'fixture'),
  ]);
  let app;
  t.after(async () => {
    await app?.close();
    await rm(base, { recursive: true, force: true });
  });
  const launch = async () => {
    app = await startServer({ project, userHome, root, port: 0 });
  };
  await launch();
  const schema = await import('../.local-engine/inventory-schema.js');
  const request = async (path, body, expected = 200) => {
    const origin = app.url.split('/#')[0];
    const response = await fetch(origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${app.token}`,
        Origin: origin,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(35000),
    });
    const value = await response.json();
    assert.equal(response.status, expected, path + ': ' + JSON.stringify(value));
    assert(!JSON.stringify(value).includes(base), 'HTTP leaked a private absolute fixture path');
    return value;
  };
  const state = await request('/api/inventory/codex-controls');
  assert(schema.validateCodexSkillControlState(state));
  assert.equal(state.history, 'missing');
  await assert.rejects(access(join(userHome, '.stroq', 'codex-skill-controls')));
  const report = await request('/api/inventory/codex-sources', {});
  const item = report.items.find(
    (i) =>
      i.location.label === 'notes' &&
      report.sources.some((s) => s.id === i.sourceId && s.scope === 'cwd'),
  );
  assert(item);
  const selection = {
    operation: 'disable',
    controlContextId: report.context.controlContextId,
    sourceId: item.sourceId,
    candidateId: item.id,
    expectedEntrypointSha256: item.entrypointSha256,
    expectedConfigSha256: report.settings.sha256,
    expectedRuntimeSha256: report.runtimeSha256,
  };
  const preview = () => request('/api/inventory/codex-control-preview', selection);
  const rejected = await preview();
  assert(schema.validateCodexSkillControlPreview(rejected));
  await request(
    '/api/inventory/codex-control-apply',
    { previewId: rejected.id, controlContextId: rejected.controlContextId },
    400,
  );
  const apply = (p, extra = {}) =>
    request('/api/inventory/codex-control-apply', {
      previewId: p.id,
      controlContextId: p.controlContextId,
      acknowledgeSharedUserConfig: true,
      acknowledgeRetention: true,
      ...extra,
    });
  await request(
    '/api/inventory/codex-control-apply',
    {
      previewId: rejected.id,
      controlContextId: rejected.controlContextId,
      acknowledgeSharedUserConfig: true,
      acknowledgeRetention: true,
    },
    409,
  );
  assert.deepEqual(await readFile(config), original);
  const staleSource = await preview();
  await writeFile(document, skill + '\nLater inert text.\n');
  const stale = await request(
    '/api/inventory/codex-control-apply',
    {
      previewId: staleSource.id,
      controlContextId: staleSource.controlContextId,
      acknowledgeSharedUserConfig: true,
      acknowledgeRetention: true,
    },
    409,
  );
  assert.equal(stale.error, 'codex-control-stale');
  assert.deepEqual(await readFile(config), original);
  await writeFile(document, skill);
  const p = await preview();
  assert.equal(p.sameNameCopies, 1);
  await assert.rejects(access(join(userHome, '.stroq', 'codex-skill-controls')));
  const disabled = await apply(p);
  assert(schema.validateCodexSkillControlReceipt(disabled));
  assert.equal(disabled.writeConfirmed, true);
  assert.equal(disabled.record.standing, 'disabled');
  const changed = await readFile(config);
  assert(changed.includes(Buffer.from(JSON.stringify(document))));
  assert(changed.includes(Buffer.from('enabled = false')));
  assert.equal(await readFile(document, 'utf8'), skill);
  assert.equal(await readFile(other, 'utf8'), skill);
  const fresh = await request('/api/inventory/codex-sources', {});
  assert.equal(fresh.items.find((i) => i.id === item.id).declaredState, 'disabled');
  assert.equal(fresh.items.filter((i) => i.declaredState === 'disabled').length, 1);
  const external = Buffer.from('# later external comment\nmodel_verbosity = "low"\n');
  await writeFile(config, Buffer.concat([external, changed]));
  await rm(dirname(document), { recursive: true });
  await app.close();
  app = null;
  await launch();
  const retained = await request('/api/inventory/codex-controls');
  assert.equal(retained.records[0].id, disabled.record.id);
  assert.equal(retained.records[0].canRestore, true);
  const restore = await request('/api/inventory/codex-control-preview', {
    operation: 'restore',
    controlContextId: retained.controlContextId,
    recordId: retained.records[0].id,
    recordRevision: retained.records[0].revision,
  });
  const restored = await apply(restore, { acknowledgeWeakening: true });
  assert(schema.validateCodexSkillControlReceipt(restored));
  assert.equal(restored.record.operationStatus, 'restored');
  assert.deepEqual(await readFile(config), Buffer.concat([external, original]));
  assert.equal(await readFile(other, 'utf8'), skill);
  await assert.rejects(access(document));
});
