import test from 'node:test';
import assert from 'node:assert/strict';
import {
  access,
  chmod,
  link,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, config, preview, apply, vault } from './mcp-containment-test-helpers.mjs';

test('state and exact preview are read-only; removal and exact restoration retain private raw bytes', async (t) => {
  const f = await fixture(t);
  const sentinel = join(f.dir, 'never-ran');
  const entry = {
    command: process.execPath,
    args: ['-e', `require('fs').writeFileSync(${JSON.stringify(sentinel)},'bad')`],
    env: { PRIVATE_TOKEN: 'fixture-value-must-never-leak' },
    extra: { nested: true },
  };
  const installed = await config(f, {
    entry,
    doc: {
      unknown: { keep: true },
      mcpServers: {
        notes: entry,
        sibling: {
          type: 'http',
          url: 'https://example.invalid/mcp',
          headers: { Authorization: 'fixture-secret-header' },
        },
      },
    },
  });
  assert.equal((await f.containment.state()).status, 200);
  const p = await preview(f.containment, installed);
  assert.equal(p.status, 200, JSON.stringify(p.body));
  await assert.rejects(access(join(f.userHome, '.stroq')));
  assert.equal(p.body.siblings, 1);
  assert.equal(p.body.evidence, 'configuration');
  assert.equal(p.body.hostEnforcement, false);
  assert.ok(!JSON.stringify(p.body).includes('fixture-value'));
  assert.ok(!JSON.stringify(p.body).includes(sentinel));
  const result = await apply(f.containment, p.body);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const written = JSON.parse(await readFile(installed.file, 'utf8'));
  assert.deepEqual(written.unknown, { keep: true });
  assert.ok(!Object.hasOwn(written.mcpServers, 'notes'));
  assert.equal(written.mcpServers.sibling.headers.Authorization, 'fixture-secret-header');
  assert.deepEqual(
    await readFile(join(vault(f, result.body.recordId), 'before.json')),
    installed.bytes,
  );
  assert.equal(
    (await stat(join(vault(f, result.body.recordId), 'before.json'))).mode & 0o777,
    0o600,
  );
  assert.equal((await stat(vault(f, result.body.recordId))).mode & 0o777, 0o700);
  assert.equal(
    await readFile(join(vault(f, result.body.recordId), '..', '.gitignore'), 'utf8'),
    '*\n',
  );
  const state = await f.containment.state();
  assert.equal(state.body.records[0].status, 'removed');
  assert.equal(state.body.records[0].slot, 'absent');
  const restore = await f.containment.preview({
    action: 'restore-registration',
    recordId: result.body.recordId,
  });
  assert.equal(restore.status, 200, JSON.stringify(restore.body));
  assert.equal((await apply(f.containment, restore.body)).status, 200);
  assert.deepEqual(await readFile(installed.file), installed.bytes);
  assert.equal((await f.containment.state()).body.records[0].status, 'restored');
  await access(join(vault(f, result.body.recordId), 'before.json'));
  await assert.rejects(access(sentinel));
});

test('surgical restore preserves newer unrelated entries, BOM/CRLF layout and current mode', async (t) => {
  const f = await fixture(t),
    installed = await config(f);
  const p = await preview(f.containment, installed),
    removed = await apply(f.containment, p.body);
  const newer = {
    unrelated: 'keep-current',
    mcpServers: { later: { url: 'https://example.invalid/new', opaque: [1, 2] } },
  };
  await writeFile(
    installed.file,
    '\uFEFF' + JSON.stringify(newer, null, '\t').replaceAll('\n', '\r\n'),
  );
  await chmod(installed.file, 0o640);
  const restore = await f.containment.preview({
    action: 'restore-registration',
    recordId: removed.body.recordId,
  });
  assert.equal(restore.status, 200, JSON.stringify(restore.body));
  assert.equal((await apply(f.containment, restore.body)).status, 200);
  const bytes = await readFile(installed.file);
  assert.deepEqual([...bytes.subarray(0, 3)], [239, 187, 191]);
  const text = bytes.toString('utf8').slice(1);
  assert.ok(text.includes('\r\n'));
  assert.ok(!text.endsWith('\n'));
  const doc = JSON.parse(text);
  assert.equal(doc.unrelated, 'keep-current');
  assert.deepEqual(doc.mcpServers.later, newer.mcpServers.later);
  assert.deepEqual(doc.mcpServers.notes, installed.entry);
  assert.equal((await stat(installed.file)).mode & 0o777, 0o640);
});

