import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tsImport } from 'tsx/esm/api';
const loader = await mkdtemp(join(tmpdir(), 'stroq-path-policy-loader-'));
after(() => rm(loader, { recursive: true, force: true }));
const tsconfig = join(loader, 'tsconfig.json');
await writeFile(
  tsconfig,
  JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' },
  }),
);
const api = await tsImport('./codex-path-guard-policy.ts', {
  parentURL: import.meta.url,
  tsconfig,
});
const home = '/owned/user',
  project = '/owned/project',
  target = home + '/.aws/credentials';
const input = (user, projects = []) => ({
  user,
  persistent: user,
  projects,
  home,
  project,
  temporary: { tmpdir: '/owned/tmp', slashTmp: '/private/tmp' },
});
const profile = (filesystem, extra = {}) => ({
  default_permissions: 'source',
  permissions: {
    source: {
      extends: ':workspace',
      ...(filesystem === undefined ? {} : { filesystem }),
      network: { enabled: true },
      ...extra,
    },
  },
});
test('same-ID named graph supports absent, empty and existing filesystem declarations without selecting a new profile', () => {
  for (const fs of [
    undefined,
    {},
    { ':root': 'read' },
    { [home]: 'write' },
    { ':workspace_roots': { '**/*.env': 'deny' } },
  ]) {
    const r = api.pathGuardPolicy(input(profile(fs)), target);
    assert.equal(r.profileName, 'source');
    assert.equal(r.reason, null);
    assert.equal(r.declaration, fs?.[home] === 'write' ? 'write' : 'read');
    assert.equal(r.baseline.network, 'on');
    assert.equal(r.baseline.kind, 'profile');
  }
});
test('most specific captured path declaration wins while pre-existing effective denial is not adopted', () => {
  assert.equal(api.pathGuardPolicy(input(profile({ [home]: 'deny' })), target).declaration, 'deny');
  assert.equal(
    api.pathGuardPolicy(input(profile({ [home]: 'deny', [target]: 'read' })), target).declaration,
    'read',
  );
  assert.equal(
    api.pathGuardPolicy(input(profile({ [target]: 'deny' })), target).declaration,
    'deny',
  );
  assert.equal(
    api.pathGuardPolicy(input(profile({ '~/.aws': 'deny' })), target).declaration,
    'deny',
  );
  assert.equal(
    api.pathGuardPolicy(input(profile({ [target]: 'read', '~/.aws/credentials': 'deny' })), target)
      .declaration,
    'deny',
  );
});
test('unrelated project denies merge; selectors, same-profile grants and changed parents are explicit refusals', () => {
  let r = api.pathGuardPolicy(
    input(profile(), [
      { permissions: { source: { filesystem: { [project + '/private']: 'deny' } } } },
    ]),
    target,
  );
  assert.equal(r.reason, null);
  assert.equal(r.declaration, 'read');
  for (const p of [
    { default_permissions: 'source' },
    { sandbox_mode: 'read-only' },
    { permissions: { source: { filesystem: { [target]: 'read' } } } },
    { permissions: { source: { extends: ':read-only' } } },
  ])
    assert.equal(
      api.pathGuardPolicy(input(profile(), [p]), target).reason,
      'codex-path-guard-project-override',
    );
  r = api.pathGuardPolicy(
    input(profile(), [{ permissions: { inactive: { filesystem: { [target]: 'read' } } } }]),
    target,
  );
  assert.equal(r.reason, null);
});
test('unresolved, cyclic, builtin and mixed selections never become eligible current-profile changes', () => {
  for (const d of [
    {},
    { default_permissions: ':workspace' },
    { default_permissions: ':read-only' },
    { ...profile(), sandbox_mode: 'workspace-write' },
    profile(undefined, { extends: 'missing' }),
    profile(undefined, { extends: 'source' }),
  ]) {
    const r = api.pathGuardPolicy(input(d), target);
    assert.notEqual(r.reason, null);
    assert.equal(r.declaration, 'unknown');
  }
  const user = profile(),
    persistent = {
      ...user,
      default_permissions: 'source',
      permissions: { source: { extends: 'system' }, system: { extends: ':read-only' } },
    };
  assert.equal(api.pathGuardPolicy({ ...input(user), persistent }, target).declaration, 'read');
});
test('scoped project denies remain narrow; potentially matching globs are unavailable rather than a guessed permit', () => {
  const fs = { ':workspace_roots': { '.': 'write', '**/*.env': 'deny' } };
  assert.equal(api.pathGuardPolicy(input(profile(fs)), target).reason, null);
  let i = input(profile({ '~/.aws/**': 'deny' }));
  assert.equal(api.pathGuardPolicy(i, target).reason, 'codex-path-guard-unsupported');
  i = input(profile({ '~/unrelated/**': 'deny' }));
  assert.equal(api.pathGuardPolicy(i, target).reason, null);
  i = input(profile({ [target]: { nested: 'write' } }));
  assert.equal(api.pathGuardPolicy(i, target).reason, 'codex-path-guard-unsupported');
});
test('restoring a prior grant refuses new related denial or inherited dependency changes while unrelated edits survive', () => {
  const before = profile({ [target]: 'read', [project + '/old']: 'deny' });
  let current = structuredClone(before);
  current.permissions.source.filesystem[target] = 'deny';
  current.permissions.source.filesystem[project + '/new'] = 'deny';
  current.permissions.source.network.enabled = false;
  assert.doesNotThrow(() =>
    api.assertPathGuardRestorePolicy(before, current, 'source', target, input(before)),
  );
  current.permissions.source.filesystem['~/.aws'] = 'deny';
  assert.throws(
    () => api.assertPathGuardRestorePolicy(before, current, 'source', target, input(before)),
    /codex-path-guard-conflict/,
  );
  current = structuredClone(before);
  current.permissions.source.filesystem[target] = 'deny';
  current.permissions.source.extends = 'other';
  current.permissions.other = { extends: ':read-only' };
  assert.throws(
    () => api.assertPathGuardRestorePolicy(before, current, 'source', target, input(before)),
    /codex-path-guard-conflict/,
  );
  const inserted = profile();
  assert.throws(
    () => api.assertPathGuardRestorePolicy(inserted, current, 'source', target, input(inserted)),
    /codex-path-guard-conflict/,
  );
});
test('Restore checks revealed alias/scoped/inherited exceptions even when the owned canonical leaf was originally absent', () => {
  for (const fs of [{ '~/.aws/credentials': 'read' }, { '~/.aws': { credentials: 'read' } }]) {
    const before = profile(fs),
      current = structuredClone(before);
    current.permissions.source.filesystem[target] = 'deny';
    current.permissions.source.filesystem[home + '/.aws'] = 'deny';
    assert.throws(
      () => api.assertPathGuardRestorePolicy(before, current, 'source', target, input(before)),
      /codex-path-guard-conflict/,
    );
  }
  const before = {
      default_permissions: 'source',
      permissions: {
        source: { extends: 'parent' },
        parent: { extends: ':workspace', filesystem: { [target]: 'read' } },
      },
    },
    current = structuredClone(before);
  current.permissions.source.filesystem = { [target]: 'deny', '~/.aws': 'deny' };
  assert.throws(
    () => api.assertPathGuardRestorePolicy(before, current, 'source', target, input(before)),
    /codex-path-guard-conflict/,
  );
});
test('builtin workspace specificity is never replaced by a broad root deny or reported as a guessed write', () => {
  const i = { ...input(profile({ ':root': 'deny', ':minimal': 'read' })), project: home };
  const r = api.pathGuardPolicy(i, home + '/.npmrc');
  assert.equal(r.declaration, 'unknown');
  assert.equal(r.reason, 'codex-path-guard-unsupported');
  assert.equal(
    api.pathGuardPolicy({ ...input(profile()), project: home }, target).declaration,
    'unknown',
  );
});
test('reserved custom profile names and dot-segment scoped entries are not accepted as native configuration', () => {
  for (const d of [
    { default_permissions: 'filesystem', permissions: { filesystem: { extends: ':workspace' } } },
    profile(undefined, { extends: 'filesystem' }),
  ])
    assert.notEqual(api.pathGuardPolicy(input(d), target).reason, null);
  for (const sub of ['./credentials', 'a/./b'])
    assert.equal(
      api.pathGuardPolicy(input(profile({ '~/.aws': { [sub]: 'read' } })), target).reason,
      'codex-path-guard-unsupported',
    );
});
test('returning a prior write cannot reopen a later read-only ancestor; an original deliberate exception remains restorable', () => {
  const before = profile({ [target]: 'write' }),
    current = profile({ [target]: 'deny', '~/.aws': 'read' });
  assert.throws(
    () => api.assertPathGuardRestorePolicy(before, current, 'source', target, input(before)),
    /codex-path-guard-conflict/,
  );
  const existing = profile({ [target]: 'write', '~/.aws': 'read' });
  assert.doesNotThrow(() =>
    api.assertPathGuardRestorePolicy(existing, current, 'source', target, input(existing)),
  );
});
