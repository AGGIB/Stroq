import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'tsup';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = await realpath(await mkdtemp(join(tmpdir(), 'stroq-signal-store-engine-')));
after(() => rm(output, { recursive: true, force: true }));
await build({
  entry: { store: join(repository, 'console/scripts/inventory-signal-store.ts') },
  outDir: output,
  outExtension: () => ({ js: '.mjs' }),
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  splitting: false,
  config: false,
  dts: false,
  silent: true,
});
const store = await import(pathToFileURL(join(output, 'store.mjs')).href);
const workspaceId = `workspace-${'a'.repeat(24)}`;
const contextSha256 = 'b'.repeat(64);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const record = (overrides = {}) => ({
  id: randomUUID(),
  binding: {
    workspaceId,
    itemId: `item-${'c'.repeat(24)}`,
    agent: 'claude-code',
    skillSource: 'claude-skills',
    scope: 'project',
    artifactSha256: 'd'.repeat(64),
    sourceSha256: 'e'.repeat(64),
    analysisSha256: 'f'.repeat(64),
  },
  decision: 'accepted-risk',
  reason: 'required-use',
  recordedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});
const document = (records = []) => ({
  schema: 'stroq-inventory-signal-store/1',
  workspaceId,
  contextSha256,
  records,
});
async function fixture(t, parents = true) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'stroq-signal-store-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const home = join(directory, 'home');
  const consolePath = join(home, 'console');
  const file = join(consolePath, `inventory-signals-${workspaceId}.json`);
  if (parents) await mkdir(consolePath, { recursive: true, mode: 0o700 });
  const read = () => store.readSignalStore(home, workspaceId, contextSha256);
  const save = async (value) => {
    const bytes =
      typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value);
    await writeFile(file, bytes, { mode: 0o600 });
    return Buffer.from(bytes);
  };
  const append = async (before, value = record(), beforeRename = async () => {}) =>
    store.appendSignalRecord(home, workspaceId, contextSha256, before, value, beforeRename);
  return { directory, home, consolePath, file, read, save, append };
}

test('missing reads create no directories, and malformed selectors cannot escape the store', async (t) => {
  const f = await fixture(t, false);
  const result = await f.read();
  assert.equal(result.status, 'missing');
  assert.deepEqual(result.records, []);
  assert.equal(store.storeRevision(result), null);
  assert.deepEqual(await readdir(f.directory), []);
  await assert.rejects(f.append(result), /signal-store-unavailable/);
  assert.deepEqual(await readdir(f.directory), []);
  for (const [workspace, context] of [
    ['../outside', contextSha256],
    [workspaceId, 'not-a-hash'],
  ]) {
    assert.equal((await store.readSignalStore(f.home, workspace, context)).status, 'unavailable');
  }
  assert.deepEqual(await readdir(f.directory), []);
  await mkdir(f.consolePath, { recursive: true, mode: 0o700 });
  await assert.rejects(f.append(result), /signal-conflict/);
  assert.deepEqual(await readdir(f.consolePath), []);
});

test('append retains all events in order and uses append order for latest decisions', async (t) => {
  const f = await fixture(t);
  const first = record();
  const initial = await f.read();
  const one = await f.append(initial, first);
  assert.equal(one.status, 'ready');
  assert.equal((await lstat(f.file)).mode & 0o777, 0o600);
  assert.deepEqual(one.records, [first]);
  assert.equal(store.storeRevision(one), hash(await readFile(f.file)));
  const second = record({ decision: 'reopened', reason: 'reconsidered' });
  const two = await f.append(one, second);
  assert.deepEqual(two.records, [first, second]);
  assert.deepEqual(store.latestSignalRecords(two), [second]);
  const third = record({ binding: { ...first.binding, itemId: `item-${'1'.repeat(24)}` } });
  const three = await f.append(two, third);
  assert.deepEqual(store.latestSignalRecords(three), [second, third]);
  assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8')), document([first, second, third]));
  assert.deepEqual(await readdir(f.consolePath), [`inventory-signals-${workspaceId}.json`]);
});