test('sibling-only drift, identical replacement, mode changes and replay cannot apply stale previews', async (t) => {
  const f = await fixture(t),
    installed = await config(f);
  const p = await preview(f.containment, installed);
  await writeFile(
    installed.file,
    JSON.stringify({ mcpServers: { notes: installed.entry }, changed: true }),
  );
  assert.equal((await apply(f.containment, p.body)).status, 409);
  assert.equal((await apply(f.containment, p.body)).body.error, 'mcp-containment-preview-missing');
  const p2 = await preview(f.containment, installed),
    bytes = await readFile(installed.file);
  await rename(installed.file, installed.file + '.previous');
  await writeFile(installed.file, bytes, { mode: 0o600 });
  assert.equal((await apply(f.containment, p2.body)).status, 409);
  const p3 = await preview(f.containment, installed);
  await chmod(installed.file, 0o640);
  assert.equal((await apply(f.containment, p3.body)).status, 409);
  assert.ok(Object.hasOwn(JSON.parse(await readFile(installed.file, 'utf8')).mcpServers, 'notes'));
});

test('restore refuses occupied slots including null and identical entries, and missing configs', async (t) => {
  const f = await fixture(t),
    installed = await config(f);
  const removed = await apply(f.containment, (await preview(f.containment, installed)).body);
  for (const entry of [null, installed.entry]) {
    await writeFile(installed.file, JSON.stringify({ mcpServers: { notes: entry } }));
    assert.equal(
      (
        await f.containment.preview({
          action: 'restore-registration',
          recordId: removed.body.recordId,
        })
      ).status,
      409,
    );
  }
  await rm(installed.file);
  assert.equal((await f.containment.state()).body.records[0].status, 'config-missing');
  assert.equal(
    (
      await f.containment.preview({
        action: 'restore-registration',
        recordId: removed.body.recordId,
      })
    ).status,
    409,
  );
  await assert.rejects(access(installed.file));
});

test('malformed JSON, duplicate keys, lossy numbers and unsafe source links never write', async (t) => {
  const f = await fixture(t),
    installed = await config(f);
  const entry = JSON.stringify(installed.entry);
  for (const text of [
    `{"mcpServers":{"notes":${entry},"notes":${entry}}}`,
    `{"mcpServers":{"notes":${entry}},"x":-0}`,
    `{"mcpServers":{"notes":${entry}},"x":9007199254740993}`,
    `{"mcpServers":{"notes":${entry}},}`,
  ]) {
    await writeFile(installed.file, text);
    assert.equal((await preview(f.containment, installed)).status, 409);
    assert.equal(await readFile(installed.file, 'utf8'), text);
  }
  await writeFile(installed.file, installed.bytes);
  await rename(installed.file, installed.file + '.target');
  await symlink(installed.file + '.target', installed.file);
  assert.equal((await preview(f.containment, installed)).status, 409);
  await rm(installed.file);
  await link(installed.file + '.target', installed.file);
  assert.equal((await preview(f.containment, installed)).status, 409);
  await assert.rejects(access(join(f.userHome, '.stroq')));
});

test('interrupted removal keeps durable intent, derives actual absence and supports deliberate restore after restart', async (t) => {
  const f = await fixture(t, { fault: 'before-final-manifest' }),
    installed = await config(f);
  const p = await preview(f.containment, installed),
    result = await apply(f.containment, p.body);
  assert.equal(result.status, 422);
  assert.equal(result.body.error, 'mcp-containment-recovery-required');
  const restarted = f.service({ fault: null });
  const state = await restarted.state();
  assert.equal(state.body.records[0].status, 'recovery-required');
  assert.equal(state.body.records[0].slot, 'absent');
  assert.equal(state.body.records[0].payload, 'match');
  const restore = await restarted.preview({
    action: 'restore-registration',
    recordId: p.body.recordId,
  });
  assert.equal(restore.status, 200, JSON.stringify(restore.body));
  assert.equal((await apply(restarted, restore.body)).status, 200);
  assert.deepEqual(await readFile(installed.file), installed.bytes);
});

