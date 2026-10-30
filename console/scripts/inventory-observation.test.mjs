import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'tsup';
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = await realpath(await mkdtemp(join(tmpdir(), 'stroq-observation-test-')));
after(() => rm(output, { recursive: true, force: true }));
await build({
  entry: { projection: join(repository, 'console/scripts/inventory-observation.ts') },
  outDir: output,
  outExtension: () => ({ js: '.mjs' }),
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  splitting: false,
  config: false,
  dts: false,
  silent: true,
});
const api = await import(pathToFileURL(join(output, 'projection.mjs')).href);
const sources = [
  'claude-skills',
  'agents-skills',
  'codex-skills',
  'cursor-skills',
  'windsurf-skills',
  'devin-skills',
];
const item = (n = 1, overrides = {}) => ({
  id: `item-${String(n).padStart(24, 'a')}`,
  kind: 'skill',
  name: `Skill ${n}`,
  agent: 'claude-code',
  skillSource: 'claude-skills',
  scope: 'project',
  fileType: 'skill-tree',
  sha256: String(n % 10).repeat(64),
  reviewedSha256: null,
  state: 'unreviewed',
  scan: { status: 'clean', findings: 0 },
  capabilities: [],
  ...overrides,
});
const snapshot = (items = [item()], overrides = {}) => ({
  schema: 'stroq-inventory/1',
  source: 'local',
  generatedAt: '2026-10-24T00:00:00.000Z',
  workspace: { id: `workspace-${'a'.repeat(24)}`, label: 'Fixture' },
  baseline: { status: 'missing', reviewedAt: null },
  items,
  gaps: [],
  limitations: [],
  skillSources: sources.flatMap((id) =>
    ['project', 'user'].map((scope) => ({ id, scope, status: 'complete', candidates: 0 })),
  ),
  ...overrides,
});
const compare = (before, after) =>
  api.compareObservations(api.projectInventory(before), api.projectInventory(after));
test('semantic projection excludes review, decisions, advisories and baseline-only null hashes', () => {
  const before = snapshot();
  const reviewed = snapshot(
    [
      item(1, {
        reviewedSha256: '1'.repeat(64),
        state: 'unchanged',
        quarantineSupported: false,
        quarantineReason: 'managed-source',
      }),
      item(2, {
        sha256: null,
        reviewedSha256: '2'.repeat(64),
        state: 'missing',
        scan: { status: 'not-scanned', findings: 0 },
      }),
    ],
    {
      generatedAt: '2026-10-24T01:00:00.000Z',
      baseline: { status: 'ready', reviewedAt: '2026-10-24T00:00:00.000Z' },
      signalDecisions: { status: 'unavailable' },
    },
  );
  assert.deepEqual(api.projectInventory(before), api.projectInventory(reviewed));
});
test('projection is order independent and retains safe scan, source coverage and capabilities', () => {
  const a = snapshot([item(2), item(1)]);
  const b = snapshot([item(1), item(2)], { skillSources: [...a.skillSources].reverse() });
  assert.deepEqual(api.projectInventory(a), api.projectInventory(b));
  assert.notDeepEqual(
    api.projectInventory(a),
    api.projectInventory(
      snapshot([item(1, { capabilities: [{ kind: 'exec', count: 1 }] }), item(2)]),
    ),
  );
});
test('partial source permits two reliable hashes to establish change but not absence or addition', () => {
  const before = snapshot([item(1), item(2)]);
  const after = snapshot([item(1, { sha256: 'f'.repeat(64) }), item(3)], {
    gaps: [
      {
        code: 'unreadable',
        agent: 'claude-code',
        scope: 'project',
        kind: 'skill',
        skillSource: 'claude-skills',
      },
    ],
  });
  const result = compare(before, after);
  assert.deepEqual(
    result.rows.map((r) => r.kind),
    ['changed', 'unverifiable', 'observed'],
  );
  assert.equal(result.status, 'partial');
});
test('one partial skill source does not suppress complete source removal', () => {
  const a = item(1, { agent: 'cursor', skillSource: 'cursor-skills' });
  const after = snapshot([], {
    gaps: [
      {
        code: 'unreadable',
        agent: 'claude-code',
        scope: 'project',
        kind: 'skill',
        skillSource: 'claude-skills',
      },
    ],
  });
  assert.equal(compare(snapshot([a]), after).rows[0].kind, 'removed');
});
test('MCP gaps conservatively affect the whole agent/scope bucket', () => {
  const mcp = item(1, {
    kind: 'mcp',
    agent: 'windsurf',
    skillSource: undefined,
    fileType: 'mcp-config',
    capabilities: undefined,
    scan: { status: 'not-scanned', findings: 0 },
    mcp: { transport: 'stdio', wrapper: 'not-configured', strict: false },
    scope: 'user',
  });
  delete mcp.skillSource;
  delete mcp.capabilities;
  const after = snapshot([], {
    gaps: [{ code: 'invalid-config', agent: 'windsurf', scope: 'user', kind: 'mcp' }],
  });
  assert.equal(compare(snapshot([mcp]), after).rows[0].kind, 'unverifiable');
  assert.equal(compare(snapshot([mcp]), snapshot([])).rows[0].kind, 'removed');
});
test('incomplete tree hashes cannot establish a changed or unchanged complete artifact', () => {
  const result = compare(
    snapshot(),
    snapshot([item(1, { sha256: 'f'.repeat(64), scan: { status: 'incomplete', findings: 0 } })]),
  );
  assert.equal(result.rows[0].kind, 'unverifiable');
});
test('public changes truncate deterministically while retaining exact omitted count', () => {
  const result = compare(snapshot([]), snapshot(Array.from({ length: 70 }, (_, i) => item(i + 1))));
  assert.equal(result.total, 70);
  assert.equal(result.rows.length, 64);
  assert.equal(result.omitted, 6);
});
test('trusted home alias has only user skill and Cursor scopes while ordinary missing scope remains partial', () => {
  const home = snapshot([], {
    skillSources: sources.map((id) => ({ id, scope: 'user', status: 'complete', candidates: 0 })),
  });
  assert.equal(
    api.observationSummary(api.projectInventory(home, { projectIsUser: true })).complete,
    true,
  );
  assert.equal(api.observationSummary(api.projectInventory(home)).complete, false);
});
test('unknown gap scope or source cannot silently establish absence in a known bucket', () => {
  const a = snapshot();
  const globalSkill = snapshot([], {
    gaps: [{ code: 'capture-gap', agent: 'unknown', scope: 'unknown', kind: 'skill' }],
  });
  assert.equal(compare(a, globalSkill).rows[0].kind, 'unverifiable');
  const unknownKind = snapshot([], {
    gaps: [{ code: 'capture-gap', agent: 'unknown', scope: 'unknown', kind: 'unknown' }],
  });
  assert.equal(compare(a, unknownKind).rows[0].kind, 'unverifiable');
});
