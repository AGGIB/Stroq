import assert from 'node:assert/strict';
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as files from './mcp-containment-files.mjs';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'stroq-skill-lock-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const user = join(root, 'user');
  await mkdir(user);
  return { root, user };
}

test('Codex skill lock is USERHOME-scoped with a separate fixed namespace', async (t) => {
  const { user } = await fixture(t);
  assert.equal(typeof files.prepareCodexSkillApplyLock, 'function');
  const first = await files.prepareCodexSkillApplyLock(user);
  const second = await files.prepareCodexSkillApplyLock(user);
  const mcp = await files.prepareApplyLock(user);
  assert.equal(first.path, join(user, '.stroq', '.codex-skill-controls.apply.lock'));
  assert.equal(second.path, first.path);
  assert.notEqual(first.path, mcp.path);
  assert.equal((await lstat(join(user, '.stroq'))).mode & 0o777, 0o700);
  await assert.rejects(access(join(user, '.codex')));
  await assert.rejects(access(first.path));
});

test('Codex skill lock refuses linked stores without touching the target', async (t) => {
  const { root, user } = await fixture(t);
  const outside = join(root, 'outside');
  await mkdir(outside);
  await symlink(outside, join(user, '.stroq'));
  await assert.rejects(files.prepareCodexSkillApplyLock(user), /codex-control-unavailable/);
  await assert.rejects(access(join(outside, '.codex-skill-controls.apply.lock')));
});

test('Codex skill lock refuses unsafe directory permissions and linked lease paths', async (t) => {
  const { root, user } = await fixture(t);
  const directory = join(user, '.stroq');
  await mkdir(directory, { mode: 0o700 });
  await chmod(directory, 0o777);
  await assert.rejects(files.prepareCodexSkillApplyLock(user), /codex-control-unavailable/);
  await chmod(directory, 0o700);
  await symlink(root, join(directory, '.codex-skill-controls.apply.lock'));
  await assert.rejects(files.prepareCodexSkillApplyLock(user), /codex-control-unavailable/);
});

test('Codex skill lock refuses a replaced USERHOME before creating metadata', async (t) => {
  const { root, user } = await fixture(t);
  const s = await lstat(user);
  const expected = { path: user, dev: s.dev, ino: s.ino, uid: s.uid, mode: s.mode };
  await rename(user, join(root, 'former-user'));
  await mkdir(user);
  await assert.rejects(
    files.prepareCodexSkillApplyLock(user, expected),
    /codex-control-unavailable/,
  );
  await assert.rejects(access(join(user, '.stroq')));
});
