import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  symlink,
  readdir,
  rename,
  utimes,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  atomicWrite,
  assertUnchanged,
  commitSetup,
  digest,
  rootIdentity,
  snapshotFile,
} from './agent-setup-files.mjs';
import { runtimeDigest } from './agent-setup-cli.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'stroq-setup-files-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = await rootIdentity(dir);
  const config = join(root.path, '.cursor', 'hooks.json');
  const record = join(root.path, '.stroq', 'install.json');
  await mkdir(join(root.path, '.cursor'));
  await mkdir(join(root.path, '.stroq'));
  await writeFile(config, '{"original":true}');
  await writeFile(record, '{"version":1,"entries":{}}');
  return {
    root,
    plan: {
      id: 'test-backup',
      agent: 'cursor',
      scope: 'user',
      userRoot: root,
      config: {
        root,
        file: config,
        before: await snapshotFile(root, config),
        next: Buffer.from('{"installed":true}'),
      },
      record: {
        root,
        file: record,
        before: await snapshotFile(root, record),
        next: Buffer.from('{"recorded":true}'),
      },
    },
  };
}

test('record write failure restores exact config bytes and leaves private recovery backups', async (t) => {
  const { root, plan } = await fixture(t);
  await assert.rejects(
    commitSetup(plan, async (...args) => {
      if (args[1] === plan.record.file) throw new Error('write-failed');
      return atomicWrite(...args);
    }),
    /write-failed/,
  );
  assert.equal(await readFile(plan.config.file, 'utf8'), '{"original":true}');
  assert.equal(await readFile(plan.record.file, 'utf8'), '{"version":1,"entries":{}}');
  assert.equal(
    await readFile(
      join(root.path, '.stroq', 'backups', 'console-setup', 'test-backup.config.json'),
      'utf8',
    ),
    '{"original":true}',
  );
  assert.ok(!(await readdir(join(root.path, '.cursor'))).some((name) => name.endsWith('.tmp')));
});

test('rollback refuses to clobber another writer and reports incomplete recovery', async (t) => {
  const { plan } = await fixture(t);
  await assert.rejects(
    commitSetup(plan, async (...args) => {
      if (args[1] === plan.record.file) {
        await writeFile(plan.config.file, '{"concurrentEdit":true}');
        throw new Error('write-failed');
      }
      return atomicWrite(...args);
    }),
    /rollback-incomplete/,
  );
  assert.equal(await readFile(plan.config.file, 'utf8'), '{"concurrentEdit":true}');
});

test('link substituted after preview cannot redirect writes outside the selected root', async (t) => {
  const { root, plan } = await fixture(t);
  const elsewhere = join(root.path, 'elsewhere');
  await mkdir(elsewhere);
  await rm(join(root.path, '.cursor'), { recursive: true });
  await symlink(elsewhere, join(root.path, '.cursor'));
  await assert.rejects(
    atomicWrite(root, plan.config.file, plan.config.next, plan.config.before),
    /unsafe-config/,
  );
  assert.deepEqual(await readdir(elsewhere), []);
});

test('runtime fingerprint includes split chunks, package version, and refuses links', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'stroq-setup-runtime-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'dist'));
  const paths = { cli: join(dir, 'dist', 'index.js'), package: join(dir, 'package.json') };
  await writeFile(paths.cli, 'import "./chunk.js";');
  await writeFile(join(dir, 'dist', 'chunk.js'), 'export const value = 1;');
  await writeFile(paths.package, '{"version":"0.28.0"}');
  const first = await runtimeDigest(paths);
  await writeFile(join(dir, 'dist', 'chunk.js'), 'export const value = 2;');
  const second = await runtimeDigest(paths);
  assert.notEqual(first, second);
  await writeFile(paths.package, '{"version":"0.29.0"}');
  assert.notEqual(second, await runtimeDigest(paths));
  await symlink(paths.cli, join(dir, 'dist', 'linked.js'));
  await assert.rejects(runtimeDigest(paths), /engine-unavailable/);
  assert.notEqual(digest(Buffer.from('a')), digest(Buffer.from('b')));
});

