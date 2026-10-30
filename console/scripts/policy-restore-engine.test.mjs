import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'tsup';
import { stringify } from 'yaml';
import { Worker } from 'node:worker_threads';
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = await mkdtemp(join(tmpdir(), 'stroq-policy-restore-engine-'));
after(() => rm(output, { recursive: true, force: true }));
await build({
  entry: {
    'policy-engine': resolve(repository, 'console/scripts/policy-engine-entry.ts'),
    fixture: resolve(repository, 'packages/core/src/index.ts'),
    schema: resolve(repository, 'console/lib/policy-history.ts'),
  },
  outDir: output,
  outExtension: () => ({ js: '.mjs' }),
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  splitting: false,
  sourcemap: false,
  clean: false,
  dts: false,
  config: false,
  silent: true,
  noExternal: ['@stroq/core', 'yaml', 'zod'],
  banner: {
    js: "import { createRequire as createEngineRequire } from 'node:module'; const require = createEngineRequire(import.meta.url);",
  },
  esbuildOptions(options) {
    options.alias = { '@stroq/core': resolve(repository, 'packages/core/src/index.ts') };
  },
});
await copyFile(
  resolve(repository, 'packages/cli/src/attack/scenarios/corpus.json'),
  join(output, 'corpus.json'),
);
for (const name of ['atlas', 'scope', 'asi'])
  await copyFile(
    resolve(repository, `packages/cli/src/coverage/${name}.json`),
    join(output, `${name}.json`),
  );
const engine = await import(pathToFileURL(join(output, 'policy-engine.mjs')).href);
const { DEFAULT_POLICY, ACTION_CLASSES, evaluatePolicy } = await import(
  pathToFileURL(join(output, 'fixture.mjs')).href
);
const { validatePolicyRestorePreview } = await import(
  pathToFileURL(join(output, 'schema.mjs')).href
);
const source = (value) => stringify(value);
const preview = (current, candidate, records = [], revision = null) =>
  engine.previewPolicyRestore(current, { candidateText: candidate }, records, revision);

