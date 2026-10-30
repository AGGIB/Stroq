import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import {
  mkdtemp,
  realpath,
  mkdir,
  readFile,
  writeFile,
  rm,
  chmod,
  readdir,
  stat,
  link,
  symlink,
  rename,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tsImport } from 'tsx/esm/api';
const loader = await mkdtemp(join(tmpdir(), 'stroq-governance-store-loader-'));
after(() => rm(loader, { recursive: true, force: true }));
const tsconfig = join(loader, 'tsconfig.json');
await writeFile(
  tsconfig,
  JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' },
  }),
);
const api = await tsImport('./mcp-governance-store.ts', { parentURL: import.meta.url, tsconfig });
const sha = 'a'.repeat(64),
  when = '2026-10-27T00:00:00.000Z';
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const pin = (n = 1) => ({ dev: 1, ino: n, uid: process.getuid?.() ?? 0, mode: 0o40700 });
async function fixture(t, missing = false) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'stroq-governance-store-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, 'home');
  if (!missing) await mkdir(home, { mode: 0o700 });
  const options = {
    home,
    contextId: 'governance-context-' + sha,
    workspaceId: 'workspace-' + sha.slice(0, 24),
    now: () => Date.parse(when),
  };
  const store = api.createMcpGovernanceStore(options);
  const intent = (n = 1) => ({
    schema: 'stroq-mcp-governance-intent/1',
    id: id(n),
    operationId: id(n),
    binding: {
      contextId: options.contextId,
      workspaceId: options.workspaceId,
      runtimeSha256: sha,
      policyRawSha256: null,
      policyFingerprint: sha,
      captureSha256: sha,
    },
    createdAt: when,
    updatedAt: when,
    candidateRawSha256: sha,
    candidateFingerprint: sha,
    beforePolicy: { rawSha256: null, fingerprint: sha, file: null, parents: [pin()] },
    phase: 'prepared',
    staged: null,
    historyRef: null,
    terminalSource: null,
  });
  const create = (n = 1) =>
    store.withLease({ operationId: id(n) }, (lease) => store.create(intent(n), lease));
  const directory = join(home, 'mcp-governance');
  return {
    base,
    home,
    options,
    store,
    intent,
    create,
    directory,
    file: (n = 1) => join(directory, id(n) + '.json'),
  };
}

test('passive missing read creates no home, directory, lock or repair', async (t) => {
  const f = await fixture(t, true);
  assert.deepEqual(await f.store.read(), { status: 'missing', records: [], revision: null });
  assert.deepEqual(await readdir(f.base), []);
});

test('exact owned first-home creation is returned by lease; retained records roundtrip and never expire', async (t) => {
  const f = await fixture(t, true);
  const made = await f.store.withLease({ operationId: id(1) }, async (lease) => {
    const s = await stat(f.home);
    assert.deepEqual(lease.createdHome, {
      path: f.home,
      dev: s.dev,
      ino: s.ino,
      uid: s.uid,
      mode: s.mode,
    });
    await lease.assertCurrent();
    return f.store.create(f.intent(), lease);
  });
  assert.equal((await stat(f.directory)).mode & 0o777, 0o700);
  assert.equal((await stat(f.file())).mode & 0o777, 0o600);
  const restarted = api.createMcpGovernanceStore({
    ...f.options,
    now: () => Date.parse(when) + 1000 * 86400 * 365,
  });
  const read = await restarted.read();
  assert.equal(read.status, 'ready');
  assert.deepEqual(read.records, [made]);
  const bytes = await readFile(f.file(), 'utf8');
  assert.equal(bytes.includes(f.home), false);
  assert.equal(bytes.includes('allowed'), false);
});

