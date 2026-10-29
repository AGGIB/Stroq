import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { createMcpToolContractService } from './mcp-tool-contracts.mjs';
import { startServer } from './serve.mjs';

const loader = await mkdtemp(join(tmpdir(), 'stroq-contract-test-loader-'));
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
const engine = await imported('./mcp-tool-contract-engine.ts');
const schema = await imported('../lib/mcp-tool-contracts.ts');
const contracts = await imported('../../packages/cli/src/mcp/tool-contracts.ts');
const { strictProxyEntry } = await imported('./mcp-containment-proxy.ts');
const { parseMcpArgv } = await imported('../../packages/cli/src/commands/mcp.ts');
const value = {
  name: 'notes:read',
  description: 'Untrusted <script>throw Error("RUN")</script> https://untrusted.invalid/schema',
  inputSchema: { type: 'object' },
};
async function fixture(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'stroq-contract-service-'))),
    project = join(dir, 'project'),
    userHome = join(dir, 'user'),
    home = join(userHome, '.stroq'),
    dist = join(dir, 'dist');
  for (const path of [project, userHome, dist]) await mkdir(path, { mode: 0o700 });
  const cli = join(dist, 'index.js');
  await writeFile(cli, "import './chunk.js';", { mode: 0o600 });
  await writeFile(join(dist, 'chunk.js'), 'export const v=1;', { mode: 0o600 });
  const source = join(project, '.mcp.json'),
    sentinel = join(dir, 'server-was-started');
  const original = {
    command: process.execPath,
    args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(sentinel)},'bad')`],
    env: { DECLARED_CONTEXT: 'fixture-private-value' },
  };
  const wrapped = strictProxyEntry(original, 'notes', 'claude-code', {
    mode: 'strict',
    toolApproval: true,
    cwd: project,
    policyWorkspaceId: 'workspace-' + 'a'.repeat(24),
    runtime: { command: process.execPath, entry: cli, home, userHome, fingerprint: 'a'.repeat(64) },
  }).entry;
  const save = (entry) =>
    writeFile(source, JSON.stringify({ mcpServers: { notes: entry } }), { mode: 0o600 });
  await save(wrapped);
  const invocation = parseMcpArgv(wrapped.args.slice(2)).invocation;
  const binding = await contracts.createMcpToolContractBinding({
    home,
    cwd: project,
    client: invocation.client,
    server: invocation.server,
    command: invocation.command,
    args: invocation.args,
    passEnv: invocation.passEnv,
    strictMaxWithheld: invocation.strictMaxWithheld,
    runtimeEntry: cli,
    environment: wrapped.env,
    launch: { command: process.execPath, argv: wrapped.args },
  });
  const store = contracts.createMcpToolContractsStore({ home });
  let runtime = 'a'.repeat(64);
  const make = (extra) =>
    createMcpToolContractService({
      project,
      userHome,
      home,
      paths: { cli },
      platform: 'darwin',
      runtimeDigest: async () => runtime,
      loadEngine: async () => engine,
      loadSchema: async () => schema,
      ...extra,
    });
  const service = make(),
    services = [service],
    apps = [];
  t.after(async () => {
    for (const app of apps) await app.close();
    for (const s of services) await s.close();
    await rm(dir, { recursive: true, force: true });
  });
  return {
    dir,
    project,
    userHome,
    home,
    source,
    wrapped,
    binding,
    store,
    service,
    save,
    make(extra) {
      const s = make(extra);
      services.push(s);
      return s;
    },
    setRuntime(value) {
      runtime = value;
    },
    sentinel,
    async http() {
      const root = join(dir, 'out');
      await mkdir(root);
      await writeFile(join(root, 'index.html'), 'fixture');
      const app = await startServer({
        root,
        project,
        userHome,
        home,
        mcpToolContracts: service,
        port: 0,
      });
      apps.push(app);
      return app;
    },
  };
}
const target = (row, action = 'approve') => ({
  action,
  bindingId: row.bindingId,
  expectedRevision: row.revision,
  expectedCaptureSha256: row.captureSha256,
  toolId: row.tools[0].id,
  expectedContractSha256: row.tools[0].sha256,
});
const apply = (service, preview) =>
  service.apply({
    previewId: preview.id,
    confirm: true,
    acknowledgeContract: true,
    acknowledgeCallLimits: true,
  });

test('current opt-in queue is read only, no listing differs from complete empty and hostile metadata stays inert', async (t) => {
  const f = await fixture(t),
    before = await readFile(f.source);
  const none = await f.service.state();
  assert.equal(none.status, 200);
  assert(schema.validateMcpToolContractState(none.body));
  assert.equal(none.body.registrations[0].status, 'none');
  await assert.rejects(access(f.home));
  await f.store.observe(f.binding, { tools: [] });
  const empty = (await f.service.state()).body.registrations[0];
  assert.equal(empty.status, 'complete');
  assert.equal(empty.tools.length, 0);
  await f.store.observe(f.binding, { tools: [value] });
  const row = (await f.service.state()).body.registrations[0];
  assert.equal(row.tools[0].decision, 'pending');
  assert.equal(JSON.parse(row.tools[0].contract).description, value.description);
  assert(!JSON.stringify(row).includes('fixture-private-value'));
  assert.deepEqual(await readFile(f.source), before);
  await assert.rejects(access(f.sentinel));
});
test('an incomplete first listing is recorded without inventing a complete empty capture or decision', async (t) => {
  const f = await fixture(t);
  const initial = (await f.service.state()).body.registrations[0];
  assert.equal(initial.status, 'none');
  await f.store.invalidate(f.binding, 'listing-incomplete');
  const state = await f.service.state();
  assert.equal(state.status, 200);
  assert(schema.validateMcpToolContractState(state.body));
  const incomplete = state.body.registrations[0];
  assert.equal(incomplete.status, 'incomplete');
  assert.equal(incomplete.reason, 'listing-invalidated');
  assert.equal(incomplete.captureSha256, null);
  assert.deepEqual(incomplete.tools, []);
  assert.deepEqual(incomplete.history, []);
  await f.store.observe(f.binding, { tools: [] });
  const complete = (await f.service.state()).body.registrations[0];
  assert.equal(complete.status, 'complete');
  assert.notEqual(complete.captureSha256, null);
  assert.notEqual(complete.revision, incomplete.revision);
  assert.deepEqual(complete.tools, []);
  await assert.rejects(access(f.sentinel));
});
test('exact preview and independent acknowledgement approve then revoke actual store authority', async (t) => {
  const f = await fixture(t);
  await f.store.observe(f.binding, { tools: [value] });
  let row = (await f.service.state()).body.registrations[0];
  let calls = 0;
  assert.equal(
    await f.store.withApproved(f.binding, row.captureSha256, value.name, () => {
      calls++;
    }),
    false,
  );
  const prepared = await f.service.preview(target(row));
  assert.equal(prepared.status, 200);
  assert(schema.validateMcpToolContractPreview(prepared.body));
  assert.equal((await f.store.read(f.binding)).approvals.length, 0);
  assert.equal(
    (
      await f.service.apply({
        previewId: prepared.body.id,
        confirm: true,
        acknowledgeContract: true,
      })
    ).status,
    400,
  );
  const receipt = await apply(f.service, prepared.body);
  assert.equal(receipt.status, 200);
  assert(schema.validateMcpToolContractReceipt(receipt.body));
  assert.equal(receipt.body.hostEnforcement, false);
  assert.equal(
    await f.store.withApproved(f.binding, row.captureSha256, value.name, () => {
      calls++;
    }),
    true,
  );
  assert.equal(calls, 1);
  assert.equal((await f.service.preview(target(row))).status, 409);
  row = (await f.service.state()).body.registrations[0];
  assert.equal(row.tools[0].decision, 'approved');
  const revoke = await f.service.preview(target(row, 'revoke'));
  assert.equal(revoke.status, 200);
  assert.equal((await apply(f.service, revoke.body)).status, 200);
  assert.equal(
    await f.store.withApproved(f.binding, row.captureSha256, value.name, () => {
      calls++;
    }),
    false,
  );
  assert.equal(calls, 1);
  await assert.rejects(access(f.sentinel));
});
test('overlapping reads share one current source read without manufacturing an unavailable result', async (t) => {
  const f = await fixture(t);
  let release;
  let entered;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  let reads = 0;
  const service = f.make({
    loadEngine: async () => ({
      ...engine,
      async readMcpToolContractState(options) {
        reads++;
        entered();
        await waiting;
        return engine.readMcpToolContractState(options);
      },
    }),
  });
  const first = service.state();
  await started;
  const second = service.state();
  release();
  const results = await Promise.all([first, second]);
  assert.deepEqual(
    results.map((result) => result.status),
    [200, 200],
  );
  assert.equal(reads, 1);
  assert.deepEqual(results[0].body, results[1].body);
  assert(results.every((result) => schema.validateMcpToolContractState(result.body)));
  await service.state();
  assert.equal(reads, 2, 'completed reads are never cached as current');
});
test('comparison keeps approved A through pending B and C, then advances only on exact approval', async (t) => {
  const f = await fixture(t);
  await f.store.observe(f.binding, { tools: [value] });
  let row = (await f.service.state()).body.registrations[0];
  assert.equal(row.tools[0].comparison.status, 'first-seen');
  const a = row.tools[0];
  assert.equal((await apply(f.service, (await f.service.preview(target(row))).body)).status, 200);
  await f.store.observe(f.binding, { tools: [{ ...value, description: 'pending B' }] });
  row = (await f.service.state()).body.registrations[0];
  assert.equal(row.tools[0].comparison.status, 'changed');
  assert.equal(row.tools[0].previousApprovedContract, a.contract);
  assert.equal(row.tools[0].comparison.baselineSha256, a.sha256);
  assert.deepEqual(row.tools[0].comparison.counts, { added: 0, changed: 1, removed: 0 });
  const oldPreview = await f.service.preview(target(row));
  await f.store.observe(f.binding, {
    tools: [{ ...value, description: 'pending C', outputSchema: { type: 'object' } }],
  });
  row = (await f.service.state()).body.registrations[0];
  assert.equal(row.tools[0].previousApprovedContract, a.contract);
  assert.equal(row.tools[0].comparison.baselineSha256, a.sha256);
  assert.deepEqual(row.tools[0].comparison.changes, [
    { path: '/description', kind: 'changed' },
    { path: '/outputSchema', kind: 'added' },
  ]);
  assert.equal((await apply(f.service, oldPreview.body)).status, 409);
  const prepared = await f.service.preview(target(row));
  assert(schema.validateMcpToolContractPreview(prepared.body));
  assert.deepEqual(prepared.body.tool.comparison, row.tools[0].comparison);
  assert.equal(prepared.body.tool.previousApprovedContract, a.contract);
  assert.equal((await apply(f.service, prepared.body)).status, 200);
  row = (await f.service.state()).body.registrations[0];
  assert.equal(row.tools[0].comparison.status, 'unchanged');
  assert.equal(row.tools[0].previousApprovedContract, row.tools[0].contract);
  assert.equal(
    (await apply(f.service, (await f.service.preview(target(row, 'revoke'))).body)).status,
    200,
  );
  row = (await f.service.state()).body.registrations[0];
  assert.equal(row.tools[0].decision, 'revoked');
  assert.equal(row.tools[0].comparison.status, 'unchanged');
  await assert.rejects(access(f.sentinel));
});
test('a legacy unsigned approved record is no authority: it reads as no capture and is left as it is', async (t) => {
  const f = await fixture(t);
  await f.store.observe(f.binding, { tools: [value] });
  const row = (await f.service.state()).body.registrations[0];
  await apply(f.service, (await f.service.preview(target(row))).body);
  const file = join(f.home, 'store', 'mcp-contracts', f.binding.id + '.json');
  const stored = JSON.parse(await readFile(file, 'utf8'));
  delete stored.approvedBaselines;
  stored.schema = 'stroq-mcp-tool-contracts/1';
  const original = Buffer.from(JSON.stringify(stored) + '\n');
  await writeFile(file, original, { mode: 0o600 });
  // Records written before signing count as absent: no approval, no retained body, no comparison.
  const current = (await f.service.state()).body.registrations[0];
  assert.deepEqual(current.tools, []);
  assert.ok(!JSON.stringify(current).includes('"approved"'));
  assert.deepEqual(await readFile(file), original);
  await assert.rejects(access(f.sentinel));
});
test('changed capture, environment, runtime and restart fence a preview without retargeting it', async (t) => {
  const f = await fixture(t);
  await f.store.observe(f.binding, { tools: [value] });
  let row = (await f.service.state()).body.registrations[0];
  const old = await f.service.preview(target(row));
  await f.store.observe(f.binding, { tools: [{ ...value, description: 'changed' }] });
  assert.equal((await apply(f.service, old.body)).status, 409);
  row = (await f.service.state()).body.registrations[0];
  assert.equal(row.tools[0].decision, 'pending');
  const environment = await f.service.preview(target(row));
  await f.save({ ...f.wrapped, env: { ...f.wrapped.env, DECLARED_CONTEXT: 'other-account' } });
  assert.equal((await apply(f.service, environment.body)).status, 409);
  assert.equal((await f.service.state()).body.registrations[0].status, 'none');
  await f.save(f.wrapped);
  const runtime = await f.service.preview(target(row));
  f.setRuntime('b'.repeat(64));
  assert.equal((await apply(f.service, runtime.body)).status, 409);
  f.setRuntime('a'.repeat(64));
  const restart = await f.service.preview(target(row));
  assert.equal((await apply(f.make(), restart.body)).status, 409);
});
test('invalidated listing, damaged storage and unknown writes never become an approved empty queue', async (t) => {
  const f = await fixture(t);
  await f.store.observe(f.binding, { tools: [value] });
  const row = (await f.service.state()).body.registrations[0];
  await f.store.invalidate(f.binding, 'fixture');
  const invalid = (await f.service.state()).body.registrations[0];
  assert.equal(invalid.status, 'incomplete');
  assert.equal((await f.service.preview(target(invalid))).status, 409);
  const file = join(f.home, 'store', 'mcp-contracts', f.binding.id + '.json');
  await writeFile(file, '{"broken":true}', { mode: 0o600 });
  const broken = await f.service.state();
  assert.equal(broken.body.available, false);
  assert.equal(broken.body.reason, 'storage-unavailable');
  assert.deepEqual(broken.body.registrations, []);
  assert.equal(await readFile(file, 'utf8'), '{"broken":true}');
  assert.equal((await f.service.preview({ ...target(row), path: file })).status, 400);
});
test('authenticated HTTP boundary rejects duplicate selectors, queries and foreign origins before effects', async (t) => {
  const f = await fixture(t),
    app = await f.http(),
    origin = app.url.split('/#')[0];
  const request = async (path, body, extra = {}) => {
    const response = await fetch(origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${app.token}`,
        Origin: origin,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...extra,
      },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    return { status: response.status, body: parsed };
  };
  assert.equal(
    (await request('/api/mcp-tool-contracts', undefined, { Authorization: '' })).status,
    401,
  );
  assert.equal((await request('/api/mcp-tool-contracts')).status, 200);
  await f.store.observe(f.binding, { tools: [value] });
  const row = (await f.service.state()).body.registrations[0],
    input = target(row);
  assert.equal(
    (await request('/api/mcp-tool-contracts/preview', input, { Origin: 'https://foreign.invalid' }))
      .status,
    403,
  );
  assert.equal(
    (
      await request(
        '/api/mcp-tool-contracts/preview',
        JSON.stringify(input).replace('"action":"approve"', '"action":"revoke","action":"approve"'),
      )
    ).status,
    400,
  );
  assert.notEqual((await request('/api/mcp-tool-contracts?binding=' + row.bindingId)).status, 200);
  assert.equal((await f.store.read(f.binding)).approvals.length, 0);
  await assert.rejects(access(f.sentinel));
});