test('tampered payloads remain visible and block restore and new mutations', async (t) => {
  const f = await fixture(t),
    installed = await config(f);
  const removed = await apply(f.containment, (await preview(f.containment, installed)).body);
  await writeFile(join(vault(f, removed.body.recordId), 'before.json'), 'changed');
  const state = await f.containment.state();
  assert.equal(state.body.records[0].status, 'changed');
  assert.equal(state.body.records[0].payload, 'changed');
  assert.notEqual(
    (
      await f.containment.preview({
        action: 'restore-registration',
        recordId: removed.body.recordId,
      })
    ).status,
    200,
  );
});

test('runtime drift, expiry, strict acknowledgement and unavailable runtime cannot create writes', async (t) => {
  let current = Date.now(),
    runtime = 'a'.repeat(64);
  const f = await fixture(t, { now: () => current, runtimeDigest: async () => runtime }),
    installed = await config(f);
  const p = await preview(f.containment, installed);
  assert.equal(
    (
      await f.containment.apply({
        previewId: p.body.id,
        confirm: true,
        acknowledgeSessionLimits: true,
      })
    ).status,
    400,
  );
  runtime = 'b'.repeat(64);
  assert.equal((await apply(f.containment, p.body)).body.error, 'mcp-containment-preview-stale');
  const p2 = await preview(f.containment, installed);
  current += 120_001;
  assert.equal((await apply(f.containment, p2.body)).body.error, 'mcp-containment-preview-expired');
  const unreadable = f.service({
    runtimeDigest: async () => {
      throw new Error('private-runtime-path');
    },
  });
  const state = await unreadable.state();
  assert.equal(state.status, 200);
  assert.equal(state.body.available, false);
  assert.equal(state.body.reason, 'runtime-unavailable');
  await assert.rejects(access(join(f.userHome, '.stroq')));
});

test('supported source scopes work; Windsurf and unverified Linux Desktop are refused', async (t) => {
  for (const [agent, scope] of [
    ['cursor', 'project'],
    ['cursor', 'user'],
    ['claude-desktop', 'user'],
  ]) {
    const f = await fixture(t),
      installed = await config(f, { agent, scope });
    const p = await preview(f.containment, installed);
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.equal((await apply(f.containment, p.body)).status, 200);
  }
  const f = await fixture(t),
    installed = await config(f, { agent: 'windsurf', scope: 'user' });
  assert.equal((await preview(f.containment, installed)).status, 503);
});

test('foreign project records are not followed; user registration restore works across workspace contexts', async (t) => {
  const f = await fixture(t),
    projectConfig = await config(f);
  const removedProject = await apply(
    f.containment,
    (await preview(f.containment, projectConfig)).body,
  );
  const secondProject = join(f.dir, 'second-project');
  await mkdir(secondProject, { mode: 0o700 });
  const second = f.service({ project: secondProject });
  const state = await second.state();
  assert.equal(state.body.records[0].status, 'unverifiable');
  assert.equal(state.body.records[0].configSha256, null);
  assert.equal(
    (
      await second.preview({
        action: 'restore-registration',
        recordId: removedProject.body.recordId,
      })
    ).status,
    409,
  );
  const userConfig = await config(f, { agent: 'cursor', scope: 'user' });
  const removedUser = await apply(f.containment, (await preview(f.containment, userConfig)).body);
  const restore = await second.preview({
    action: 'restore-registration',
    recordId: removedUser.body.recordId,
  });
  assert.equal(restore.status, 200, JSON.stringify(restore.body));
  assert.equal((await apply(second, restore.body)).status, 200);
  assert.deepEqual(await readFile(userConfig.file), userConfig.bytes);
});

test('duplicate private manifest keys are refused instead of silently reinterpreted', async (t) => {
  const f = await fixture(t),
    installed = await config(f);
  const removed = await apply(f.containment, (await preview(f.containment, installed)).body);
  const path = join(vault(f, removed.body.recordId), 'manifest.json');
  const raw = await readFile(path, 'utf8');
  await writeFile(path, raw.replace('{', '{"phase":"prepared",'));
  const state = await f.containment.state();
  assert.equal(state.status, 200);
  assert.equal(state.body.available, false);
  assert.ok(state.body.gaps.some((gap) => gap.code === 'record-invalid'));
  assert.equal(
    (
      await f.containment.preview({
        action: 'restore-registration',
        recordId: removed.body.recordId,
      })
    ).status,
    503,
  );
});
