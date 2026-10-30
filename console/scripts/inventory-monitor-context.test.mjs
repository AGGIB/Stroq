import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'tsup';
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = await realpath(await mkdtemp(join(tmpdir(), 'stroq-inventory-monitor-context-')));
after(() => rm(output, { recursive: true, force: true }));
await build({
  entry: {
    context: join(repository, 'console/scripts/inventory-monitor-context.ts'),
    sources: join(repository, 'console/scripts/skill-sources.ts'),
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
  noExternal: ['@stroq/core', 'yaml', 'zod'],
  banner: {
    js: "import {createRequire as createContextRequire} from 'node:module';const require=createContextRequire(import.meta.url);",
  },
  esbuildOptions(options) {
    options.alias = { '@stroq/core': join(repository, 'packages/core/src/index.ts') };
  },
});
const {
  assertInventoryMonitorContext: guard,
  INVENTORY_MONITOR_SKILL_ROOTS: paths,
  inventorySourceProfileSha256: profile,
} = await import(pathToFileURL(join(output, 'context.mjs')).href);
const { SKILL_DISCOVERY_SOURCES: sources } = await import(
  pathToFileURL(join(output, 'sources.mjs')).href
);
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'stroq-monitor-context-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project'),
    user = join(root, 'user');
  await mkdir(project);
  await mkdir(user);
  return { root, project, user, roots: { project: { path: project }, user: { path: user } } };
}
test('context roots match all six authoritative discovery source pairs', () => {
  assert.deepEqual(
    paths,
    sources.map(({ project, user }) => ({ project, user })),
  );
});
test('all fixed project/user roots refuse data home and missing descendant without a write', async (t) => {
  const f = await fixture(t);
  for (const source of paths)
    for (const scope of ['project', 'user'])
      for (const suffix of ['', 'new/state'])
        await assert.rejects(
          guard({ roots: f.roots, home: join(f[scope], source[scope], suffix) }),
          /context-unavailable/,
        );
  await guard({ roots: f.roots, home: join(f.project, '.stroq') });
  await guard({ roots: f.roots, home: join(f.user, '.stroq') });
  await guard({ roots: f.roots, home: join(f.project, '.cursor/skills-other/state') });
});
test('existing alias and missing child below a symlink cannot hide self-observation', async (t) => {
  const f = await fixture(t),
    captured = join(f.project, '.codex/skills/group');
  await mkdir(captured, { recursive: true });
  const alias = join(f.root, 'outside-alias');
  await symlink(captured, alias);
  await assert.rejects(guard({ roots: f.roots, home: alias }), /context-unavailable/);
  await assert.rejects(
    guard({ roots: f.roots, home: join(alias, 'missing/profile') }),
    /context-unavailable/,
  );
});
test('home-as-workspace applies the canonical user source set once', async (t) => {
  const f = await fixture(t),
    roots = { project: { path: f.user }, user: { path: f.user } };
  await assert.rejects(
    guard({ roots, home: join(f.user, '.codeium/windsurf/skills/state') }),
    /context-unavailable/,
  );
  await guard({ roots, home: join(f.user, '.windsurf/skills/state') });
});

test('source profiles normalize effective MCP environment and bind actual platform selection', () => {
  const user = '/fixture/user',
    first = profile(user, {}, 'linux');
  assert.equal(
    first,
    profile(user, { XDG_CONFIG_HOME: '', APPDATA: '/ignored', UNUSED: 'ignored' }, 'linux'),
  );
  assert.equal(first, profile(user, { XDG_CONFIG_HOME: '/fixture/user/.config/./' }, 'linux'));
  assert.notEqual(first, profile(user, { XDG_CONFIG_HOME: '/fixture/user/custom' }, 'linux'));
  assert.notEqual(first, profile(user, {}, 'win32'));
  assert.equal(
    profile(user, { XDG_CONFIG_HOME: '../foreign' }, 'linux'),
    profile(user, { XDG_CONFIG_HOME: '/outside' }, 'linux'),
  );
});
