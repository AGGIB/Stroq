import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { before, after, test } from 'node:test';
import {
  access,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'tsup';
import { createInventory } from './inventory.mjs';

let directory, api;
const consoleRoot = dirname(dirname(fileURLToPath(import.meta.url)));
before(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'stroq-mcp-sources-bundle-')));
  await build({
    entry: {
      sources: join(consoleRoot, 'scripts/mcp-sources.ts'),
      'inventory-worker': join(consoleRoot, 'scripts/inventory-worker.ts'),
    },
    outDir: directory,
    format: ['esm'],
    platform: 'node',
    target: 'node22',
    splitting: false,
    dts: false,
    config: false,
    silent: true,
    noExternal: ['@stroq/core', 'yaml', 'zod'],
    banner: {
      js: "import { createRequire as createEngineRequire } from 'node:module'; const require = createEngineRequire(import.meta.url);",
    },
    esbuildOptions(options) {
      options.alias = { '@stroq/core': resolve(consoleRoot, '../packages/core/src/index.ts') };
    },
  });
  api = await import(pathToFileURL(join(directory, 'sources.js')).href);
});
after(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function fixture(t, platform = 'darwin') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'stroq-mcp-source-')));
  const project = join(root, 'project'),
    userHome = join(root, 'profile');
  await mkdir(project);
  await mkdir(userHome);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, project, userHome, platform, environment: {} };
}
async function put(file, bytes) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, bytes);
}
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const server = {
  command: 'not-executed',
  env: { PRIVATE_TOKEN: 'SECRET_SENTINEL' },
  unknown: { keep: true },
};

