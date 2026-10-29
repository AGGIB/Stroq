import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'tsup';
import { startServer } from './serve.mjs';

const consoleRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const supported = process.platform === 'darwin' || process.platform === 'linux';
const PRIVATE = 'RAW_CREDENTIAL_QUEUE_SENTINEL';
let compiled, queue, navigation;

before(async () => {
  compiled = await realpath(await mkdtemp(join(tmpdir(), 'stroq-filter-queue-code-')));
  await build({
    entry: {
      queue: join(consoleRoot, 'lib/credential-filter-queue.ts'),
      navigation: join(consoleRoot, 'lib/credential-filter-navigation.ts'),
    },
    outDir: compiled,
    format: ['esm'],
    platform: 'node',
    target: 'node22',
    splitting: false,
    dts: false,
    config: false,
    silent: true,
  });
  queue = await import(pathToFileURL(join(compiled, 'queue.js')).href);
  navigation = await import(pathToFileURL(join(compiled, 'navigation.js')).href);
});
after(async () => {
  if (compiled) await rm(compiled, { recursive: true, force: true });
});

async function fixture(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'stroq-filter-queue-http-')));
  const project = join(dir, 'workspace'),
    userHome = join(dir, 'profile'),
    home = join(userHome, '.stroq'),
    root = join(dir, 'out');
  await Promise.all([project, userHome, root].map((path) => mkdir(path, { mode: 0o700 })));
  await writeFile(join(root, 'index.html'), 'queue journey fixture');
  const apps = [];
  const schema = await import('../.local-engine/local-api-schema.js');
  async function server(workspace = project) {
    const app = await startServer({ root, project: workspace, userHome, home, port: 0 });
    apps.push(app);
    const origin = new URL(app.url).origin;
    async function request(path, body) {
      const response = await fetch(origin + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Authorization: 'Bearer ' + app.token,
          Origin: origin,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    }
    async function state() {
      const result = await request('/api/credential-filters');
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(schema.validateCredentialFilters(result.body), true);
      return result.body;
    }
    async function apply(target) {
      const preview = await request('/api/credential-filters/preview', {
        action: 'apply-filter',
        target,
      });
      assert.equal(preview.status, 200, JSON.stringify(preview.body));
      assert.equal(schema.validateCredentialFilterPreview(preview.body), true);
      const result = await request('/api/credential-filters/apply', {
        previewId: preview.body.id,
        confirm: true,
        acknowledgeNativeLimits: true,
        acknowledgePrivateRetention: true,
        ...Object.fromEntries(
          Object.entries(preview.body.needs)
            .filter(([, needed]) => needed)
            .map(([name]) => [name, true]),
        ),
      });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(schema.validateCredentialFilterReceipt(result.body), true);
      return result.body;
    }
    return { state, apply };
  }
  t.after(async () => {
    for (const app of apps) await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, project, userHome, home, server, app: await server() };
}

function rows(state, workspaceId = state.workspaceId) {
  return queue.credentialFilterRows(state, workspaceId);
}
function assertPrivate(result, fixture) {
  const text = JSON.stringify(result);
  for (const raw of [fixture.dir, fixture.project, fixture.userHome, fixture.home, PRIVATE])
    assert.equal(text.includes(raw), false, 'queue must not contain private paths or source text');
  assert.doesNotMatch(
    text,
    /removed after|since (?:the )?(?:last )?(?:successful|completed) apply|were removed|was removed|secrets? exposed/i,
  );
}
function assertGap(row) {
  assert.equal(row.tone, 'orange');
  assert.doesNotMatch(row.title + ' ' + row.detail, /\b\d+\s*(?:\/|of)\s*(?:13|2)\b/);
}

test(
  'actual HTTP queue is quiet for optional absence, detects incomplete recorded setup, and clears after reviewed reapply',
  { skip: !supported },
  async (t) => {
    const f = await fixture(t);
    const absent = await f.app.state();
    assert.deepEqual(rows(absent), []);
    await assert.rejects(access(f.home));
    await f.app.apply('claude-project');
    const configured = await f.app.state();
    assert.deepEqual(rows(configured), []);
    const file = join(f.project, '.claude', 'settings.local.json');
    const document = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(document.permissions.deny.length, 13);
    document.permissions.deny.shift();
    document.ownerPrivate = PRIVATE;
    await writeFile(file, JSON.stringify(document));
    const changed = await f.app.state();
    const target = changed.targets.find((row) => row.id === 'claude-project');
    assert.equal(target.status, 'partial');
    assert.equal(target.present, 12);
    assert.equal(target.applications, 1);
    const evidence = rows(changed);
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0].key, 'credential-filter-claude-project');
    assert.equal(evidence[0].tone, 'orange');
    assert.match(evidence[0].title, /recorded.*(?:setup|filter).*incomplete/i);
    assert.equal(
      evidence[0].href,
      navigation.credentialFilterHref('claude-project', changed.workspaceId),
    );
    assert.equal(
      evidence[0].href,
      `/agents/?workspace=${changed.workspaceId}&filter=claude-project#claude-code`,
    );
    assertPrivate(evidence, f);
    await f.app.apply('claude-project');
    const reapplied = await f.app.state();
    assert.equal(reapplied.targets.find((row) => row.id === 'claude-project').applications, 2);
    assert.deepEqual(rows(reapplied), []);
  },
);

