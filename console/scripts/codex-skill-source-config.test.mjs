import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'tsup';
const repository = fileURLToPath(new URL('../../', import.meta.url));
const output = await realpath(await mkdtemp(join(tmpdir(), 'stroq-codex-config-')));
after(() => rm(output, { recursive: true, force: true }));
await build({
  entry: {
    config: join(repository, 'console/scripts/codex-skill-source-config.ts'),
    files: join(repository, 'console/scripts/inventory-observation-files.ts'),
  },
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
const api = await import(pathToFileURL(join(output, 'config.mjs')).href);
const { rootIdentity } = await import(pathToFileURL(join(output, 'files.mjs')).href);
async function fixture(t, content) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'stroq-codex-user-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  const profile = join(home, '.codex');
  await mkdir(profile);
  const path = join(profile, 'config.toml');
  if (content !== undefined) await writeFile(path, content);
  return { home, profile, path, root: await rootIdentity(home) };
}
test('missing config defaults only the marker policy and declares no skill state', async (t) => {
  const f = await fixture(t);
  const c = await api.captureCodexSkillConfig(f);
  assert.equal(c.configuration.status, 'missing');
  assert.equal(c.configuration.sha256, null);
  assert.deepEqual(c.configuration.markers, ['.git']);
  assert.equal(c.configuration.markerStatus, 'default');
  assert.equal(
    api.declaredSkillState(c.configuration, { path: '/x/SKILL.md', name: 'x' }),
    'not-specified',
  );
  await c.assertCurrent();
});
test('strict TOML preserves boolean types and refuses duplicate keys, invalid UTF8 and oversized config', async (t) => {
  for (const content of [
    '[[skills.config]]\npath="/x/SKILL.md"\nenabled="false"',
    'project_root_markers=[]\nproject_root_markers=[]',
    Buffer.from([255]),
    ' '.repeat(256 * 1024 + 1),
  ]) {
    const f = await fixture(t, content);
    const c = await api.captureCodexSkillConfig(f);
    assert.ok(['invalid', 'unavailable'].includes(c.configuration.status));
    assert.equal(c.configuration.markerStatus, 'unknown');
    assert.equal(
      api.declaredSkillState(c.configuration, { path: '/x/SKILL.md', name: 'x' }),
      'unknown',
    );
  }
});
test('basename marker policy is bounded; empty list intentionally disables ancestry', async (t) => {
  for (const [content, status, markers] of [
    ['project_root_markers=[]', 'ready', []],
    ['project_root_markers=[".hg","BOUNDARY"]', 'ready', ['.hg', 'BOUNDARY']],
    ['project_root_markers=["../foreign"]', 'unsupported', []],
    ['project_root_markers=".git"', 'invalid', []],
  ]) {
    const c = await api.captureCodexSkillConfig(await fixture(t, content));
    assert.equal(c.configuration.status, status);
    assert.deepEqual(c.configuration.markers, markers);
  }
});
test('later selectors override in order while a final unresolved path preserves uncertainty', async (t) => {
  const f = await fixture(
    t,
    '[[skills.config]]\npath="../.agents/skills/x/SKILL.md"\nenabled=false\n[[skills.config]]\nname=" x "\nenabled=true\n[[skills.config]]\npath="../.agents/skills/x"\nenabled=false',
  );
  const { configuration: c } = await api.captureCodexSkillConfig(f);
  const path = join(f.home, '.agents/skills/x/SKILL.md');
  assert.equal(api.declaredSkillState(c, { path, name: 'x' }), 'unknown');
  assert.equal(
    api.declaredSkillState({ ...c, rules: c.rules.slice(0, 2) }, { path, name: 'x' }),
    'enabled',
  );
  assert.equal(api.declaredSkillState(c, { path, name: null }), 'unknown');
  assert.equal(
    api.declaredSkillState(c, { path: join(f.home, '.agents/skills/x'), name: 'z' }),
    'disabled',
  );
  assert.equal(
    api.declaredSkillState(
      { ...c, rules: [...c.rules, { kind: 'path', value: path, enabled: true }] },
      { path, name: null },
    ),
    'enabled',
  );
});
test('ignored selectors remain counted and configuration snapshots are pinned without writes', async (t) => {
  const f = await fixture(
    t,
    '[[skills.config]]\nname=" "\nenabled=false\n[[skills.config]]\nname="x"\npath="/x"\nenabled=false\n[[skills.config]]\nenabled=true',
  );
  const c = await api.captureCodexSkillConfig(f);
  assert.equal(c.configuration.ignoredRules, 3);
  assert.equal(c.configuration.rules.length, 0);
  const before = await readFile(f.path);
  await c.assertCurrent();
  assert.deepEqual(await readFile(f.path), before);
  await writeFile(f.path, 'project_root_markers=[]');
  await assert.rejects(c.assertCurrent(), /changed-context/);
});

test('unknown names preserve repeated-selector semantics and later exact-path decisions', async (t) => {
  const f = await fixture(
    t,
    '[[skills.config]]\npath="/captured/SKILL.md"\nenabled=false\n[[skills.config]]\nname="x"\nenabled=true\n[[skills.config]]\nname="x"\nenabled=false',
  );
  const { configuration: c } = await api.captureCodexSkillConfig(f);
  assert.equal(api.declaredSkillState(c, { path: '/captured/SKILL.md', name: null }), 'disabled');
  assert.equal(api.declaredSkillState(c, { path: '/captured/SKILL.md', name: 'x' }), 'disabled');
});

test('an initially refused config becoming readable invalidates the observation context', async (t) => {
  const f = await fixture(t);
  await symlink('/never/read/config', f.path);
  const c = await api.captureCodexSkillConfig(f);
  assert.equal(c.configuration.status, 'unavailable');
  await c.assertCurrent();
  await rm(f.path);
  await writeFile(f.path, 'project_root_markers=[]');
  await assert.rejects(c.assertCurrent(), /changed-context/);
});

test('folder selectors never expand and unresolved selectors stay unknown without target reads', async (t) => {
  const f = await fixture(t, '[[skills.config]]\npath="/does-not-exist/folder"\nenabled=false');
  const { configuration: c } = await api.captureCodexSkillConfig(f);
  assert.equal(
    api.declaredSkillState(c, { path: '/does-not-exist/folder/SKILL.md', name: 'folder' }),
    'unknown',
  );
  assert.equal(
    api.declaredSkillState(c, { path: '/does-not-exist/folder', name: 'folder' }),
    'disabled',
  );
});
test('same-byte config inode or config-parent replacements are refused and deadlines apply to recheck', async (t) => {
  const f = await fixture(t, 'project_root_markers=[]');
  const c = await api.captureCodexSkillConfig(f);
  await rename(f.path, `${f.path}.old`);
  await writeFile(f.path, 'project_root_markers=[]');
  await assert.rejects(c.assertCurrent(), /changed-context/);
  const next = await api.captureCodexSkillConfig(f);
  await rename(f.profile, `${f.profile}.old`);
  await mkdir(f.profile);
  await writeFile(f.path, 'project_root_markers=[]');
  await assert.rejects(next.assertCurrent(), /changed-context/);
  await assert.rejects(api.captureCodexSkillConfig({ ...f, deadline: Date.now() - 1 }), /deadline/);
  const deadline = Date.now() + 100;
  const last = await api.captureCodexSkillConfig({ ...f, deadline });
  const original = Date.now;
  Date.now = () => deadline + 1;
  try {
    await assert.rejects(last.assertCurrent(), /deadline/);
  } finally {
    Date.now = original;
  }
});

test('a TOML date is not accepted as a skills configuration table', async (t) => {
  const { configuration: c } = await api.captureCodexSkillConfig(
    await fixture(t, 'skills=1979-05-27'),
  );
  assert.equal(c.status, 'invalid');
  assert.equal(c.markerStatus, 'unknown');
});

test('unresolved path aliases cannot silently become Not specified', async (t) => {
  const { configuration: c } = await api.captureCodexSkillConfig(
    await fixture(t, '[[skills.config]]\npath="/tmp/skill-alias/SKILL.md"\nenabled=false'),
  );
  assert.equal(
    api.declaredSkillState(c, {
      path: '/private/tmp/captured/SKILL.md',
      name: 'captured',
      knownPaths: new Set(['/private/tmp/captured/SKILL.md']),
    }),
    'unknown',
  );
});
test('later known name/path declarations override earlier alias uncertainty', async (t) => {
  const { configuration: c } = await api.captureCodexSkillConfig(
    await fixture(
      t,
      '[[skills.config]]\npath="/tmp/skill-alias/SKILL.md"\nenabled=false\n[[skills.config]]\nname="captured"\nenabled=true',
    ),
  );
  const item = {
    path: '/private/tmp/captured/SKILL.md',
    name: 'captured',
    knownPaths: new Set(['/private/tmp/captured/SKILL.md']),
  };
  assert.equal(api.declaredSkillState(c, item), 'enabled');
  assert.equal(
    api.declaredSkillState(
      { ...c, rules: [...c.rules, { kind: 'path', value: item.path, enabled: false }] },
      { ...item, name: null },
    ),
    'disabled',
  );
});
test('a different verified candidate path is a definite nonmatch without selector reads', async (t) => {
  const { configuration: c } = await api.captureCodexSkillConfig(
    await fixture(t, '[[skills.config]]\npath="/private/tmp/other/SKILL.md"\nenabled=false'),
  );
  assert.equal(
    api.declaredSkillState(c, {
      path: '/private/tmp/captured/SKILL.md',
      name: 'captured',
      knownPaths: new Set(['/private/tmp/captured/SKILL.md', '/private/tmp/other/SKILL.md']),
    }),
    'not-specified',
  );
  assert.equal(
    api.declaredSkillState(c, { path: '/private/tmp/captured/SKILL.md', name: 'captured' }),
    'unknown',
  );
});
test('unknown names and repeated unresolved selectors preserve definite ordered outcomes', async (t) => {
  const { configuration: c } = await api.captureCodexSkillConfig(
    await fixture(
      t,
      '[[skills.config]]\npath="/private/tmp/captured/SKILL.md"\nenabled=false\n[[skills.config]]\npath="/tmp/alias/SKILL.md"\nenabled=true\n[[skills.config]]\nname="x"\nenabled=true\n[[skills.config]]\nname="x"\nenabled=false\n[[skills.config]]\npath="/tmp/alias/SKILL.md"\nenabled=false',
    ),
  );
  assert.equal(
    api.declaredSkillState(c, { path: '/private/tmp/captured/SKILL.md', name: null }),
    'disabled',
  );
});

test('name selectors trim Unicode White_Space U+0085 at the edges and ignore whitespace-only names', async (t) => {
  const { configuration: c } = await api.captureCodexSkillConfig(
    await fixture(
      t,
      '[[skills.config]]\nname="\\u0085x\\u0085"\nenabled=false\n[[skills.config]]\nname="\\u0085"\nenabled=false',
    ),
  );
  assert.equal(c.status, 'ready');
  assert.equal(c.rules[0].value, 'x');
  assert.equal(c.ignoredRules, 1);
  assert.equal(api.declaredSkillState(c, { path: '/captured/SKILL.md', name: 'x' }), 'disabled');
});
test('name selectors preserve U+FEFF because it is not Rust Unicode White_Space', async (t) => {
  const { configuration: c } = await api.captureCodexSkillConfig(
    await fixture(
      t,
      '[[skills.config]]\nname="\\uFEFFx\\uFEFF"\nenabled=false\n[[skills.config]]\nname="\\uFEFF"\nenabled=true',
    ),
  );
  assert.equal(c.status, 'ready');
  assert.equal(c.rules[0].value, '\uFEFFx\uFEFF');
  assert.equal(c.ignoredRules, 0);
  assert.equal(c.rules.length, 2);
  assert.equal(
    api.declaredSkillState(c, { path: '/captured/SKILL.md', name: 'x' }),
    'not-specified',
  );
  assert.equal(
    api.declaredSkillState(c, { path: '/captured/SKILL.md', name: '\uFEFFx\uFEFF' }),
    'disabled',
  );
});
