import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';

const loader = await mkdtemp(join(tmpdir(), 'stroq-contract-unique-loader-'));
after(() => rm(loader, { recursive: true, force: true }));
const tsconfig = join(loader, 'tsconfig.json');
await writeFile(
  tsconfig,
  JSON.stringify({
    compilerOptions: {
      baseUrl: resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
      paths: { '@stroq/core': ['packages/core/src/index.ts'] },
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      esModuleInterop: true,
      resolveJsonModule: true,
    },
  }),
);
const imported = (path) => tsImport(path, { parentURL: import.meta.url, tsconfig });
const { assertUniqueToolReviewBinding } = await imported('./mcp-tool-contract-unique.ts');
const { strictProxyEntry } = await imported('./mcp-containment-proxy.ts');

async function fixture(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'stroq-contract-unique-'))),
    project = join(dir, 'project'),
    userHome = join(dir, 'user'),
    home = join(userHome, '.stroq'),
    dist = join(dir, 'dist');
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const path of [project, userHome, dist]) await mkdir(path, { mode: 0o700 });
  const cli = join(dist, 'index.js');
  await writeFile(cli, "import './chunk.js';", { mode: 0o600 });
  await writeFile(join(dist, 'chunk.js'), 'export const fixture=1;', { mode: 0o600 });
  const options = { project, userHome, home, cli, platform: 'darwin', mcpEnvironment: {} };
  const target = join(project, '.cursor', 'mcp.json'),
    userSource = join(userHome, '.cursor', 'mcp.json');
  const sentinel = join(dir, 'upstream-executed');
  const entry = (name = 'notes', client = 'cursor', env = { DECLARED_CONTEXT: 'fixture-one' }) =>
    strictProxyEntry(
      {
        command: process.execPath,
        args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(sentinel)},'bad')`],
        env,
      },
      name,
      client,
      {
        mode: 'strict',
        toolApproval: true,
        cwd: project,
        policyWorkspaceId: `workspace-${'a'.repeat(24)}`,
        runtime: {
          command: process.execPath,
          entry: cli,
          home,
          userHome,
          fingerprint: 'a'.repeat(64),
        },
      },
    ).entry;
  const save = async (file, value, name = 'notes') => {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, JSON.stringify({ mcpServers: { [name]: value } }), { mode: 0o600 });
  };
  const candidate = entry();
  await save(target, { command: '/old-unwrapped-entry' });
  return { dir, options, target, userSource, sentinel, entry, save, candidate };
}
test('Identical Cursor project/user opt-ins are refused despite opaque custom-field differences', async (t) => {
  const f = await fixture(t);
  await f.save(f.userSource, {
    ...f.candidate,
    custom: { label: 'different settings' },
    cwd: '/opaque-client-working-directory',
  });
  const before = await readFile(f.userSource);
  await assert.rejects(
    assertUniqueToolReviewBinding(f.options, f.candidate, f.target),
    /^Error: mcp-containment-unsupported$/,
  );
  assert.deepEqual(await readFile(f.userSource), before);
  await assert.rejects(access(f.sentinel));
  await assert.rejects(access(f.options.home));
});
test('Missing fixed sources and the target source itself do not create a duplicate or any store', async (t) => {
  const f = await fixture(t);
  await f.save(f.target, f.candidate);
  await assertUniqueToolReviewBinding(f.options, f.candidate, f.target);
  await assert.rejects(access(f.options.home));
  await assert.rejects(access(f.sentinel));
});
test('Distinct declared environment values and raw server identities are allowed', async (t) => {
  const f = await fixture(t);
  await f.save(f.userSource, f.entry('notes', 'cursor', { DECLARED_CONTEXT: 'fixture-two' }));
  await assertUniqueToolReviewBinding(f.options, f.candidate, f.target);
  await f.save(f.userSource, f.entry('notes-extra'), 'notes-extra');
  await assertUniqueToolReviewBinding(f.options, f.candidate, f.target);
});
test('Distinct actual client identity is allowed without conflating same-prefix server names', async (t) => {
  const f = await fixture(t);
  await f.save(join(f.options.project, '.mcp.json'), f.entry('notes', 'claude-code'));
  await assertUniqueToolReviewBinding(f.options, f.candidate, f.target);
  await f.save(f.userSource, f.entry('notes.other'), 'notes.other');
  await assertUniqueToolReviewBinding(f.options, f.candidate, f.target);
});
test('Unreadable malformed or linked supported sources fail closed without replacing content', async (t) => {
  const f = await fixture(t);
  await mkdir(dirname(f.userSource), { recursive: true, mode: 0o700 });
  await writeFile(f.userSource, '{broken-json', { mode: 0o600 });
  await assert.rejects(
    assertUniqueToolReviewBinding(f.options, f.candidate, f.target),
    /^Error: mcp-containment-unavailable$/,
  );
  assert.equal(await readFile(f.userSource, 'utf8'), '{broken-json');
  await rm(f.userSource);
  await symlink(f.target, f.userSource);
  await assert.rejects(
    assertUniqueToolReviewBinding(f.options, f.candidate, f.target),
    /^Error: mcp-containment-unavailable$/,
  );
  await assert.rejects(access(f.options.home));
});
test('Global128-entry and256KiB source limits refuse uniqueness rather than skip candidates', async (t) => {
  const f = await fixture(t);
  await mkdir(dirname(f.userSource), { recursive: true, mode: 0o700 });
  await writeFile(
    f.userSource,
    JSON.stringify({
      mcpServers: Object.fromEntries(
        Array.from({ length: 129 }, (_, i) => [`ordinary${i}`, { command: '/unused' }]),
      ),
    }),
    { mode: 0o600 },
  );
  await assert.rejects(
    assertUniqueToolReviewBinding(f.options, f.candidate, f.target),
    /^Error: mcp-containment-unavailable$/,
  );
  await writeFile(f.userSource, ' '.repeat(256 * 1024 + 1), { mode: 0o600 });
  await assert.rejects(
    assertUniqueToolReviewBinding(f.options, f.candidate, f.target),
    /^Error: mcp-containment-unavailable$/,
  );
});
test('A non-opted-in ordinary wrapper does not collide and no upstream is launched', async (t) => {
  const f = await fixture(t),
    ordinary = {
      ...f.candidate,
      args: f.candidate.args.filter((arg) => arg !== '--tool-approval'),
    };
  await f.save(f.userSource, ordinary);
  await assertUniqueToolReviewBinding(f.options, f.candidate, f.target);
  await assert.rejects(access(f.sentinel));
  await assert.rejects(access(f.options.home));
});
test('An opted-in source with undeclared pass-through values cannot establish uniqueness from ambient credentials', async (t) => {
  const f = await fixture(t),
    uncertain = { ...f.candidate, env: { ...f.candidate.env } };
  delete uncertain.env.DECLARED_CONTEXT;
  await f.save(f.userSource, uncertain);
  await assert.rejects(
    assertUniqueToolReviewBinding(f.options, f.candidate, f.target),
    /^Error: mcp-containment-unavailable$/,
  );
  await assert.rejects(access(f.options.home));
});