test('runtime drift after a real decision is explicitly unconfirmed and the preview cannot be replayed', async (t) => {
  const f = await fixture(t);
  await f.store.observe(f.binding, { tools: [value] });
  const row = (await f.service.state()).body.registrations[0];
  const service = f.make({
    loadEngine: async () => ({
      ...engine,
      async applyMcpToolContractDecision(...args) {
        const revision = await engine.applyMcpToolContractDecision(...args);
        f.setRuntime('c'.repeat(64));
        return revision;
      },
    }),
  });
  const preview = await service.preview(target(row));
  assert.equal(preview.status, 200);
  assert.equal((await apply(service, preview.body)).body.error, 'tool-contract-write-unconfirmed');
  assert.equal((await f.store.read(f.binding)).approvals[0].approved, true);
  assert.equal((await apply(service, preview.body)).status, 409);
});

test('runtime read failure after a real commit is an unconfirmed decision, never an unchanged-store error', async (t) => {
  const f = await fixture(t);
  await f.store.observe(f.binding, { tools: [value] });
  const row = (await f.service.state()).body.registrations[0];
  let committed = false;
  const service = f.make({
    runtimeDigest: async () => {
      if (committed) throw new Error('private-runtime-path');
      return 'a'.repeat(64);
    },
    loadEngine: async () => ({
      ...engine,
      async applyMcpToolContractDecision(...args) {
        const revision = await engine.applyMcpToolContractDecision(...args);
        committed = true;
        return revision;
      },
    }),
  });
  const preview = await service.preview(target(row));
  assert.equal(preview.status, 200);
  const result = await apply(service, preview.body);
  assert.equal(result.status, 422);
  assert.equal(result.body.error, 'tool-contract-write-unconfirmed');
  assert.equal((await f.store.read(f.binding)).approvals[0].approved, true);
  assert(!JSON.stringify(result).includes('private-runtime-path'));
});

