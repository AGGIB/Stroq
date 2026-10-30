import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPolicyCasesStore, policyCaseId } from './policy-cases-store.mjs';

async function fixture(t) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'stroq-policy-cases-')));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const home = join(parent, 'home');
  return {
    parent,
    home,
    store: createPolicyCasesStore({ home }),
    path: join(home, 'console', 'policy-cases.json'),
  };
}
function record(classes = ['shell.network'], effects = ['allow', 'deny'], suffix = 'a') {
  const expected = effects.map((effect, i) => ({ taint: ['none', 'suspect'][i], effect }));
  return {
    id: policyCaseId(classes, expected),
    createdAt: '2026-10-23T01:02:03.000Z',
    source: {
      incidentId: `incident-${suffix.repeat(64)}`,
      evidenceSha: suffix.repeat(64),
      workspaceId: `workspace-${suffix.repeat(24)}`,
    },
    classes,
    expected,
  };
}
async function persist(store, records) {
  return store.withSnapshotLock(await store.capture(), async (_fresh, replace) => replace(records));
}

test('missing case store reads as empty without creating a home, durable replacement survives restart', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.store.capture(), { revision: null, records: [] });
  await assert.rejects(lstat(f.home), { code: 'ENOENT' });
  const saved = await persist(f.store, [record()]);
  assert.match(saved.revision, /^[a-f0-9]{64}$/);
  assert.deepEqual(saved.records, [record()]);
  assert.equal((await lstat(f.path)).mode & 0o777, 0o600);
  assert.equal((await lstat(join(f.home, 'console'))).mode & 0o777, 0o700);
  assert.deepEqual(await createPolicyCasesStore({ home: f.home }).capture(), saved);
  const empty = await persist(f.store, []);
  assert.match(empty.revision, /^[a-f0-9]{64}$/);
  assert.deepEqual(empty.records, []);
  assert.ok((await readFile(f.path)).length > 0);
});

test('malformed, duplicate-key, invalid UTF-8 and unknown records are never silently empty', async (t) => {
  const f = await fixture(t);
  await persist(f.store, [record()]);
  const good = await readFile(f.path);
  for (const bytes of [
    Buffer.from('{broken'),
    Buffer.from('{"schema":"stroq-policy-cases-store/1","records":[],"records":[]}'),
    Buffer.from('{"schema":"stroq-policy-cases-store/1","reco\\u0072ds":[],"records":[]}'),
    Buffer.from([0xff]),
    Buffer.from(
      JSON.stringify({
        schema: 'stroq-policy-cases-store/1',
        records: [{ ...record(), private: 'sentinel' }],
      }),
    ),
    Buffer.from(
      JSON.stringify({
        schema: 'stroq-policy-cases-store/1',
        records: [{ ...record(), id: `case-${'0'.repeat(64)}` }],
      }),
    ),
  ]) {
    await writeFile(f.path, bytes, { mode: 0o600 });
    await assert.rejects(f.store.capture(), /policy-cases-invalid/);
    assert.deepEqual(await readFile(f.path), bytes);
  }
  await writeFile(f.path, good);
  assert.equal((await f.store.capture()).records.length, 1);
});

test('unsafe symlinks, hardlinks, public modes and oversized files are refused', async (t) => {
  const f = await fixture(t);
  await persist(f.store, [record()]);
  await chmod(f.path, 0o644);
  await assert.rejects(f.store.capture(), /policy-cases-unavailable/);
  await chmod(f.path, 0o600);
  const copy = join(f.parent, 'copy');
  await copyFile(f.path, copy);
  await rm(f.path);
  await symlink(copy, f.path);
  await assert.rejects(f.store.capture(), /policy-cases-unavailable/);
  await rm(f.path);
  await link(copy, f.path);
  await assert.rejects(f.store.capture(), /policy-cases-unavailable/);
  await rm(f.path);
  await writeFile(f.path, Buffer.alloc(256 * 1024 + 1), { mode: 0o600 });
  await assert.rejects(f.store.capture(), /policy-cases-invalid/);
});

test('replacement validates canonical records, immutable IDs, uniqueness and bound before writing', async (t) => {
  const f = await fixture(t);
  await persist(f.store, [record()]);
  const bytes = await readFile(f.path);
  for (const records of [
    [record(), record()],
    [record(['shell.network', 'mcp.call'])],
    [record([])],
    [record(['unknown'])],
    [record(['shell.network', 'shell.network'])],
    [record(), record(['shell.network'], ['deny', 'deny'])],
    [
      {
        ...record(),
        expected: [
          { taint: 'suspect', effect: 'deny' },
          { taint: 'none', effect: 'allow' },
        ],
      },
    ],
    Array.from({ length: 65 }, () => record()),
  ]) {
    await assert.rejects(persist(f.store, records), /policy-cases-invalid/);
    assert.deepEqual(await readFile(f.path), bytes);
  }
});