test(
  'actual HTTP user history stays user-wide when read from another selected workspace',
  { skip: !supported },
  async (t) => {
    const f = await fixture(t);
    await f.app.apply('claude-user');
    const first = await f.app.state();
    assert.deepEqual(rows(first), []);
    const file = join(f.userHome, '.claude', 'settings.json');
    const document = JSON.parse(await readFile(file, 'utf8'));
    document.permissions.deny.pop();
    document.private = PRIVATE;
    await writeFile(file, JSON.stringify(document));
    const secondProject = join(f.dir, 'second-workspace');
    await mkdir(secondProject, { mode: 0o700 });
    const other = await f.server(secondProject);
    const state = await other.state();
    assert.notEqual(state.workspaceId, first.workspaceId);
    const target = state.targets.find((row) => row.id === 'claude-user');
    assert.equal(target.scope, 'user');
    assert.equal(target.context, 'all-workspaces');
    assert.equal(target.applications, 1);
    const evidence = rows(state);
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0].key, 'credential-filter-claude-user');
    assert.match(evidence[0].title + ' ' + evidence[0].detail, /user|all.workspaces/i);
    assert.equal(
      evidence[0].href,
      `/agents/?workspace=${state.workspaceId}&filter=claude-user#claude-code`,
    );
    assertPrivate(evidence, f);
    const foreign = rows(state, first.workspaceId);
    assert.equal(foreign.length, 1);
    assert.equal(foreign[0].key, 'credential-filters-unavailable');
    assertGap(foreign[0]);
    assertPrivate(foreign, f);
  },
);

test(
  'actual HTTP malformed source creates a review gap without claiming zero fixed rules',
  { skip: !supported },
  async (t) => {
    const f = await fixture(t);
    await mkdir(join(f.project, '.claude'), { mode: 0o700 });
    await writeFile(
      join(f.project, '.claude', 'settings.local.json'),
      JSON.stringify({
        permissions: 42,
        private: PRIVATE,
      }),
    );
    const state = await f.app.state();
    const target = state.targets.find((row) => row.id === 'claude-project');
    assert.equal(target.status, 'unavailable');
    assert.equal(target.reason, 'credential-filter-source-invalid');
    const evidence = rows(state);
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0].key, 'credential-filter-claude-project');
    assertGap(evidence[0]);
    assertPrivate(evidence, f);
    await assert.rejects(access(f.home));
  },
);

test(
  'actual HTTP untrusted recovery history creates gaps without exposing source or ledger paths',
  { skip: !supported },
  async (t) => {
    const f = await fixture(t);
    await f.app.apply('claude-project');
    const manifest = join(f.home, 'harden', 'manifest.json');
    await writeFile(manifest, `{"version":1,"files":{},"files":{"${PRIVATE}":[]}}`, {
      mode: 0o600,
    });
    const state = await f.app.state();
    const target = state.targets.find((row) => row.id === 'claude-project');
    assert.equal(target.status, 'configured');
    assert.equal(target.applications, null);
    assert.equal(target.managed, null);
    assert.equal(target.reason, 'credential-filter-storage-unavailable');
    const evidence = rows(state);
    assert.ok(evidence.some((row) => row.key === 'credential-filter-claude-project'));
    for (const row of evidence) assertGap(row);
    assertPrivate(evidence, f);
  },
);