test('restore supports intentional reductions without bypassing default protections or source preservation', async () => {
  const current = source({ ...DEFAULT_POLICY, default: 'deny' });
  const candidate = '\uFEFF# PRIVATE_LABEL\r\n' + source(DEFAULT_POLICY).replaceAll('\n', '\r\n');
  const result = await preview(current, candidate);
  assert.equal(result.candidateText, candidate);
  assert.ok(result.decisions.some((row) => row.from === 'deny' && row.to === 'allow'));
  assert.equal(result.simulation.attacksPassing, 0);
  assert.deepEqual(result.blockers, []);
  const { candidateText, ...publicResult } = result;
  assert.equal(JSON.stringify(publicResult).includes('PRIVATE_LABEL'), false);
  const fake = {
    schema: 'stroq-policy-restore-preview/2',
    previewId: '12345678-1234-4123-8123-123456789abc',
    entryId: '12345678-1234-4123-8123-123456789abd',
    expiresAt: '2026-10-24T12:00:00.000Z',
    recordSha256: 'a'.repeat(64),
    runtimeSha256: 'a'.repeat(64),
    expectedRawSha: 'a'.repeat(64),
    candidateRawSha: 'b'.repeat(64),
    target: 'backup',
    scope: 'stroq-home',
    hostEnforcement: false,
    ...publicResult,
  };
  assert.equal(validatePolicyRestorePreview(fake), true);
});
test('current bundled default is selectable and an absent current source can restore a retained file', async () => {
  assert.equal(
    (await preview(source({ ...DEFAULT_POLICY, default: 'deny' }), null)).candidateText,
    null,
  );
  const result = await preview(null, source({ ...DEFAULT_POLICY, default: 'ask' }));
  assert.ok(result.simulation.newInterruptions > 0);
  assert.equal(result.interruptions.length, Math.min(result.simulation.newInterruptions, 128));
  for (const [index, row] of result.decisions.entries()) {
    assert.ok(ACTION_CLASSES.includes(row.actionClass));
    assert.notEqual(row.from, row.to);
    if (index > 0) {
      const old = result.decisions[index - 1];
      assert.ok(
        ACTION_CLASSES.indexOf(old.actionClass) < ACTION_CLASSES.indexOf(row.actionClass) ||
          (old.actionClass === row.actionClass && old.taint === 'none' && row.taint === 'suspect'),
      );
    }
    assert.equal(
      row.from,
      evaluatePolicy(DEFAULT_POLICY, [row.actionClass], row.taint === 'none' ? null : 'suspect')
        .effect,
    );
  }
});
test('threshold-only restoration exposes actual current and candidate settings even with no class-only changes', async () => {
  const candidate = source({ ...DEFAULT_POLICY, threshold: 0.5 });
  const result = await preview(null, candidate);
  assert.deepEqual(result.settings, {
    current: {
      defaultEffect: DEFAULT_POLICY.default,
      threshold: DEFAULT_POLICY.threshold,
      rules: DEFAULT_POLICY.rules.length,
    },
    candidate: {
      defaultEffect: DEFAULT_POLICY.default,
      threshold: 0.5,
      rules: DEFAULT_POLICY.rules.length,
    },
  });
  assert.deepEqual(result.decisions, []);
  assert.notEqual(result.currentPolicyFingerprint, result.candidateFingerprint);
  assert.equal(result.candidateText, candidate);
});
test('strict current and candidate parsing rejects aliases, unknown fields, malformed YAML and >512 rules', async () => {
  const invalid = [
    'not: [yaml',
    'version: 1\nextra: true\nrules: []\n',
    'version: 1\nthreshold: &a 0.6\nrules: *a\n',
    source({
      ...DEFAULT_POLICY,
      rules: Array.from({ length: 513 }, (_, i) => ({ ...DEFAULT_POLICY.rules[0], id: `r${i}` })),
    }),
  ];
  for (const value of invalid) {
    await assert.rejects(preview(null, value), /policy-invalid/);
    await assert.rejects(preview(value, null), /policy-invalid/);
  }
  await assert.rejects(
    engine.previewPolicyRestore(null, { candidateText: null, command: 'private' }),
    /invalid-request/,
  );
  await assert.rejects(preview(null, null), /no-changes/);
  const same = source(DEFAULT_POLICY);
  await assert.rejects(preview(same, same), /no-changes/);
});
test('weakened default protections stay blocked and saved-case expectations are evaluated', async () => {
  const result = await preview(null, source({ ...DEFAULT_POLICY, rules: [] }));
  assert.ok(result.blockers.includes('policy-findings'));
  assert.ok(
    result.blockers.some((code) => ['attacks-allowed', 'unmet-expectations'].includes(code)),
  );
  const crypto = await import('node:crypto');
  const classes = ['network.fetch'];
  const expected = [
    { taint: 'none', effect: 'deny' },
    { taint: 'suspect', effect: 'deny' },
  ];
  const id =
    'case-' +
    crypto.createHash('sha256').update(JSON.stringify({ classes, expected })).digest('hex');
  const records = [
    {
      id,
      createdAt: '2026-10-24T00:00:00.000Z',
      source: {
        incidentId: 'incident-' + 'a'.repeat(64),
        evidenceSha: 'a'.repeat(64),
        workspaceId: 'workspace-' + 'b'.repeat(24),
      },
      classes,
      expected,
    },
  ];
  const saved = await preview(
    source({ ...DEFAULT_POLICY, default: 'deny' }),
    null,
    records,
    'c'.repeat(64),
  );
  assert.equal(saved.regressions.failed, 1);
  assert.ok(saved.blockers.includes('saved-case-failures'));
});
test('fixed worker transport executes restore-preview and returns only derived fields plus exact private candidate', async () => {
  const worker = new Worker(pathToFileURL(join(output, 'policy-engine.mjs')), {
    workerData: {
      operation: 'restore-preview',
      text: source({ ...DEFAULT_POLICY, default: 'deny' }),
      changes: { candidateText: null },
      cases: [],
      caseRevision: null,
    },
    execArgv: [],
    env: {},
    resourceLimits: { maxOldGenerationSizeMb: 256 },
  });
  try {
    const message = await new Promise((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
      worker.once('exit', (code) => {
        if (code !== 0) reject(Error('worker-exit'));
      });
    });
    assert.equal(message.ok, true);
    assert.equal(message.value.candidateText, null);
    assert.ok(message.value.decisions.length > 0);
  } finally {
    await worker.terminate();
  }
});
