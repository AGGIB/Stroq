import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  writeFile,
  rm,
  mkdir,
  readFile,
  access,
  rename,
  realpath,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { tsImport } from 'tsx/esm/api';
import { createPolicyCasesStore } from './policy-cases-store.mjs';
import { fileURLToPath } from 'node:url';
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const loader = await mkdtemp(join(tmpdir(), 'stroq-governance-service-loader-'));
after(() => rm(loader, { recursive: true, force: true }));
const tsconfig = join(loader, 'tsconfig.json');
await writeFile(
  tsconfig,
  JSON.stringify({
    compilerOptions: {
      baseUrl: repositoryRoot,
      paths: { '@stroq/core': ['packages/core/src/index.ts'] },
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
    },
  }),
);
const imported = (p) => tsImport(p, { parentURL: import.meta.url, tsconfig });
const { createMcpGovernanceService } = await imported('./mcp-governance-service.ts');
const policy = await imported('./mcp-governance-policy.ts');
const { captureMcpGovernanceSources } = await imported('./mcp-governance-capture.ts');
const boundary = await imported('../lib/mcp-governance.ts');
async function fixture(t, extra = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'stroq-governance-service-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project'),
    userHome = join(root, 'user'),
    home = join(userHome, '.stroq');
  await mkdir(project, { mode: 0o700 });
  await mkdir(userHome, { mode: 0o700 });
  await writeFile(
    join(project, '.mcp.json'),
    JSON.stringify({ mcpServers: { notes: { command: '/never-run-governance' } } }),
    { mode: 0o600 },
  );
  const caseStore = {
    capture: async () => ({ records: [], revision: null }),
    assertSnapshot: async () => {},
    withSnapshotLock: async (s, fn) => fn(s),
  };
  const adapter = async (op, text, changes, opts) => {
    if (op === 'mcp-governance-inspect') return policy.inspectMcpGovernancePolicy(text);
    if (op === 'mcp-governance-capture')
      return captureMcpGovernanceSources(changes.options, changes.allowed);
    if (op === 'mcp-governance-preview')
      return policy.previewMcpGovernancePolicy(text, changes, opts.cases, opts.caseRevision);
    throw Error('unknown-operation');
  };
  const options = {
    project,
    userHome,
    home,
    workspaceId: 'workspace-' + '1'.repeat(24),
    platform: 'darwin',
    mcpEnvironment: {},
    codexEnvironment: {},
    runtimeDigest: async () => 'a'.repeat(64),
    adapter,
    caseStore: extra.caseStoreFactory?.(home) ?? caseStore,
    ...extra,
  };
  const service = createMcpGovernanceService(options);
  t.after(() => service.close());
  return { root, project, userHome, home, options, service };
}
async function plan(f, select = true) {
  const c = await f.service.capture({});
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(boundary.validateMcpGovernanceCapture(c.body), true);
  const selected = select
    ? c.body.choices
        .filter((c) => c.eligibility === 'eligible')
        .map((c) => ({ id: c.id, expectedSha256: c.expectedSha256 }))
    : [];
  const p = await f.service.preview({
    captureId: c.body.captureId,
    binding: c.body.binding,
    selected,
  });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal(boundary.validateMcpGovernancePreview(p.body), true);
  return p.body;
}
const ack = (p) => ({
  previewId: p.id,
  operationId: p.operationId,
  contextId: p.binding.contextId,
  acknowledgeScope: true,
  acknowledgeRetention: true,
  acknowledgeWeakening: true,
  acknowledgeInterruptions: true,
  acknowledgeUnconfirmed: true,
});
test('first application uses the real saved-case store without mistaking own home creation for drift', async (t) => {
  const f = await fixture(t, { caseStoreFactory: (home) => createPolicyCasesStore({ home }) });
  const p = await plan(f),
    result = await f.service.apply(ack(p));
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.writeConfirmed, true);
  assert.equal((await f.service.read()).body.records[0].status, 'applied');
});
test('read and capture do not create state; actual preview/apply preserves policy and survives service restart', async (t) => {
  const f = await fixture(t);
  const state = await f.service.read();
  assert.equal(state.body.current.gate, 'absent');
  await assert.rejects(access(f.home));
  const p = await plan(f);
  await assert.rejects(access(f.home));
  assert.equal(p.gateChecks.passed, true);
  assert.deepEqual(p.blockers, []);
  const r = await f.service.apply(ack(p));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.writeConfirmed, true);
  assert.ok(r.body.record.historyRef);
  const saved = await readFile(join(f.home, 'policy.yaml'), 'utf8');
  assert.equal(policy.readGovernancePolicy(saved).version, 2);
  const restarted = createMcpGovernanceService(f.options);
  t.after(() => restarted.close());
  const s = await restarted.read();
  assert.equal(s.body.current.gate, 'enforced');
  assert.equal(s.body.records[0].status, 'applied');
  assert.equal((await f.service.apply(ack(p))).body.error, 'mcp-governance-preview-expired');
});
test('malformed consent consumes recognized preview; source drift refuses without writing policy', async (t) => {
  const f = await fixture(t),
    p = await plan(f);
  assert.equal(
    (await f.service.apply({ previewId: p.id })).body.error,
    'mcp-governance-consent-required',
  );
  assert.equal((await f.service.apply(ack(p))).body.error, 'mcp-governance-preview-expired');
  const q = await plan(f);
  await writeFile(join(f.project, '.mcp.json'), '{"mcpServers":{}}');
  assert.equal((await f.service.apply(ack(q))).body.error, 'mcp-governance-source-changed');
  await assert.rejects(access(join(f.home, 'policy.yaml')));
});
test('post-rename failure remains unknown; explicit exact Recheck proves physical publication', async (t) => {
  const f = await fixture(t, {
    fault: async (stage) => {
      if (stage === 'after-rename') throw Error('fixture-interruption');
    },
  });
  const p = await plan(f),
    r = await f.service.apply(ack(p));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.writeConfirmed, false);
  assert.equal(r.body.record.status, 'unknown');
  const s = await f.service.read();
  assert.equal(s.body.records[0].status, 'unknown');
  const row = s.body.records[0];
  const result = await f.service.recheck({
    contextId: row.binding.contextId,
    recordId: row.id,
    recordRevision: row.revision,
    operationId: row.operationId,
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.writeConfirmed, true);
});
test('equal bytes on a foreign inode do not settle an unknown publication', async (t) => {
  const f = await fixture(t, {
    fault: async (stage) => {
      if (stage === 'after-rename') throw Error('fixture-interruption');
    },
  });
  const p = await plan(f),
    r = await f.service.apply(ack(p)),
    row = r.body.record;
  const file = join(f.home, 'policy.yaml'),
    copy = join(f.home, 'foreign.yaml');
  await writeFile(copy, await readFile(file), { mode: 0o600 });
  await rename(copy, file);
  const result = await f.service.recheck({
    contextId: row.binding.contextId,
    recordId: row.id,
    recordRevision: row.revision,
    operationId: row.operationId,
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.record.status, 'unknown');
  assert.equal(result.body.writeConfirmed, false);
});

test('fresh independent change binds and acknowledges unknown history without settling it', async (t) => {
  let interrupt = true;
  const f = await fixture(t, {
    fault: async (stage) => {
      if (stage === 'after-rename' && interrupt) throw Error('fixture-interruption');
    },
  });
  const first = await plan(f),
    uncertain = await f.service.apply(ack(first));
  assert.equal(uncertain.body.record.status, 'unknown');
  interrupt = false;
  const next = await plan(f, false);
  assert.equal(next.requiresRecoveryReview, true);
  assert.deepEqual(
    next.unconfirmedRecords.map((r) => r.operationId),
    [first.operationId],
  );
  const incomplete = ack(next);
  delete incomplete.acknowledgeUnconfirmed;
  assert.equal((await f.service.apply(incomplete)).body.error, 'mcp-governance-consent-required');
  const reviewed = await plan(f, false),
    result = await f.service.apply(ack(reviewed));
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.writeConfirmed, true);
  const state = await f.service.read();
  assert.equal(
    state.body.records.find((r) => r.operationId === first.operationId).status,
    'unknown',
  );
  assert.equal(state.body.current.allowed.length, 0);
});

