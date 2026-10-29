import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'tsup';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = await realpath(await mkdtemp(join(tmpdir(), 'stroq-codex-output-')));
after(() => rm(output, { recursive: true, force: true }));
await build({
  entry: {
    output: join(repository, 'console/scripts/codex-skill-source-output.ts'),
    schema: join(repository, 'console/lib/codex-skill-sources.ts'),
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
});
const { boundCodexSkillSourcesReport: bound } = await import(
  pathToFileURL(join(output, 'output.mjs')).href
);
const { validateCodexSkillSourcesReport: valid, CODEX_SKILL_SOURCE_LIMITS: limits } = await import(
  pathToFileURL(join(output, 'schema.mjs')).href
);
const sourceId = (index) => `source-${index.toString(16).padStart(24, '0')}`;
function report(count = 128) {
  const unicode = '\u754c';
  return {
    schema: 'stroq-codex-skill-sources/1',
    source: 'local',
    workspaceId: 'workspace-' + 'd'.repeat(24),
    generatedAt: '2026-10-24T12:00:01.000Z',
    runtimeSha256: 'e'.repeat(64),
    capture: {
      startedAt: '2026-10-24T12:00:00.000Z',
      completedAt: '2026-10-24T12:00:01.000Z',
      atomicSnapshot: false,
    },
    context: {
      boundary: 'marker',
      ancestorCount: 32,
      markerPolicy: 'user-config',
      profile: 'custom',
    },
    settings: { status: 'ready', sha256: 'f'.repeat(64), rules: 512, unmatchedRules: 512 },
    sources: Array.from({ length: 64 }, (_, i) => ({
      id: sourceId(i),
      family: i === 0 ? 'agents' : 'plugins',
      scope: i === 0 ? 'cwd' : 'plugins',
      distance: i === 0 ? 0 : null,
      label: unicode.repeat(200),
      status: i === 0 ? 'complete' : 'uninspected',
      candidates: i === 0 ? count : 0,
    })),
    items: Array.from({ length: count }, (_, index) => ({
      id: `candidate-${index.toString(16).padStart(24, '0')}`,
      sourceId: sourceId(0),
      name: unicode.repeat(200),
      location: {
        label: Array(8)
          .fill('note '.repeat(12) + 'aaa')
          .join('/'),
        redacted: false,
      },
      entrypointSha256: 'a'.repeat(64),
      bytes: 65536,
      declaredState: 'disabled',
      metadata: 'valid',
      scan: {
        status: 'suspect',
        findings: 35,
        matches: Array.from({ length: 32 }, (_, match) => ({
          ruleId: `RULE-${String(match).padStart(195, '0')}`,
          severity: 'high',
          title: unicode.repeat(240),
        })),
        omitted: 3,
      },
      capabilities: [
        'fs.read',
        'fs.write',
        'net',
        'cred.env',
        'cred.file',
        'exec',
        'hook',
        'install-script',
        'tool',
        'allowed-tools',
        'signal',
      ].map((kind) => ({ kind, count: 10000 })),
    })),
    gaps: Array.from({ length: 128 }, (_, i) => ({
      code: 'session-overrides-unverified',
      sourceId: sourceId(i % 64),
    })),
    omitted: { sources: 0, items: 0 },
  };
}
const bytes = (value) => Buffer.byteLength(JSON.stringify(value));
test('maximum field sizes retain all source and candidate facts within the UTF-8 byte cap', () => {
  const input = report(),
    before = JSON.stringify(input);
  assert(valid(input));
  assert(bytes(input) > limits.responseBytes);
  const result = bound(input);
  assert(bytes(result) <= limits.responseBytes);
  assert(valid(result));
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(result.sources, input.sources);
  assert.deepEqual(result.settings, input.settings);
  assert.deepEqual(result.gaps, input.gaps);
  assert.deepEqual(result.omitted, input.omitted);
  assert.equal(result.items.length, input.items.length);
  let removed = 0;
  for (let index = 0; index < input.items.length; index++) {
    const original = input.items[index],
      item = result.items[index];
    const { scan: originalScan, ...originalFacts } = original,
      { scan, ...facts } = item;
    assert.deepEqual(facts, originalFacts);
    assert.equal(scan.status, originalScan.status);
    assert.equal(scan.findings, originalScan.findings);
    assert.equal(scan.findings, scan.matches.length + scan.omitted);
    removed += originalScan.matches.length - scan.matches.length;
  }
  assert(removed > 0);
  assert(
    result.items.some(
      (item) =>
        item.scan.matches.length === 0 &&
        item.scan.status === 'suspect' &&
        item.scan.omitted === 35,
    ),
  );
  const retained = result.items.flatMap((item) => item.scan.matches),
    original = input.items.flatMap((item) => item.scan.matches);
  assert.deepEqual(retained, original.slice(0, retained.length));
});
test('the output search uses a bounded number of serializations for 4096 details', () => {
  const input = report(),
    stringify = JSON.stringify;
  let calls = 0;
  JSON.stringify = function (...args) {
    calls++;
    return stringify.apply(JSON, args);
  };
  try {
    bound(input);
  } finally {
    JSON.stringify = stringify;
  }
  assert(calls <= 16, `Unexpected serialization count: ${calls}`);
});
test('under-limit reports remain unchanged, and an oversized zero-detail base is refused', () => {
  const input = report(1);
  assert(valid(input));
  assert(bytes(input) < limits.responseBytes);
  assert.equal(bound(input), input);
  assert.throws(() => bound(input, 1024), /inventory-unavailable/);
});