test('copied contexts, duplicate keys, unknown fields and invalid record facts stay unavailable', async (t) => {
  const f = await fixture(t);
  const good = record();
  const variants = [
    { ...document([good]), contextSha256: '0'.repeat(64) },
    { ...document([good]), workspaceId: `workspace-${'0'.repeat(24)}` },
    { ...document([good]), schema: 'stroq-inventory-signal-store/2' },
    { ...document([good]), extra: true },
    document([{ ...good, extra: true }]),
    document([{ ...good, binding: { ...good.binding, path: '/private/path' } }]),
    document([{ ...good, binding: { ...good.binding, agent: 'cursor' } }]),
    document([{ ...good, binding: { ...good.binding, artifactSha256: 'no-hash' } }]),
    document([
      { ...good, binding: { ...good.binding, workspaceId: `workspace-${'0'.repeat(24)}` } },
    ]),
    document([{ ...good, id: 'arbitrary-id' }]),
    document([{ ...good, reason: 'benign-instruction' }]),
    document([{ ...good, recordedAt: '2026-02-30T00:00:00.000Z' }]),
    document([{ ...good, recordedAt: '9999-01-01T00:00:00.000Z' }]),
    document([good, good]),
    '{"schema":"other",' + JSON.stringify(document([good])).slice(1),
    JSON.stringify(document([good])).replace(
      '"scope":"project"',
      '"scope":"user","scope":"project"',
    ),
    Buffer.from([0xff]),
    Buffer.alloc(store.MAX_SIGNAL_STORE_BYTES + 1, 32),
  ];
  for (const variant of variants) {
    const bytes = await f.save(variant);
    const before = await f.read();
    assert.equal(before.status, 'unavailable');
    assert.deepEqual(before.records, []);
    await assert.rejects(f.append(before), /signal-store-unavailable/);
    assert.deepEqual(await readFile(f.file), bytes);
  }
});

test('finite decision reasons and every declared source retain their exact binding', async (t) => {
  const f = await fixture(t);
  const sources = [
    ['claude-skills', 'claude-code'],
    ['agents-skills', 'shared'],
    ['codex-skills', 'codex'],
    ['cursor-skills', 'cursor'],
    ['windsurf-skills', 'windsurf'],
    ['devin-skills', 'windsurf'],
  ];
  const decisions = [
    ['accepted-risk', 'required-use'],
    ['accepted-risk', 'controlled-environment'],
    ['accepted-risk', 'compensating-control'],
    ['false-positive', 'benign-instruction'],
    ['false-positive', 'test-or-example'],
    ['false-positive', 'incorrect-match'],
    ['reopened', 'reconsidered'],
  ];
  const records = decisions.map(([decision, reason], index) => {
    const [skillSource, agent] = sources[index % sources.length];
    return record({
      decision,
      reason,
      binding: { ...record().binding, skillSource, agent, scope: 'user' },
    });
  });
  await f.save(document(records));
  assert.deepEqual((await f.read()).records, records);
});

test('unsafe modes, links and writable parents never become readable stores', async (t) => {
  const f = await fixture(t);
  await f.save(document([record()]));
  for (const [path, unsafe, safe] of [
    [f.file, 0o644, 0o600],
    [f.file, 0o4600, 0o600],
    [f.home, 0o777, 0o700],
    [f.consolePath, 0o770, 0o700],
  ]) {
    await chmod(path, unsafe);
    // Some temporary filesystems strip setuid even when chmod reports success.
    if ((unsafe & 0o7000) === 0 || ((await lstat(path)).mode & 0o7777) === unsafe)
      assert.equal((await f.read()).status, 'unavailable');
    await chmod(path, safe);
  }
  const retained = join(f.directory, 'retained');
  await rename(f.file, retained);
  await symlink(retained, f.file);
  assert.equal((await f.read()).status, 'unavailable');
  await rm(f.file);
  await link(retained, f.file);
  assert.equal((await f.read()).status, 'unavailable');
});