test('invalid policy and unknown browser authority refuse without altering files', async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.service.capture({ path: '/foreign' })).body.error,
    'mcp-governance-invalid',
  );
  const capture = await f.service.capture({});
  assert.equal(
    (
      await f.service.preview({
        captureId: capture.body.captureId,
        binding: capture.body.binding,
        selected: [{ id: 'choice-' + 'f'.repeat(64), expectedSha256: 'f'.repeat(64) }],
      })
    ).body.error,
    'mcp-governance-selection-unavailable',
  );
  await mkdir(f.home, { mode: 0o700 });
  const file = join(f.home, 'policy.yaml'),
    invalid = 'version: 1\nrules: []\nmisspelledGuard: true\n';
  await writeFile(file, invalid, { mode: 0o600 });
  assert.equal((await f.service.read()).body.editable, false);
  assert.equal((await f.service.capture({})).body.error, 'mcp-governance-unsupported');
  assert.equal(await readFile(file, 'utf8'), invalid);
});

test('same-console busy refusal consumes a recognized Apply preview', async (t) => {
  let block = false,
    release,
    entered;
  const admission = new Promise((resolve) => {
    entered = resolve;
  });
  const caseStore = {
    capture: async () => {
      if (block) {
        entered();
        await new Promise((resolve) => {
          release = resolve;
        });
      }
      return { records: [], revision: null };
    },
    assertSnapshot: async () => {},
    withSnapshotLock: async (s, fn) => fn(s),
  };
  const f = await fixture(t, { caseStore }),
    p = await plan(f);
  const c = (await f.service.capture({})).body;
  const selected = c.choices
    .filter((c) => c.eligibility === 'eligible')
    .map((c) => ({ id: c.id, expectedSha256: c.expectedSha256 }));
  block = true;
  const running = f.service.preview({ captureId: c.captureId, binding: c.binding, selected });
  await admission;
  const busy = await f.service.apply(ack(p));
  release();
  assert.equal((await running).status, 200);
  assert.equal(busy.body.error, 'mcp-governance-busy');
  assert.equal((await f.service.apply(ack(p))).body.error, 'mcp-governance-preview-expired');
});