test('captures pin source inode, owner, mode, ctime and existing ancestors', async (t) => {
  const { root, plan } = await fixture(t);
  const source = await lstat(plan.config.file);
  const before = plan.config.before;
  assert.equal(before.file.ino, source.ino);
  assert.equal(before.file.uid, source.uid);
  assert.equal(before.file.mode, source.mode);
  assert.equal(before.file.ctimeMs, source.ctimeMs);
  assert.equal(before.directories[0].path, root.path);
  assert.equal(before.directories.at(-1).path, join(root.path, '.cursor'));
});

test('same-byte source replacements and mode changes invalidate the preview', async (t) => {
  for (const mutation of ['replacement', 'chmod', 'same-byte-edit'])
    await t.test(mutation, async (t) => {
      const { root, plan } = await fixture(t);
      const { file, before } = plan.config;
      if (mutation === 'replacement') {
        await rename(file, `${file}.old`);
        await writeFile(file, before.bytes, { mode: before.mode });
      } else if (mutation === 'chmod') await chmod(file, 0o600);
      else {
        const prior = await lstat(file);
        await writeFile(file, before.bytes);
        await utimes(file, prior.atime, prior.mtime);
      }
      await assert.rejects(assertUnchanged(root, file, before), /preview-stale/);
      assert.deepEqual(await readFile(file), before.bytes);
    });
});

test('existing ancestor replacement or mode drift invalidates a source, while lock-directory timestamps do not', async (t) => {
  for (const mutation of ['replacement', 'chmod', 'lock'])
    await t.test(mutation, async (t) => {
      const { root, plan } = await fixture(t);
      const parent = join(root.path, '.cursor');
      if (mutation === 'replacement') {
        await rename(parent, `${parent}.old`);
        await mkdir(parent);
        await writeFile(plan.config.file, plan.config.before.bytes);
      } else if (mutation === 'chmod') await chmod(parent, 0o700);
      else {
        await mkdir(join(parent, 'fixture-lock'), { mode: 0o700 });
        await rm(join(parent, 'fixture-lock'), { recursive: true });
      }
      if (mutation === 'lock') await assertUnchanged(root, plan.config.file, plan.config.before);
      else
        await assert.rejects(
          assertUnchanged(root, plan.config.file, plan.config.before),
          /preview-stale/,
        );
    });
});

test('a selected root replacement cannot be accepted by identical file bytes', async (t) => {
  const { root, plan } = await fixture(t);
  const moved = `${root.path}.old`;
  t.after(() => rm(moved, { recursive: true, force: true }));
  await rename(root.path, moved);
  await mkdir(join(root.path, '.cursor'), { recursive: true });
  await writeFile(plan.config.file, plan.config.before.bytes);
  await assert.rejects(
    assertUnchanged(root, plan.config.file, plan.config.before),
    /preview-stale/,
  );
});

test('an absent source tolerates newly created private parents and the shared lock directory', async (t) => {
  const { root } = await fixture(t);
  const file = join(root.path, 'new-private', 'nested', 'settings.json');
  const before = await snapshotFile(root, file);
  await mkdir(join(root.path, 'new-private'), { mode: 0o700 });
  await mkdir(join(root.path, 'new-private', 'nested'), { mode: 0o700 });
  await mkdir(join(root.path, '.stroq', 'harden'), { mode: 0o700 });
  await assertUnchanged(root, file, before);
  const after = await atomicWrite(root, file, Buffer.from('{}'), before);
  assert.equal(after.file.ino, (await lstat(file)).ino);
  assert.equal(after.sha256, digest(Buffer.from('{}')));
});

test('newly appeared nonprivate parents do not silently become an approved missing-source path', async (t) => {
  const { root } = await fixture(t);
  const file = join(root.path, 'new-public', 'settings.json');
  const before = await snapshotFile(root, file);
  await mkdir(join(root.path, 'new-public'), { mode: 0o755 });
  await assert.rejects(assertUnchanged(root, file, before), /preview-stale/);
});

test('atomic writes preserve source mode by default and return a verified final capture', async (t) => {
  const { root, plan } = await fixture(t);
  await chmod(plan.config.file, 0o640);
  const before = await snapshotFile(root, plan.config.file);
  const after = await atomicWrite(root, plan.config.file, plan.config.next, before);
  assert.equal((await lstat(plan.config.file)).mode & 0o777, 0o640);
  assert.equal(after.mode, 0o640);
  assert.equal(after.sha256, digest(plan.config.next));
  assert.notEqual(after.file.ino, before.file.ino);
  await assertUnchanged(root, plan.config.file, after);
});