test('journal updates retain physical staged proof and immutable operation metadata', async (t) => {
  const f = await fixture(t),
    initial = await f.create();
  const staged = {
    file: { ...pin(9), mode: 0o100600, nlink: 1, size: 123, mtimeMs: 1 },
    parents: [pin()],
    sha256: sha,
  };
  const terminal = await f.store.withLease({ operationId: id(1) }, async (lease) => {
    assert.equal(lease.createdHome, null);
    const next = await f.store.update(id(1), initial.revision, { phase: 'staged', staged }, lease);
    assert.notEqual(next.revision, initial.revision);
    await assert.rejects(
      f.store.update(id(1), initial.revision, { phase: 'applied', terminalSource: 'apply' }, lease),
      /mcp-governance-stale/,
    );
    return f.store.update(
      id(1),
      next.revision,
      {
        phase: 'applied',
        terminalSource: 'apply',
        historyRef: { entryId: id(9), recordSha256: sha },
      },
      lease,
    );
  });
  assert.equal(terminal.intent.phase, 'applied');
  assert.deepEqual(terminal.intent.staged, staged);
  await f.store.withLease({ operationId: id(1) }, async (lease) => {
    await assert.rejects(
      f.store.update(id(1), terminal.revision, { phase: 'prepared' }, lease),
      /mcp-governance-invalid/,
    );
    await assert.rejects(
      f.store.update(id(1), terminal.revision, { candidateFingerprint: 'b'.repeat(64) }, lease),
      /mcp-governance-invalid/,
    );
  });
  assert.deepEqual((await f.store.read()).records, [terminal]);
});

test('no-stage not-applied needs an exclusive owned lease and cannot discard a staged intent', async (t) => {
  const f = await fixture(t),
    initial = await f.create();
  await assert.rejects(
    f.store.update(
      id(1),
      initial.revision,
      { phase: 'not-applied', terminalSource: 'recheck' },
      { assertCurrent: async () => {} },
    ),
    /mcp-governance-invalid/,
  );
  const result = await f.store.withLease({ operationId: id(1), explicitRecovery: true }, (lease) =>
    f.store.update(
      id(1),
      initial.revision,
      { phase: 'not-applied', terminalSource: 'recheck' },
      lease,
    ),
  );
  assert.equal(result.intent.phase, 'not-applied');
  assert.equal(result.intent.staged, null);
});

test('unknown fields, invalid stages, operation mismatch and traversal never publish', async (t) => {
  const f = await fixture(t);
  await f.store.withLease({ operationId: id(1) }, async (lease) => {
    for (const bad of [
      { ...f.intent(), rawPolicy: 'private' },
      { ...f.intent(), id: '../outside' },
      { ...f.intent(), operationId: id(2) },
      {
        ...f.intent(),
        phase: 'staged',
        staged: {
          file: { ...pin(), nlink: 1, size: 1, mtimeMs: 1 },
          parents: [pin()],
          sha256: 'b'.repeat(64),
        },
      },
    ]) {
      await assert.rejects(f.store.create(bad, lease), /mcp-governance-invalid/);
    }
  });
  assert.deepEqual((await f.store.read()).records, []);
});

test('same bytes on a replacement record inode cannot satisfy an old revision', async (t) => {
  const f = await fixture(t),
    original = await f.create(),
    bytes = await readFile(f.file());
  await rename(f.file(), join(f.base, 'old-record.json'));
  await writeFile(f.file(), bytes, { mode: 0o600 });
  const fresh = await f.store.read();
  assert.notEqual(fresh.records[0].revision, original.revision);
  await f.store.withLease({ operationId: id(1) }, (lease) =>
    assert.rejects(
      f.store.update(
        id(1),
        original.revision,
        { phase: 'not-applied', terminalSource: 'recheck' },
        lease,
      ),
      /mcp-governance-stale/,
    ),
  );
  assert.deepEqual(await readFile(f.file()), bytes);
});

test('valid foreign metadata edits under a held lease invalidate its full journal snapshot', async (t) => {
  const f = await fixture(t);
  await f.create();
  const changed = { ...f.intent(), updatedAt: '2026-10-27T00:00:00.001Z' };
  const bytes = Buffer.from(JSON.stringify(changed) + '\n');
  await assert.rejects(
    f.store.withLease({ operationId: id(1) }, async (lease) => {
      await writeFile(f.file(), bytes);
      await lease.assertCurrent();
    }),
    /mcp-governance-stale/,
  );
  assert.deepEqual(await readFile(f.file()), bytes);
});

