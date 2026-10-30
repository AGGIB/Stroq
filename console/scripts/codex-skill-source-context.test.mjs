import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'tsup';
const repository = fileURLToPath(new URL('../../', import.meta.url));
const output = await realpath(await mkdtemp(join(tmpdir(), 'stroq-codex-context-')));
after(() => rm(output, { recursive: true, force: true }));
await build({
  entry: { context: join(repository, 'console/scripts/codex-skill-source-context.ts') },
  outDir: output,
  outExtension: () => ({ js: '.mjs' }),
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  splitting: false,
  config: false,
  dts: false,
  silent: true,
  noExternal: ['smol-toml'],
});
const { captureCodexSkillSourceContext: capture } = await import(
  pathToFileURL(join(output, 'context.mjs')).href
);
async function fixture(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'stroq-codex-tree-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const userHome = join(base, 'home');
  const repo = join(base, 'repo');
  const project = join(repo, 'nested', 'work');
  await mkdir(userHome);
  await mkdir(project, { recursive: true });
  return { base, userHome, repo, project, codexEnvironment: {} };
}
test('nearest marker file is boundary without interpreting Git target or reading older ancestors', async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.repo, '.git'));
  await writeFile(join(dirname(f.project), '.git'), 'gitdir: /unread/target');
  const c = await capture(f);
  assert.equal(c.ancestry.status, 'bounded');
  assert.equal(c.ancestry.boundary, dirname(f.project));
  assert.deepEqual(
    c.sources.map((s) => [s.family, s.scope, s.depth, s.path]),
    [
      ['agents', 'repo', 0, join(f.project, '.agents/skills')],
      ['codex-legacy', 'repo', 0, join(f.project, '.codex/skills')],
      ['agents', 'repo', 1, join(dirname(f.project), '.agents/skills')],
      ['codex-legacy', 'repo', 1, join(dirname(f.project), '.codex/skills')],
      ['agents', 'user', 0, join(f.userHome, '.agents/skills')],
      ['codex-legacy', 'user', 0, join(f.userHome, '.codex/skills')],
    ],
  );
  await c.assertCurrent();
});
test('no marker and an intentionally empty marker list produce CWD-only sources', async (t) => {
  const f = await fixture(t);
  const c = await capture(f);
  assert.equal(c.ancestry.status, 'cwd-only');
  assert.equal(c.sources.length, 4);
  await mkdir(join(f.userHome, '.codex'));
  await writeFile(join(f.userHome, '.codex/config.toml'), 'project_root_markers=[]');
  await mkdir(join(f.repo, '.git'));
  const empty = await capture(f);
  assert.equal(empty.ancestry.status, 'cwd-only');
  assert.equal(empty.sources.length, 4);
});
test('linked markers stop uncertain without following them; marker and directory substitutions invalidate capture', async (t) => {
  const f = await fixture(t);
  await symlink('/never/read/target', join(dirname(f.project), '.git'));
  const c = await capture(f);
  assert.equal(c.ancestry.status, 'uncertain');
  assert.equal(c.ancestry.reason, 'marker-unsafe');
  assert.equal(c.sources.length, 4);
  await c.assertCurrent();
  await rm(join(dirname(f.project), '.git'));
  await writeFile(join(dirname(f.project), '.git'), 'new');
  await assert.rejects(c.assertCurrent(), /changed-context/);
  const next = await capture(f);
  await rename(f.project, `${f.project}-old`);
  await mkdir(f.project);
  await assert.rejects(next.assertCurrent(), /changed-context/);
});
test('custom profile must exist canonically within user home; unsupported never falls back', async (t) => {
  const f = await fixture(t);
  const profile = join(f.userHome, 'custom');
  await mkdir(profile);
  await writeFile(join(profile, 'config.toml'), 'project_root_markers=["ROOT"]');
  await writeFile(join(f.repo, 'ROOT'), '');
  const valid = await capture({ ...f, codexEnvironment: { CODEX_HOME: profile } });
  assert.equal(valid.profile.status, 'custom');
  assert.equal(valid.ancestry.boundary, f.repo);
  for (const value of [f.repo, 'relative', join(f.userHome, 'missing')]) {
    const c = await capture({ ...f, codexEnvironment: { CODEX_HOME: value } });
    assert.equal(c.profile.status, 'unverified');
    assert.equal(c.configuration.status, 'unsupported');
    assert.equal(c.ancestry.status, 'uncertain');
    assert.equal(c.sources.length, 3);
    assert.equal(
      c.sources.some((source) => source.scope === 'user' && source.family === 'codex-legacy'),
      false,
    );
  }
  const alias = join(f.userHome, 'alias');
  await symlink(profile, alias);
  assert.equal(
    (await capture({ ...f, codexEnvironment: { CODEX_HOME: alias } })).profile.status,
    'unverified',
  );
});
test('default config link is refused, valid config is pinned, and physical user source is deduplicated', async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.userHome, '.codex'));
  const path = join(f.userHome, '.codex/config.toml');
  await writeFile(path, 'project_root_markers=[]');
  const c = await capture(f);
  await writeFile(path, 'project_root_markers=["ROOT"]');
  await assert.rejects(c.assertCurrent(), /changed-context/);
  await rm(path);
  await symlink('/never/read/config', path);
  const link = await capture(f);
  assert.equal(link.configuration.status, 'unavailable');
  assert.equal(link.ancestry.status, 'uncertain');
  await rm(path);
  const same = await capture({ ...f, project: f.userHome });
  assert.equal(same.sources.length, 2);
  assert(same.sources.every((source) => source.scope === 'user'));
});
test('ancestor walk has a hard bound and refuses a subsequently introduced marker', async (t) => {
  const f = await fixture(t);
  const project = join(f.repo, ...Array.from({ length: 35 }, (_, i) => `d${i}`));
  await mkdir(project, { recursive: true });
  const c = await capture({ ...f, project });
  assert.equal(c.ancestry.status, 'limit');
  assert.equal(c.ancestry.parents.length, 32);
  assert.equal(c.sources.length, 4);
  await mkdir(join(project, '.git'));
  await assert.rejects(c.assertCurrent(), /changed-context/);
});

