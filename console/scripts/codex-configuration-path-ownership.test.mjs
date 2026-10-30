import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import {
  mkdtemp,
  writeFile,
  mkdir,
  rm,
  realpath,
  lstat,
  symlink,
  readFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { tsImport } from 'tsx/esm/api';
import { rootIdentity } from './agent-setup-files.mjs';
const loader = await mkdtemp(join(tmpdir(), 'stroq-path-ownership-loader-'));
after(() => rm(loader, { recursive: true, force: true }));
const tsconfig = join(loader, 'tsconfig.json');
await writeFile(
  tsconfig,
  JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' },
  }),
);
const load = (p) => tsImport(p, { parentURL: import.meta.url, tsconfig });
const pending = await load('./codex-configuration-pending.ts');
const ownership = await load('./codex-configuration-ownership.ts');
const id = '00000000-0000-4000-8000-000000000001',
  child = 'stroq-network-' + id,
  target = '/owned/user/.codex/config.toml';
const net = (extra = {}) => ({
  manifest: {
    id,
    target,
    kind: 'profile-child',
    childProfile: child,
    sequence: 1,
    phase: 'guarded',
    ownedKeys: [['default_permissions'], ['permissions', child]],
    ...extra,
  },
});
const path = (extra = {}) => ({
  manifest: { target, profileName: child, kind: 'profile-path-deny', phase: 'guarded', ...extra },
});
test('a retained path operation permanently prevents an older child-selector Restore, including after path Restore', () => {
  const old = net();
  assert.equal(ownership.networkGuardHasPathDependents(old, []), false);
  for (const phase of ['prepared', 'guarded', 'restoring', 'restored'])
    assert.equal(ownership.networkGuardHasPathDependents(old, [path({ phase })]), true);
  assert.equal(
    ownership.networkGuardHasPathDependents(old, [path({ profileName: 'other' })]),
    false,
  );
  assert.equal(
    ownership.networkGuardHasPathDependents(old, [
      path({ target: '/owned/user/alternate/config.toml' }),
    ]),
    false,
  );
  assert.equal(
    ownership.networkGuardHasPathDependents(net({ kind: 'profile-network-off' }), [path()]),
    false,
  );
});
test('new path admission refuses a restorable foreign child; superseded and restored selectors remain inert', () => {
  const old = net();
  assert.equal(ownership.pathGuardHasRestorableNetworkSelector(target, child, [old]), true);
  assert.equal(ownership.pathGuardHasRestorableNetworkSelector(target, 'other', [old]), false);
  assert.equal(
    ownership.pathGuardHasRestorableNetworkSelector(target, child, [net({ phase: 'restored' })]),
    false,
  );
  const newer = net({
    id: '00000000-0000-4000-8000-000000000002',
    kind: 'profile-network-off',
    sequence: 2,
    ownedKeys: [['permissions', child, 'network', 'enabled']],
  });
  assert.equal(ownership.pathGuardHasRestorableNetworkSelector(target, child, [old, newer]), false);
  assert.equal(
    ownership.pathGuardHasRestorableNetworkSelector(
      target,
      child,
      [old],
      [path({ phase: 'restored' })],
    ),
    false,
  );
});
async function fixture(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'stroq-path-config-gate-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const user = join(base, 'user');
  await mkdir(user, { mode: 0o700 });
  const root = await rootIdentity(user);
  return {
    base,
    user,
    context: {
      id: 'codex-context-' + 'a'.repeat(64),
      user: root,
      target: join(user, '.codex/config.toml'),
      rootBinding: createHash('sha256').update(JSON.stringify(root)).digest('hex'),
    },
  };
}
test('all three domain preflights are passive and do not create a new recovery store', async (t) => {
  const f = await fixture(t);
  for (const domain of ['skill', 'network', 'path'])
    await pending.assertNoPendingCodexConfiguration(f.context, domain);
  await assert.rejects(lstat(join(f.user, '.stroq')), { code: 'ENOENT' });
});
test('an orphan Path intent blocks every selected-Codex-home writer without changing its evidence', async (t) => {
  const f = await fixture(t),
    vault = join(f.user, '.stroq/codex-path-guard');
  await mkdir(join(f.user, '.stroq'), { mode: 0o700 });
  await mkdir(vault, { mode: 0o700 });
  await writeFile(join(vault, '.gitignore'), '*\n', { mode: 0o600 });
  await mkdir(join(vault, '.prepared-' + id), { mode: 0o700 });
  for (const [domain, code] of [
    ['skill', 'codex-control-recovery-required'],
    ['network', 'codex-network-recovery-required'],
    ['path', 'codex-path-guard-recovery-required'],
  ])
    for (const context of [
      f.context,
      {
        ...f.context,
        id: 'codex-context-' + 'b'.repeat(64),
        target: join(f.user, 'alternate/config.toml'),
      },
    ])
      await assert.rejects(pending.assertNoPendingCodexConfiguration(context, domain), {
        message: code,
      });
  assert.equal(await readFile(join(vault, '.gitignore'), 'utf8'), '*\n');
  assert.equal((await lstat(join(vault, '.prepared-' + id))).isDirectory(), true);
});
test('unsafe third-domain storage cannot be bypassed by an older Skill or Network control', async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.user, '.stroq'), { mode: 0o700 });
  const outside = join(f.base, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'marker'), 'inert');
  await symlink(outside, join(f.user, '.stroq/codex-path-guard'));
  for (const [domain, code] of [
    ['skill', 'codex-control-recovery-required'],
    ['network', 'codex-network-recovery-required'],
    ['path', 'codex-path-guard-recovery-required'],
  ])
    await assert.rejects(pending.assertNoPendingCodexConfiguration(f.context, domain), {
      message: code,
    });
  assert.equal(await readFile(join(outside, 'marker'), 'utf8'), 'inert');
});