test('stale revisions and same-byte inode substitutions preserve the current file', async (t) => {
  const f = await fixture(t);
  await f.append(await f.read());
  const before = await f.read();
  const external = JSON.stringify(document([record()]));
  await f.save(external);
  await assert.rejects(f.append(before), /signal-conflict/);
  assert.equal(await readFile(f.file, 'utf8'), external);
  const fresh = await f.read();
  const replacement = join(f.consolePath, 'replacement');
  await writeFile(replacement, external, { mode: 0o600 });
  await rename(replacement, f.file);
  await assert.rejects(f.append(fresh), /signal-conflict/);
  assert.equal(await readFile(f.file, 'utf8'), external);
});

test('a conflict during source recheck never overwrites the interposed revision', async (t) => {
  const f = await fixture(t);
  await f.append(await f.read());
  const before = await f.read();
  const external = JSON.stringify(document([record()]));
  await assert.rejects(
    f.append(before, record(), () => f.save(external)),
    /signal-conflict/,
  );
  assert.equal(await readFile(f.file, 'utf8'), external);
  assert.deepEqual(await readdir(f.consolePath), [`inventory-signals-${workspaceId}.json`]);
});

test('directory substitution refuses publication and leaves replacement files untouched', async (t) => {
  const f = await fixture(t);
  await f.append(await f.read());
  const before = await f.read();
  const bytes = await readFile(f.file);
  await assert.rejects(
    f.append(before, record(), async () => {
      await rename(f.consolePath, `${f.consolePath}-retained`);
      await mkdir(f.consolePath, { mode: 0o700 });
      await writeFile(join(f.consolePath, 'sentinel'), 'untouched');
    }),
    /signal-conflict/,
  );
  assert.deepEqual(await readdir(f.consolePath), ['sentinel']);
  assert.equal(await readFile(join(f.consolePath, 'sentinel'), 'utf8'), 'untouched');
  assert.deepEqual(
    await readFile(join(`${f.consolePath}-retained`, `inventory-signals-${workspaceId}.json`)),
    bytes,
  );
});

test('staged bytes and permissions are rechecked through the writing descriptor', async (t) => {
  const f = await fixture(t);
  await f.append(await f.read());
  const before = await f.read();
  const bytes = await readFile(f.file);
  await assert.rejects(
    f.append(before, record(), async () => {
      const temporary = (await readdir(f.consolePath)).find((name) => name.endsWith('.tmp'));
      assert.ok(temporary);
      await writeFile(join(f.consolePath, temporary), 'tampered');
    }),
    /signal-conflict/,
  );
  assert.deepEqual(await readFile(f.file), bytes);
  assert.deepEqual(await readdir(f.consolePath), [`inventory-signals-${workspaceId}.json`]);
});

test('a failed source recheck preserves its finite error and leaves old store bytes intact', async (t) => {
  const f = await fixture(t);
  await f.append(await f.read());
  const before = await f.read();
  const bytes = await readFile(f.file);
  await assert.rejects(
    f.append(before, record(), async () => {
      throw new Error('signal-changed');
    }),
    /signal-changed/,
  );
  assert.deepEqual(await readFile(f.file), bytes);
  assert.deepEqual(await readdir(f.consolePath), [`inventory-signals-${workspaceId}.json`]);
});

test('full stores refuse further events without evicting history', async (t) => {
  const f = await fixture(t);
  const records = Array.from({ length: store.MAX_SIGNAL_STORE_RECORDS }, () => record());
  const bytes = await f.save(document(records));
  const before = await f.read();
  assert.equal(before.status, 'ready');
  await assert.rejects(f.append(before), /signal-store-full/);
  assert.deepEqual(await readFile(f.file), bytes);
  await f.save(document([...records, record()]));
  assert.equal((await f.read()).status, 'unavailable');
});

test('append rereads trusted history and rejects invalid new events without mutating it', async (t) => {
  const f = await fixture(t);
  const first = record();
  const before = await f.append(await f.read(), first);
  before.records.splice(0);
  const second = record();
  const after = await f.append(before, second);
  assert.deepEqual(after.records, [first, second]);
  const bytes = await readFile(f.file);
  for (const invalid of [
    first,
    record({ reason: 'freeform text' }),
    record({ binding: { ...first.binding, scope: '../outside' } }),
  ]) {
    await assert.rejects(f.append(after, invalid), /signal-store-unavailable/);
    assert.deepEqual(await readFile(f.file), bytes);
  }
});