test('an empty Git directory still marks the repository and context deadlines are enforced', async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.repo, '.git'));
  const c = await capture(f);
  assert.equal(c.ancestry.status, 'bounded');
  assert.equal(c.ancestry.boundary, f.repo);
  assert.equal(c.sources.filter((s) => s.scope === 'repo').length, 6);
  await assert.rejects(capture({ ...f, deadline: Date.now() - 1 }), /deadline/);
  const deadline = Date.now() + 100;
  const next = await capture({ ...f, deadline });
  const original = Date.now;
  Date.now = () => deadline + 1;
  try {
    await assert.rejects(next.assertCurrent(), /deadline/);
  } finally {
    Date.now = original;
  }
});

test('legacy user roots use only the selected canonical data directory and deduplicate exact aliases', async (t) => {
  const f = await fixture(t),
    profile = join(f.userHome, 'profile');
  await mkdir(profile);
  const custom = await capture({ ...f, codexEnvironment: { CODEX_HOME: profile } });
  assert.equal(
    custom.sources.find((source) => source.scope === 'user' && source.family === 'codex-legacy')
      .path,
    join(profile, 'skills'),
  );
  assert.equal(
    custom.sources.some(
      (source) => source.scope === 'user' && source.path === join(f.userHome, '.codex/skills'),
    ),
    false,
  );
  await mkdir(join(f.userHome, '.agents'));
  const samePhysical = await capture({
    ...f,
    codexEnvironment: { CODEX_HOME: join(f.userHome, '.agents') },
  });
  assert.equal(
    samePhysical.sources.filter((source) => source.path === join(f.userHome, '.agents/skills'))
      .length,
    1,
  );
  assert.equal(
    samePhysical.sources.find((source) => source.path === join(f.userHome, '.agents/skills'))
      .family,
    'agents',
  );
});
