import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { before, after, test } from 'node:test';
import { readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { bundle, fixture, put, preview, apply } from './credential-filter-test-helpers.mjs';

let adapters;
before(async () => {
  adapters = await bundle();
});
after(async () => {
  await adapters?.clean();
});

test('same fixed recipe history is fully disclosed and all target applications are undone', async (t) => {
  const f = await fixture(t, adapters),
    file = await put(join(f.project, '.claude', 'settings.local.json'), '{"foreign":"keep"}\n');
  assert.equal(
    (await apply(f.filters, (await preview(f.filters, 'claude-project')).body)).status,
    200,
  );
  const changed = JSON.parse(await readFile(file, 'utf8'));
  changed.permissions.deny.pop();
  await writeFile(file, JSON.stringify(changed));
  const again = await preview(f.filters, 'claude-project');
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.added, 1);
  assert.equal(again.body.applications, 1);
  assert.equal((await apply(f.filters, again.body)).status, 200);
  const undo = await preview(f.filters, 'claude-project', 'undo-filter');
  assert.equal(undo.status, 200, JSON.stringify(undo.body));
  assert.equal(undo.body.applications, 2);
  assert.equal(undo.body.present, 13);
  assert.equal(undo.body.removed, 13);
  const result = await apply(f.filters, undo.body);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.applications, 2);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).foreign, 'keep');
  const row = (await f.filters.state()).body.targets.find((v) => v.id === 'claude-project');
  assert.equal(row.present, 0);
  assert.equal(row.applications, 0);
  assert.equal(row.undoAvailable, false);
});

test('missing retained copy switches undo preview to surgical fixed-entry removal', async (t) => {
  const f = await fixture(t, adapters),
    file = await put(join(f.project, '.cursorignore'), '# user\n');
  const p = await preview(f.filters);
  assert.equal(p.body.backup, 'copy');
  assert.equal((await apply(f.filters, p.body)).status, 200);
  const manifest = JSON.parse(await readFile(join(f.home, 'harden', 'manifest.json'), 'utf8')),
    id = manifest.files[file][0].backup;
  const digest = createHash('sha256').update(file).digest('hex');
  await rm(join(f.home, 'backups', id, `${digest}.bak`));
  const undo = await preview(f.filters, 'cursor-project', 'undo-filter');
  assert.equal(undo.status, 200, JSON.stringify(undo.body));
  assert.equal(undo.body.operation, 'remove-managed');
  assert.equal(undo.body.backup, 'surgical');
  assert.equal(undo.body.removed, 2);
  assert.equal((await apply(f.filters, undo.body)).status, 200);
  assert.equal(await readFile(file, 'utf8'), '# user\n');
});

test('credential-shaped source keeps no raw backup and undo preserves the foreign credential value', async (t) => {
  const f = await fixture(t, adapters),
    secret = 'fixture-user-password-must-stay-private',
    file = await put(
      join(f.project, '.claude', 'settings.local.json'),
      JSON.stringify({ env: { DATABASE_PASSWORD: secret } }),
    );
  const p = await preview(f.filters, 'claude-project');
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal(p.body.backup, 'none-credential-text');
  assert.ok(!JSON.stringify(p.body).includes(secret));
  assert.equal((await apply(f.filters, p.body)).status, 200);
  const entries = await readdir(join(f.home, 'backups')).catch(() => []);
  assert.equal(entries.length, 0);
  const undo = await preview(f.filters, 'claude-project', 'undo-filter');
  assert.equal(undo.status, 200, JSON.stringify(undo.body));
  assert.equal(undo.body.backup, 'surgical');
  assert.ok(!JSON.stringify(undo.body).includes(secret));
  assert.equal((await apply(f.filters, undo.body)).status, 200);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).env.DATABASE_PASSWORD, secret);
});

test('real shared manifest lock contention has a bounded refusal and consumes no source write', async (t) => {
  const f = await fixture(t, adapters),
    file = await put(join(f.project, '.cursorignore'), '# original\n');
  const p = await preview(f.filters);
  assert.equal(p.status, 200);
  const engine = await import(pathToFileURL(join(adapters.dir, 'engine.js')).href);
  let release, entered;
  const ready = new Promise((done) => {
    entered = done;
  });
  const held = engine.withManifestLock(
    { home: f.home, now: () => new Date(), version: '0.29.0' },
    async () => {
      entered();
      await new Promise((done) => {
        release = done;
      });
    },
  );
  await ready;
  try {
    const start = Date.now(),
      result = await apply(f.filters, p.body);
    assert.equal(result.status, 409, JSON.stringify(result.body));
    assert.equal(result.body.error, 'credential-filter-busy');
    assert.ok(Date.now() - start < 4500);
    assert.equal(await readFile(file, 'utf8'), '# original\n');
  } finally {
    release();
    await held;
  }
});