test('discovery uses only passed roots and distinguishes current and legacy sources', async (t) => {
  const f = await fixture(t);
  const sources = await api.discoverMcpSources(f);
  assert.equal(sources.length, 6);
  assert.ok(
    sources.every(
      (source) =>
        source.file.startsWith(f.project + sep) || source.file.startsWith(f.userHome + sep),
    ),
  );
  const desktop = sources.find((source) => source.source === 'claude-desktop-manual');
  assert.equal(
    desktop.file,
    join(f.userHome, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
  );
  assert.equal(desktop.applicability, 'supported');
  assert.equal(
    sources.find((source) => source.source === 'devin-cascade-current').applicability,
    'client-unverified',
  );
  assert.equal(
    sources.find((source) => source.source === 'windsurf-legacy').applicability,
    'legacy-unverified',
  );
  await assert.rejects(access(join(f.userHome, '.stroq')));
});

test('explicit platform and environment select bounded locations without ambient-home fallbacks', async (t) => {
  const f = await fixture(t, 'linux');
  const xdg = join(f.userHome, 'custom-config');
  const sources = await api.discoverMcpSources({ ...f, environment: { XDG_CONFIG_HOME: xdg } });
  assert.equal(
    sources.find((source) => source.source === 'devin-cascade-current').file,
    join(xdg, 'devin', 'mcp_config.json'),
  );
  assert.equal(
    sources.find((source) => source.source === 'claude-desktop-manual').applicability,
    'client-unverified',
  );
  const rejected = await api.discoverMcpSources({ ...f, environment: { XDG_CONFIG_HOME: f.root } });
  const current = rejected.find((source) => source.source === 'devin-cascade-current');
  assert.equal(current.applicability, 'configuration-unavailable');
  assert.ok(
    rejected.some(
      (source) => source.source === 'claude-code-project' && source.applicability === 'supported',
    ),
  );
  assert.ok(
    rejected.some(
      (source) => source.source === 'cursor-user' && source.applicability === 'supported',
    ),
  );
  await put(current.file, JSON.stringify({ mcpServers: { mustNotReadDefault: server } }));
  await assert.rejects(api.readMcpSource(current), /mcp-source-unsafe/);
});

test('legacy preference and old inventory IDs stay compatible while current sources are distinct', async (t) => {
  const f = await fixture(t);
  const old = (await api.discoverMcpSources(f)).find(
    (source) => source.source === 'windsurf-legacy',
  );
  const expected = 'item-' + digest('mcp\0windsurf\0user\0database').slice(0, 24);
  assert.equal(api.mcpArtifactId(old, 'database'), expected);
  await put(join(f.userHome, '.codeium', 'windsurf', 'mcp_config.json'), '{}');
  const sources = await api.discoverMcpSources(f);
  const ide = sources.find((source) => source.source === 'windsurf-legacy-ide');
  assert.equal(api.mcpArtifactId(ide, 'database'), expected);
  assert.equal(
    sources.some((source) => source.source === 'windsurf-legacy'),
    false,
  );
  assert.notEqual(
    api.mcpArtifactId(
      sources.find((source) => source.source === 'devin-cascade-current'),
      'database',
    ),
    expected,
  );
});

test('a workspace alias of the user home exposes one Cursor source with its full user scope', async (t) => {
  const f = await fixture(t);
  const alias = join(f.root, 'profile-alias');
  await symlink(f.userHome, alias, process.platform === 'win32' ? 'junction' : 'dir');
  for (const project of [f.userHome, alias]) {
    const sources = await api.discoverMcpSources({ ...f, project });
    assert.equal(sources.filter((source) => source.agent === 'cursor').length, 1);
    const cursor = sources.find((source) => source.agent === 'cursor');
    assert.equal(cursor.scope, 'user');
    assert.equal(cursor.source, 'cursor-user');
    assert.equal(cursor.file, join(f.userHome, '.cursor', 'mcp.json'));
    assert.equal(
      api.mcpArtifactId(cursor, 'database'),
      'item-' + digest('mcp\0cursor\0user\0database').slice(0, 24),
    );
    assert.equal(new Set(sources.map((source) => source.file)).size, sources.length);
  }
});

test('capture preserves raw BOM and layout, unknown fields and prototype-shaped own keys', async (t) => {
  const f = await fixture(t);
  const raw = Buffer.from(
    '\uFEFF{\r\n\t"mcpServers": {"__proto__": {"command":"not-executed", "unknown":{"constructor":true}}},\r\n\t"other": {"keep":true}\r\n}',
  );
  await put(join(f.project, '.mcp.json'), raw);
  const source = (await api.discoverMcpSources(f)).find(
    (source) => source.source === 'claude-code-project',
  );
  const captured = await api.readMcpSource(source);
  assert.deepEqual(captured.bytes, raw);
  assert.equal(captured.fileSha256, digest(raw));
  assert.equal(captured.layout.bom, true);
  assert.equal(captured.layout.eol, '\r\n');
  assert.equal(captured.layout.finalNewline, false);
  assert.equal(Object.hasOwn(captured.doc.mcpServers, '__proto__'), true);
  assert.equal(captured.doc.other.keep, true);
  assert.equal(captured.fileIdentity.ino > 0, true);
});

test('capture refuses duplicate/lossy/JSONC/invalid UTF-8 data without parser text disclosure', async (t) => {
  const f = await fixture(t);
  const source = (await api.discoverMcpSources(f)).find(
    (source) => source.source === 'claude-code-project',
  );
  for (const raw of [
    '{"mcpServers":{},"PRIVATE":"SECRET_SENTINEL","PRIVATE":2}',
    '{"mcpServers":{"database":{},"data\\u0062ase":{}}}',
    '{"mcpServers":{},"n":9007199254740993}',
    '{"mcpServers":{},"n":-0}',
    '{"mcpServers":{},}',
    Buffer.from([0xff, 0xfe]),
  ]) {
    await put(source.file, raw);
    await assert.rejects(
      api.readMcpSource(source),
      (error) => error.message === 'mcp-source-invalid',
    );
  }
});

test('capture refuses links, hardlinks, oversized files and replaced roots', async (t) => {
  const f = await fixture(t);
  const source = (await api.discoverMcpSources(f)).find(
    (source) => source.source === 'claude-code-project',
  );
  await put(join(f.root, 'outside.json'), '{}');
  await symlink(join(f.root, 'outside.json'), source.file);
  await assert.rejects(api.readMcpSource(source), /mcp-source-unsafe/);
  await rm(source.file);
  await link(join(f.root, 'outside.json'), source.file);
  await assert.rejects(api.readMcpSource(source), /mcp-source-unsafe/);
  await rm(source.file);
  await writeFile(source.file, Buffer.alloc(256 * 1024 + 1, 0x20));
  await assert.rejects(api.readMcpSource(source), /mcp-source-limit/);
  await rename(f.project, join(f.root, 'previous-project'));
  await mkdir(f.project);
  await writeFile(source.file, '{}');
  await assert.rejects(api.readMcpSource(source), /mcp-source-conflict/);
});

test('resolution binds exact entry SHA and server-selected source, keeping secrets private in artifact metadata', async (t) => {
  const f = await fixture(t);
  await put(
    join(f.project, '.mcp.json'),
    JSON.stringify({ mcpServers: { PRIVATE_TOKEN: server } }),
  );
  const source = (await api.discoverMcpSources(f)).find(
    (source) => source.source === 'claude-code-project',
  );
  const id = api.mcpArtifactId(source, 'PRIVATE_TOKEN');
  const expectedSha256 = api.mcpEntryMetadata(server).sha256;
  const selected = await api.resolveMcpArtifactById({ ...f, id, expectedSha256 });
  assert.equal(selected.file, source.file);
  assert.equal(selected.name, 'PRIVATE_TOKEN');
  assert.equal(selected.entrySha256, expectedSha256);
  assert.deepEqual(selected.entry, server);
  assert.ok(!JSON.stringify(selected.artifact).includes('PRIVATE_TOKEN'));
  assert.ok(!JSON.stringify(selected.artifact).includes('SECRET_SENTINEL'));
  assert.equal(selected.artifact.id, id);
  await assert.rejects(
    api.resolveMcpArtifactById({ ...f, id, expectedSha256: '0'.repeat(64) }),
    /mcp-source-conflict/,
  );
  await assert.rejects(
    api.resolveMcpArtifactById({ ...f, id: '../private', expectedSha256 }),
    /mcp-source-conflict/,
  );
  assert.equal(
    await readFile(source.file, 'utf8'),
    JSON.stringify({ mcpServers: { PRIVATE_TOKEN: server } }),
  );
});

test('inventory and exact evidence share passed-profile sources and distinct current versus legacy identities', async (t) => {
  const f = await fixture(t, process.platform);
  const sources = await api.discoverMcpSources(f);
  for (const type of ['cursor-user', 'windsurf-legacy', 'devin-cascade-current']) {
    const source = sources.find((item) => item.source === type);
    await put(
      source.file,
      JSON.stringify({
        mcpServers: { [type === 'devin-cascade-current' ? 'PRIVATE_TOKEN' : 'database']: server },
      }),
    );
  }
  const inventory = createInventory({
    project: f.project,
    userHome: f.userHome,
    home: join(f.userHome, '.stroq'),
    workerPath: join(directory, 'inventory-worker.js'),
  });
  t.after(() => inventory.close());
  const result = await inventory.read();
  assert.equal(result.status, 200);
  assert.equal(result.body.items.length, 3);
  assert.equal(new Set(result.body.items.map((item) => item.id)).size, 3);
  assert.ok(result.body.items.some((item) => item.agent === 'cursor' && item.scope === 'user'));
  const expected = api.mcpEntryMetadata(server).sha256;
  for (const item of result.body.items) {
    assert.equal(item.sha256, expected);
    const inspected = await inventory.inspect({ id: item.id, expectedSha256: item.sha256 });
    assert.equal(inspected.status, 200);
    assert.equal(inspected.body.artifact.id, item.id);
    assert.equal(inspected.body.artifact.name, item.name);
    assert.ok(!JSON.stringify(inspected.body).includes('SECRET_SENTINEL'));
    assert.ok(!JSON.stringify(inspected.body).includes(f.root));
  }
  await assert.rejects(access(join(f.userHome, '.stroq')));
});

test('inventory refuses duplicate-key source documents and does not offer their collapsed entries for review', async (t) => {
  const f = await fixture(t, process.platform);
  await put(
    join(f.project, '.mcp.json'),
    '{"mcpServers":{"database":{"command":"not-executed"}},"other":"SECRET_SENTINEL","other":2}',
  );
  const inventory = createInventory({
    project: f.project,
    userHome: f.userHome,
    home: join(f.userHome, '.stroq'),
    workerPath: join(directory, 'inventory-worker.js'),
  });
  t.after(() => inventory.close());
  const result = await inventory.read();
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.items, []);
  assert.ok(
    result.body.gaps.some((gap) => gap.agent === 'claude-code' && gap.code === 'invalid-config'),
  );
  assert.ok(!JSON.stringify(result.body).includes('SECRET_SENTINEL'));
  await assert.rejects(access(join(f.userHome, '.stroq')));
});