test('the staged decision rechecks registration and preview expiry immediately before publication', async (t) => {
  const f = await fixture(t);
  await f.store.observe(f.binding, { tools: [value] });
  const row = (await f.service.state()).body.registrations[0];
  let reads = 0,
    clock = Date.now(),
    change = 'registration';
  const service = f.make({
    now: () => clock,
    runtimeDigest: async () => {
      if (++reads === 5) {
        if (change === 'registration')
          await f.save({ ...f.wrapped, args: [...f.wrapped.args, 'outside-edit'] });
        else clock += 120001;
      }
      return 'a'.repeat(64);
    },
  });
  const before = await f.store.read(f.binding),
    preview = await service.preview(target(row));
  assert.equal(preview.status, 200);
  assert.equal((await apply(service, preview.body)).status, 409);
  assert.equal((await f.store.read(f.binding)).revision, before.revision);
  assert.equal((await f.store.read(f.binding)).approvals.length, 0);
  await f.save(f.wrapped);
  reads = 0;
  change = 'expiry';
  const expired = await service.preview(target(row));
  assert.equal(expired.status, 200);
  assert.equal((await apply(service, expired.body)).status, 409);
  assert.equal((await f.store.read(f.binding)).revision, before.revision);
});

test('remote discriminator changes cannot present a current local proxy binding', async (t) => {
  const f = await fixture(t);
  await f.store.observe(f.binding, { tools: [value] });
  for (const extra of [
    { url: 'https://fixture.invalid/mcp' },
    { serverUrl: null },
    { type: 'http' },
    { transport: 'sse' },
  ]) {
    await f.save({ ...f.wrapped, ...extra });
    const result = await f.service.state();
    assert.equal(result.status, 200);
    assert.equal(result.body.available, false);
    assert.equal(result.body.reason, 'context-unavailable');
    assert.deepEqual(result.body.registrations, []);
  }
  await f.save(f.wrapped);
  assert.equal((await f.service.state()).body.available, true);
});

test('closing during a delayed preview cannot issue a usable plan after close', async (t) => {
  const f = await fixture(t);
  await f.store.observe(f.binding, { tools: [value] });
  const row = (await f.service.state()).body.registrations[0];
  let entered, release;
  const started = new Promise((resolve) => {
      entered = resolve;
    }),
    hold = new Promise((resolve) => {
      release = resolve;
    });
  const service = f.make({
    loadEngine: async () => ({
      ...engine,
      async prepareMcpToolContractDecision(...args) {
        const selected = await engine.prepareMcpToolContractDecision(...args);
        entered();
        await hold;
        return selected;
      },
    }),
  });
  const pending = service.preview(target(row));
  await started;
  const closed = service.close();
  release();
  assert.equal((await pending).status, 503);
  await closed;
  assert.equal((await f.store.read(f.binding)).approvals.length, 0);
});