test('readonly targets and another OS owner are refused without replacement', async (t) => {
  for (const mutation of ['readonly', 'owner'])
    await t.test(mutation, async (t) => {
      const { root, plan } = await fixture(t);
      if (mutation === 'readonly') await chmod(plan.config.file, 0o400);
      const before = await snapshotFile(root, plan.config.file);
      if (mutation === 'owner') {
        const uid = process.getuid();
        t.mock.method(process, 'getuid', () => uid + 1);
      }
      await assert.rejects(
        atomicWrite(root, plan.config.file, plan.config.next, before),
        /unsafe-config/,
      );
      assert.deepEqual(await readFile(plan.config.file), plan.config.before.bytes);
    });
});

test('rollback preserves identical-byte foreign inode replacements and changed permissions', async (t) => {
  for (const mutation of ['replacement', 'chmod'])
    await t.test(mutation, async (t) => {
      const { plan } = await fixture(t);
      let foreign;
      await assert.rejects(
        commitSetup(plan, async (...args) => {
          if (args[1] === plan.record.file) {
            if (mutation === 'replacement') {
              await rename(plan.config.file, `${plan.config.file}.ours`);
              await writeFile(plan.config.file, plan.config.next);
            } else await chmod(plan.config.file, 0o640);
            foreign = await lstat(plan.config.file);
            throw new Error('write-failed');
          }
          return atomicWrite(...args);
        }),
        /rollback-incomplete/,
      );
      assert.deepEqual(await readFile(plan.config.file), plan.config.next);
      assert.equal((await lstat(plan.config.file)).ino, foreign.ino);
      assert.equal((await lstat(plan.config.file)).mode, foreign.mode);
    });
});

test('commit returns captures for both exact service postchecks', async (t) => {
  const { root, plan } = await fixture(t);
  const completed = await commitSetup(plan);
  assert.equal(completed.config.sha256, digest(plan.config.next));
  assert.equal(completed.record.sha256, digest(plan.record.next));
  await assertUnchanged(root, plan.config.file, completed.config);
  await assertUnchanged(root, plan.record.file, completed.record);
});

test('staged or published inode substitution is refused without deleting foreign files', async (t) => {
  for (const phase of ['before-rename', 'after-rename'])
    await t.test(phase, async (t) => {
      const { root, plan } = await fixture(t);
      let foreignPath, foreign;
      await assert.rejects(
        atomicWrite(root, plan.config.file, plan.config.next, plan.config.before, undefined, {
          fault: async (at, context) => {
            if (at !== phase) return;
            foreignPath = phase === 'before-rename' ? context.temporary : plan.config.file;
            await rename(foreignPath, `${foreignPath}.ours`);
            await writeFile(foreignPath, plan.config.next);
            foreign = await lstat(foreignPath);
          },
        }),
        /write-failed|preview-stale/,
      );
      assert.deepEqual(await readFile(foreignPath), plan.config.next);
      assert.equal((await lstat(foreignPath)).ino, foreign.ino);
      if (phase === 'before-rename')
        assert.deepEqual(await readFile(plan.config.file), plan.config.before.bytes);
    });
});

test('an unacknowledged second rename leaves recovery incomplete and preserves its current file', async (t) => {
  for (const foreign of [false, true])
    await t.test(foreign ? 'foreign replacement' : 'own rename', async (t) => {
      const { plan } = await fixture(t);
      let retained;
      await assert.rejects(
        commitSetup(plan, async (...args) => {
          if (args[1] !== plan.record.file) return atomicWrite(...args);
          return atomicWrite(...args, {
            fault: async (phase) => {
              if (phase !== 'after-rename') return;
              if (foreign) {
                await rename(plan.record.file, `${plan.record.file}.ours`);
                await writeFile(plan.record.file, plan.record.next);
              }
              retained = await lstat(plan.record.file);
              throw new Error('write-failed');
            },
          });
        }),
        /rollback-incomplete/,
      );
      assert.deepEqual(await readFile(plan.config.file), plan.config.before.bytes);
      assert.deepEqual(await readFile(plan.record.file), plan.record.next);
      assert.equal((await lstat(plan.record.file)).ino, retained.ino);
    });
});
