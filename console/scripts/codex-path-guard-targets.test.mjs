import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import {
  mkdtemp,
  mkdir,
  writeFile,
  chmod,
  link,
  symlink,
  rename,
  rm,
  realpath,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { tsImport } from 'tsx/esm/api';
import { rootIdentity } from './agent-setup-files.mjs';
const loader = await mkdtemp(join(tmpdir(), 'stroq-path-target-loader-'));
after(() => rm(loader, { recursive: true, force: true }));
const tsconfig = join(loader, 'tsconfig.json');
await writeFile(
  tsconfig,
  JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' },
  }),
);
const api = await tsImport('./codex-path-guard-targets.ts', {
  parentURL: import.meta.url,
  tsconfig,
});
async function fixture(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'stroq-path-targets-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const user = join(base, 'user');
  await mkdir(user, { mode: 0o700 });
  return { base, user, root: await rootIdentity(user) };
}
test('fixed preset routes inspect metadata even when an inert credential cannot be read', async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.user, '.aws'), { mode: 0o700 });
  const target = join(f.user, '.aws/credentials'),
    secret = 'inert-never-read-body-7f10';
  await writeFile(target, secret, { mode: 0o600 });
  await chmod(target, 0);
  const c = await api.capturePathGuardTargets(f.root);
  assert.deepEqual(
    c.targets.map((x) => x.id),
    ['aws-credentials', 'ssh-ed25519', 'ssh-rsa', 'npmrc', 'netrc', 'pgpass', 'git-credentials'],
  );
  assert.equal(c.targets[0].status, 'regular');
  assert.equal(c.targets[0].file.mode & 0o777, 0);
  assert.equal(c.targets[0].file.size, Buffer.byteLength(secret));
  assert.ok(c.targets.slice(1).every((x) => x.status === 'absent'));
  assert.match(c.sha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(c).includes(secret), false);
  assert.ok(
    c.targets.every((x) => !('bytes' in x) && !('content' in x) && !('contentSha256' in x)),
  );
  await api.assertPathGuardTargets(f.root, c);
});
test('unsafe symlink parents, hardlinked files and directories never become eligible file metadata', async (t) => {
  const f = await fixture(t);
  const other = join(f.base, 'outside');
  await mkdir(other);
  await symlink(other, join(f.user, '.ssh'));
  await writeFile(join(f.user, '.npmrc'), 'inert');
  await link(join(f.user, '.npmrc'), join(f.user, 'alias'));
  await mkdir(join(f.user, '.netrc'));
  const c = await api.capturePathGuardTargets(f.root);
  for (const id of ['ssh-ed25519', 'ssh-rsa', 'npmrc', 'netrc'])
    assert.equal(c.targets.find((x) => x.id === id).status, 'unsafe');
  assert.equal(c.targets.find((x) => x.id === 'pgpass').status, 'absent');
});
test('same-content replacement, later creation and changed parent identities invalidate the exact metadata capture', async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.user, '.aws'));
  const target = join(f.user, '.aws/credentials');
  await writeFile(target, 'inert');
  let c = await api.capturePathGuardTargets(f.root);
  await writeFile(join(f.user, '.aws/replacement'), 'inert');
  await rename(join(f.user, '.aws/replacement'), target);
  await assert.rejects(api.assertPathGuardTargets(f.root, c), /codex-path-guard-stale/);
  c = await api.capturePathGuardTargets(f.root);
  await writeFile(join(f.user, '.pgpass'), 'inert');
  await assert.rejects(api.assertPathGuardTargets(f.root, c), /codex-path-guard-stale/);
  c = await api.capturePathGuardTargets(f.root);
  await rename(join(f.user, '.aws'), join(f.user, '.old-aws'));
  await mkdir(join(f.user, '.aws'));
  await assert.rejects(api.assertPathGuardTargets(f.root, c), /codex-path-guard-stale/);
});
test('only finite IDs derive paths; parent permission changes and a replaced selected user root are refused', async (t) => {
  const f = await fixture(t);
  assert.equal(
    api.pathGuardTargetPath(f.root, 'aws-credentials'),
    join(f.user, '.aws/credentials'),
  );
  for (const id of ['../../outside', 'unknown', {}, null, '__proto__'])
    assert.throws(() => api.pathGuardTargetPath(f.root, id), /codex-path-guard-invalid/);
  await mkdir(join(f.user, '.aws'), { mode: 0o777 });
  await chmod(join(f.user, '.aws'), 0o777);
  let c = await api.capturePathGuardTargets(f.root);
  assert.equal(c.targets[0].status, 'unsafe');
  await rename(f.user, join(f.base, 'old-user'));
  await mkdir(f.user);
  await assert.rejects(api.assertPathGuardTargets(f.root, c), /codex-path-guard-stale/);
});