test('inventory and inspect honor passed XDG selection while rejected locations leave other agents available', async (t) => {
  const f = await fixture(t, process.platform);
  const xdg = join(f.userHome, 'selected-config');
  const mcpEnvironment = process.platform === 'win32' ? { APPDATA: xdg } : { XDG_CONFIG_HOME: xdg };
  const invalidEnvironment =
    process.platform === 'win32' ? { APPDATA: f.root } : { XDG_CONFIG_HOME: f.root };
  await put(
    join(f.project, '.mcp.json'),
    JSON.stringify({ mcpServers: { projectServer: server } }),
  );
  await put(
    join(f.userHome, '.cursor', 'mcp.json'),
    JSON.stringify({ mcpServers: { cursorServer: server } }),
  );
  await put(
    (await api.discoverMcpSources(f)).find((source) => source.source === 'devin-cascade-current')
      .file,
    JSON.stringify({ mcpServers: { mustNotReadDefault: server } }),
  );
  await put(
    join(xdg, 'devin', 'mcp_config.json'),
    JSON.stringify({ mcpServers: { selectedCurrent: server } }),
  );
  const options = {
    project: f.project,
    userHome: f.userHome,
    home: join(f.userHome, '.stroq'),
    workerPath: join(directory, 'inventory-worker.js'),
  };
  const inventory = createInventory({ ...options, mcpEnvironment });
  const rejected = createInventory({ ...options, mcpEnvironment: invalidEnvironment });
  t.after(async () => {
    await inventory.close();
    await rejected.close();
  });
  const current = await inventory.read();
  assert.equal(current.status, 200);
  assert.equal(
    current.body.items.some((item) => item.name === 'mustNotReadDefault'),
    false,
  );
  const selected = current.body.items.find((item) => item.name === 'selectedCurrent');
  assert.ok(selected);
  const inspected = await inventory.inspect({ id: selected.id, expectedSha256: selected.sha256 });
  assert.equal(inspected.status, 200);
  assert.equal(
    inspected.body.files[0].sha256,
    digest(await readFile(join(xdg, 'devin', 'mcp_config.json'))),
  );
  const limited = await rejected.read();
  assert.equal(limited.status, 200);
  assert.equal(limited.body.items.length, 2);
  assert.ok(limited.body.items.some((item) => item.agent === 'claude-code'));
  assert.ok(limited.body.items.some((item) => item.agent === 'cursor'));
  assert.ok(
    limited.body.gaps.some((gap) => gap.agent === 'windsurf' && gap.code === 'path-refused'),
  );
  assert.ok(!JSON.stringify(limited.body).includes(f.root));
});

test('rejected Windows app data is source-specific and never yields an outside-profile file', async (t) => {
  const f = await fixture(t, 'win32');
  const sources = await api.discoverMcpSources({ ...f, environment: { APPDATA: f.root } });
  assert.equal(
    sources.find((item) => item.source === 'claude-desktop-manual').applicability,
    'configuration-unavailable',
  );
  assert.equal(
    sources.find((item) => item.source === 'devin-cascade-current').applicability,
    'configuration-unavailable',
  );
  assert.ok(
    sources.every(
      (item) => item.file.startsWith(f.userHome + sep) || item.file.startsWith(f.project + sep),
    ),
  );
  assert.ok(sources.some((item) => item.source === 'cursor-project'));
});
