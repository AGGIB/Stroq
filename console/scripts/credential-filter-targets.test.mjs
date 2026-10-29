import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, realpath, rm, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveCredentialTargets } from './credential-filter-targets.mjs';

async function fixture(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'stroq-filter-targets-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const project = join(dir, 'workspace'),
    userHome = join(dir, 'user');
  await mkdir(project);
  await mkdir(userHome);
  return {
    dir,
    project,
    userHome,
    home: join(userHome, '.stroq'),
    platform: 'darwin',
    claudeConfigDir: '',
  };
}
async function git(root) {
  await mkdir(join(root, '.git', 'objects'), { recursive: true });
  await mkdir(join(root, '.git', 'refs'), { recursive: true });
  await writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await writeFile(
    join(root, '.git', 'config'),
    '[core]\nrepositoryformatversion = 0\nbare = false\n',
  );
}
const claude = (v) => v.targets.find((t) => t.id === 'claude-project');

test('fixed non-Git target resolution is readonly and explicit profile relocation is unavailable', async (t) => {
  const f = await fixture(t),
    value = await resolveCredentialTargets(f);
  assert.equal(claude(value).file, join(f.project, '.claude', 'settings.local.json'));
  assert.equal(claude(value).context, 'workspace');
  assert.equal(
    value.targets.find((t) => t.id === 'claude-user').file,
    join(f.userHome, '.claude', 'settings.json'),
  );
  const relocated = await resolveCredentialTargets({
    ...f,
    claudeConfigDir: join(f.userHome, 'other'),
  });
  assert.equal(
    relocated.targets.find((t) => t.id === 'claude-user').reason,
    'credential-filter-unsupported-source',
  );
});

test('nested Git workspaces select repository local settings and retain Cursor workspace scope', async (t) => {
  const f = await fixture(t);
  await git(f.project);
  const nested = join(f.project, 'packages', 'web');
  await mkdir(nested, { recursive: true });
  const value = await resolveCredentialTargets({ ...f, project: nested });
  assert.equal(claude(value).file, join(f.project, '.claude', 'settings.local.json'));
  assert.equal(claude(value).context, 'repository');
  assert.equal(
    value.targets.find((t) => t.id === 'cursor-project').file,
    join(nested, '.cursorignore'),
  );
});

test('reciprocal linked worktree resolves main checkout without executing hooks or config', async (t) => {
  const f = await fixture(t);
  await git(f.project);
  const worktree = join(f.dir, 'worktree'),
    gd = join(f.project, '.git', 'worktrees', 'fixture');
  await mkdir(worktree);
  await mkdir(gd, { recursive: true });
  await writeFile(join(worktree, '.git'), `gitdir: ${gd}\n`);
  await writeFile(join(gd, 'commondir'), '../..\n');
  await writeFile(join(gd, 'gitdir'), `${join(worktree, '.git')}\n`);
  await writeFile(join(gd, 'HEAD'), 'ref: refs/heads/fixture\n');
  const value = await resolveCredentialTargets({ ...f, project: worktree });
  assert.equal(claude(value).file, join(f.project, '.claude', 'settings.local.json'));
  assert.equal(claude(value).location, 'main-checkout');
  assert.equal(claude(value).context, 'repository');
  await writeFile(join(gd, 'gitdir'), `${join(f.dir, 'somewhere-else', '.git')}\n`);
  assert.equal(
    claude(await resolveCredentialTargets({ ...f, project: worktree })).reason,
    'credential-filter-unsupported-source',
  );
});

test('home repository uses cwd fallback and canonical workspace alias preserves identity', async (t) => {
  const f = await fixture(t);
  await git(f.userHome);
  const nested = join(f.userHome, 'nested');
  await mkdir(nested);
  const value = await resolveCredentialTargets({ ...f, project: nested });
  assert.equal(claude(value).file, join(nested, '.claude', 'settings.local.json'));
  assert.equal(claude(value).context, 'workspace');
  const alias = join(f.dir, 'alias');
  await symlink(nested, alias);
  const aliased = await resolveCredentialTargets({ ...f, project: alias });
  assert.equal(aliased.workspaceId, value.workspaceId);
  assert.equal(claude(aliased).file, claude(value).file);
});