test('captured revision and inode binding reject stale writes, even identical-byte replacement', async (t) => {
  const f = await fixture(t);
  await persist(f.store, [record()]);
  const old = await f.store.capture();
  const bytes = await readFile(f.path);
  const other = join(f.parent, 'replacement');
  await writeFile(other, bytes, { mode: 0o600 });
  await rename(other, f.path);
  await assert.rejects(
    f.store.withSnapshotLock(old, async (_fresh, replace) => replace([])),
    /policy-cases-stale/,
  );
  assert.deepEqual(await readFile(f.path), bytes);
});

test('core lock serializes case writers and stays held through the complete callback', async (t) => {
  const f = await fixture(t);
  await persist(f.store, [record()]);
  const second = createPolicyCasesStore({ home: f.home });
  const firstSnapshot = await f.store.capture();
  const secondSnapshot = await second.capture();
  let release, entered;
  const held = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const first = f.store.withSnapshotLock(firstSnapshot, async (_fresh, replace) => {
    entered();
    await gate;
    return replace([]);
  });
  await held;
  let secondEntered = false;
  const pending = second.withSnapshotLock(secondSnapshot, async () => {
    secondEntered = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(secondEntered, false);
  release();
  await first;
  await assert.rejects(pending, /policy-cases-stale/);
});

test('directory substitution during callback cannot redirect replacement or cleanup', async (t) => {
  const f = await fixture(t);
  await persist(f.store, [record()]);
  const snapshot = await f.store.capture();
  const old = join(f.parent, 'held-console');
  await assert.rejects(
    f.store.withSnapshotLock(snapshot, async (_fresh, replace) => {
      await rename(join(f.home, 'console'), old);
      await mkdir(join(f.home, 'console'), { mode: 0o700 });
      await writeFile(f.path, 'FOREIGN_SENTINEL', { mode: 0o600 });
      return replace([]);
    }),
    /policy-cases-stale|policy-cases-unavailable/,
  );
  assert.equal(await readFile(f.path, 'utf8'), 'FOREIGN_SENTINEL');
  assert.equal(
    JSON.parse(await readFile(join(old, 'policy-cases.json'), 'utf8')).records.length,
    1,
  );
});

test('foreign bytes after rename are refused instead of being adopted as a successful replacement', async (t) => {
  const f = await fixture(t);
  await persist(f.store, [record()]);
  const foreign = Buffer.from(
    JSON.stringify({ schema: 'stroq-policy-cases-store/1', records: [record(['mcp.call'])] }),
  );
  const store = createPolicyCasesStore({
    home: f.home,
    fault: async (phase) => {
      if (phase === 'after-rename') await writeFile(f.path, foreign, { mode: 0o600 });
    },
  });
  await assert.rejects(persist(store, []), /policy-cases-stale/);
  assert.deepEqual(await readFile(f.path), foreign);
});

test('same-inode owner metadata growth cannot become an unbounded lock read', async (t) => {
  const f = await fixture(t);
  await persist(f.store, [record()]);
  const store = createPolicyCasesStore({
    home: f.home,
    fault: async (phase) => {
      if (phase === 'after-lock-owner-stat') {
        await writeFile(
          join(f.home, 'console', '.policy-cases.lock', 'owner.json'),
          Buffer.alloc(1024 * 1024),
          { mode: 0o600 },
        );
      }
    },
  });
  await assert.rejects(
    store.withSnapshotLock(await store.capture(), async () => undefined),
    /policy-cases-unavailable/,
  );
  assert.equal((await f.store.capture()).records.length, 1);
});

test('unchanged callbacks still reject a changed file before returning success', async (t) => {
  const f = await fixture(t);
  await persist(f.store, [record()]);
  const snapshot = await f.store.capture();
  await assert.rejects(
    f.store.withSnapshotLock(snapshot, async () => {
      await writeFile(
        f.path,
        JSON.stringify({ schema: 'stroq-policy-cases-store/1', records: [] }),
        { mode: 0o600 },
      );
      return 'unchanged';
    }),
    /policy-cases-stale/,
  );
  assert.deepEqual((await f.store.capture()).records, []);
});

test('lock callback proves only a home it created itself, including nested missing parents', async (t) => {
  const f = await fixture(t);
  const home = join(f.parent, 'new', 'nested', 'home');
  const store = createPolicyCasesStore({ home });
  const snapshot = await store.capture();
  let proof;
  await store.withSnapshotLock(snapshot, async (_fresh, _replace, metadata) => {
    const stat = await lstat(home);
    assert.deepEqual(metadata, { createdHome: { dev: stat.dev, ino: stat.ino } });
    assert.equal(Object.isFrozen(metadata), true);
    assert.equal(Object.isFrozen(metadata.createdHome), true);
    proof = metadata;
  });
  assert.ok(proof.createdHome);
  await store.withSnapshotLock(await store.capture(), async (_fresh, _replace, metadata) => {
    assert.deepEqual(metadata, { createdHome: null });
  });
});

test('creating only the console directory never proves creation of a preexisting home', async (t) => {
  const f = await fixture(t);
  await mkdir(f.home, { mode: 0o700 });
  await f.store.withSnapshotLock(await f.store.capture(), async (_fresh, _replace, metadata) => {
    assert.deepEqual(metadata, { createdHome: null });
  });
});

test('an interposed home directory or link is never adopted or exposed as own creation', async (t) => {
  for (const kind of ['directory', 'link']) {
    const f = await fixture(t);
    const snapshot = await f.store.capture();
    const foreign = join(f.parent, 'foreign');
    await mkdir(foreign, { mode: 0o700 });
    await writeFile(join(foreign, 'sentinel'), 'FOREIGN_SENTINEL');
    if (kind === 'directory') await mkdir(f.home, { mode: 0o700 });
    else await symlink(foreign, f.home);
    let entered = false;
    await assert.rejects(
      f.store.withSnapshotLock(snapshot, async () => {
        entered = true;
      }),
      /policy-cases-stale|policy-cases-unavailable/,
    );
    assert.equal(entered, false);
    assert.equal(await readFile(join(foreign, 'sentinel'), 'utf8'), 'FOREIGN_SENTINEL');
    await assert.rejects(lstat(join(f.home, 'console')), { code: 'ENOENT' });
  }
});

test('location recapture cannot adopt a foreign root or console after exclusive creation', async (t) => {
  for (const kind of ['root', 'console']) {
    const f = await fixture(t);
    const selected = kind === 'root' ? f.home : join(f.home, 'console');
    const held = join(f.parent, 'held-created-directory');
    const store = createPolicyCasesStore({
      home: f.home,
      fault: async (phase) => {
        if (phase !== 'before-location-recapture') return;
        await rename(selected, held);
        await mkdir(selected, { mode: 0o700 });
        if (kind === 'root') await mkdir(join(selected, 'console'), { mode: 0o700 });
        await writeFile(join(selected, 'sentinel'), 'FOREIGN_SENTINEL', { mode: 0o600 });
      },
    });
    let entered = false;
    await assert.rejects(
      store.withSnapshotLock(await store.capture(), async () => {
        entered = true;
      }),
      /policy-cases-stale/,
    );
    assert.equal(entered, false);
    assert.equal(await readFile(join(selected, 'sentinel'), 'utf8'), 'FOREIGN_SENTINEL');
    await assert.rejects(lstat(join(f.home, 'console', '.policy-cases.lock')), { code: 'ENOENT' });
  }
});

test('recapture verifies every created parent even when the created home inode is preserved', async (t) => {
  const f = await fixture(t);
  const ancestor = join(f.parent, 'new');
  const home = join(ancestor, 'nested', 'home');
  const held = join(f.parent, 'held-parent');
  const store = createPolicyCasesStore({
    home,
    fault: async (phase) => {
      if (phase !== 'before-location-recapture') return;
      await rename(ancestor, held);
      await mkdir(ancestor, { mode: 0o700 });
      await mkdir(join(ancestor, 'nested'), { mode: 0o700 });
      await rename(join(held, 'nested', 'home'), home);
      await writeFile(join(ancestor, 'sentinel'), 'FOREIGN_PARENT_SENTINEL', { mode: 0o600 });
    },
  });
  let entered = false;
  await assert.rejects(
    store.withSnapshotLock(await store.capture(), async () => {
      entered = true;
    }),
    /policy-cases-stale/,
  );
  assert.equal(entered, false);
  assert.equal(await readFile(join(ancestor, 'sentinel'), 'utf8'), 'FOREIGN_PARENT_SENTINEL');
});