test('invalid staged hash and unsafe link metadata do not replace the retained prepared intent', async (t) => {
  const f = await fixture(t),
    original = await f.create();
  const valid = {
    file: { ...pin(9), mode: 0o100600, nlink: 1, size: 1, mtimeMs: 1 },
    parents: [pin()],
    sha256: sha,
  };
  await f.store.withLease({ operationId: id(1) }, async (lease) => {
    for (const staged of [
      { ...valid, sha256: 'b'.repeat(64) },
      { ...valid, file: { ...valid.file, nlink: 2 } },
      { ...valid, parents: [{ ...pin(), path: '/private/value' }] },
    ]) {
      await assert.rejects(
        f.store.update(id(1), original.revision, { phase: 'staged', staged }, lease),
        /mcp-governance-invalid/,
      );
    }
  });
  assert.deepEqual((await f.store.read()).records, [original]);
});

test('malformed, duplicate-key and oversized retained metadata are refused without read repair', async (t) => {
  for (const value of ['{', '{"schema":1,"schema":1}', 'x'.repeat(256 * 1024 + 1)]) {
    const f = await fixture(t);
    await f.create();
    await writeFile(f.file(), value);
    assert.equal((await f.store.read()).status, 'unavailable');
    assert.equal(await readFile(f.file(), 'utf8'), value);
  }
});

test('unsafe modes, hardlinks and symlinked record/store roots are refused unchanged', async (t) => {
  const f = await fixture(t);
  await f.create();
  await chmod(f.file(), 0o644);
  assert.equal((await f.store.read()).status, 'unavailable');
  await chmod(f.file(), 0o600);
  await link(f.file(), join(f.base, 'linked'));
  assert.equal((await f.store.read()).status, 'unavailable');
  await rm(join(f.base, 'linked'));
  await rename(f.file(), join(f.base, 'original'));
  await symlink(join(f.base, 'original'), f.file());
  assert.equal((await f.store.read()).status, 'unavailable');
  await rm(f.file());
  await rename(join(f.base, 'original'), f.file());
  await chmod(f.directory, 0o755);
  assert.equal((await f.store.read()).status, 'unavailable');
  await chmod(f.directory, 0o700);
  await rename(f.directory, join(f.base, 'moved'));
  await symlink(join(f.base, 'moved'), f.directory);
  assert.equal((await f.store.read()).status, 'unavailable');
});

test('an orphan metadata staging file is preserved and blocks another publication', async (t) => {
  const f = await fixture(t);
  await f.create();
  const orphan = join(f.directory, `.stroq-${id(99)}.tmp`);
  await writeFile(orphan, 'owned interrupted bytes', { mode: 0o600 });
  assert.equal((await f.store.read()).status, 'unavailable');
  await assert.rejects(f.create(2), /mcp-governance-store-unavailable/);
  assert.equal(await readFile(orphan, 'utf8'), 'owned interrupted bytes');
});

test('32 global records stay retained and a 33rd record refuses without eviction', async (t) => {
  const f = await fixture(t);
  for (let n = 1; n <= 32; n++) await f.create(n);
  const before = await f.store.read();
  assert.equal(before.records.length, 32);
  await assert.rejects(f.create(33), /mcp-governance-store-full/);
  assert.deepEqual(await f.store.read(), before);
});

test('replaced store root while a writer is held never receives a journal update or lock cleanup', async (t) => {
  const f = await fixture(t),
    entry = await f.create();
  await assert.rejects(
    f.store.withLease({ operationId: id(1) }, async (lease) => {
      await rename(f.directory, join(f.base, 'old-store'));
      await mkdir(f.directory, { mode: 0o700 });
      await writeFile(join(f.directory, 'foreign'), 'preserve', { mode: 0o600 });
      await f.store.update(
        id(1),
        entry.revision,
        { phase: 'not-applied', terminalSource: 'recheck' },
        lease,
      );
    }),
    /mcp-governance-store-unavailable/,
  );
  assert.deepEqual(await readdir(f.directory), ['foreign']);
  assert.equal(await readFile(join(f.directory, 'foreign'), 'utf8'), 'preserve');
});
