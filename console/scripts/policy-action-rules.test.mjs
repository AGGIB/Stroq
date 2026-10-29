import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'tsup';
import { parse, stringify } from 'yaml';
import { ACTION_CLASSES, DEFAULT_POLICY, evaluatePolicy } from '../../packages/core/dist/index.js';

// Keep focused tests independent of the app's shared adapter output.
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = await mkdtemp(join(tmpdir(), 'stroq-policy-action-test-'));
after(() => rm(output, { recursive: true, force: true }));
await build({
  entry: { 'policy-engine': resolve(repository, 'console/scripts/policy-engine-entry.ts') },
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
for (const name of ['atlas', 'scope', 'asi']) {
  await copyFile(
    resolve(repository, `packages/cli/src/coverage/${name}.json`),
    join(output, `${name}.json`),
  );
}
const { previewPolicy } = await import(pathToFileURL(join(output, 'policy-engine.mjs')).href);
const source = (rules = DEFAULT_POLICY.rules) => stringify({ ...DEFAULT_POLICY, rules });
const rule = (id, classes, effect = 'allow', taint = 'any') => ({
  id,
  reason: `PRIVATE_REASON_${id}`,
  effect,
  when: { classes, taint },
});

test('class deny request rejects empty, duplicate, private, unknown and sparse arrays', async () => {
  for (const denyActionClasses of [
    [],
    ['shell.network', 'shell.network'],
    ['PRIVATE_CLASS'],
    ['shell.network', 'unknown'],
    'shell.network',
    new Array(1),
    [...ACTION_CLASSES, 'shell.network'],
  ]) {
    await assert.rejects(previewPolicy(null, { denyActionClasses }), /invalid-request/);
  }
  await assert.rejects(
    previewPolicy(null, { denyActionClasses: ['shell.network'], privateRule: 'PRIVATE_RULE' }),
    /invalid-request/,
  );
});

test('first-priority class deny survives earlier allows and every companion class at either taint', async () => {
  const original = [
    rule('private-allow', ['network.fetch', 'mcp.call'], 'allow', 'none'),
    ...DEFAULT_POLICY.rules,
  ];
  const preview = await previewPolicy(source(original), {
    denyActionClasses: ['shell.network', 'mcp.call'],
  });
  const candidate = parse(preview.candidateText);
  assert.deepEqual(candidate.rules[0].when, {
    classes: ['mcp.call', 'shell.network'],
    taint: 'any',
  });
  assert.equal(candidate.rules[0].effect, 'deny');
  for (const selected of ['mcp.call', 'shell.network']) {
    for (const companion of ACTION_CLASSES) {
      for (const taint of [null, 'suspect']) {
        assert.equal(evaluatePolicy(candidate, [selected, companion], taint).effect, 'deny');
      }
    }
  }
  assert.deepEqual(preview.actionControl, {
    classes: ['mcp.call', 'shell.network'],
    removedRules: 1,
    narrowedRules: 1,
    taint: 'any',
    scope: 'stroq-home',
    hostEnforcement: false,
  });
  assert.deepEqual(
    preview.changes,
    ['mcp.call', 'shell.network'].map((actionClass) => ({
      field: 'class-deny',
      actionClass,
      from: 'current-policy',
      to: 'deny',
    })),
  );
  assert.equal(
    candidate.rules.slice(1).some((r) => r.when.classes.includes('shell.network')),
    false,
  );
  assert.equal(
    preview.check.findings.some((f) => f.kind === 'shadowed-rule'),
    false,
  );
  const { candidateText, ...publicFields } = preview;
  assert.equal(JSON.stringify(publicFields).includes('PRIVATE_'), false);
});

test('surgical edits preserve unrelated YAML comments, labels, predicates and protections', async () => {
  const original = [
    rule('private-allow', ['mcp.call', 'network.fetch'], 'allow', 'none'),
    ...DEFAULT_POLICY.rules,
  ];
  const yaml = source(original)
    .replace('version: 1', '# owner comment\nversion: 1')
    .replace('- network.fetch', '- network.fetch # keep class comment')
    .replace('taint: none', 'taint: none # keep predicate comment');
  const preview = await previewPolicy(yaml, { denyActionClasses: ['mcp.call'] });
  const candidate = parse(preview.candidateText);
  assert.match(preview.candidateText, /# owner comment/);
  assert.match(preview.candidateText, /# keep class comment/);
  assert.match(preview.candidateText, /# keep predicate comment/);
  assert.deepEqual(candidate.rules[1], {
    ...original[0],
    when: { classes: ['network.fetch'], taint: 'none' },
  });
  assert.deepEqual(candidate.rules.slice(2), original.slice(1));
  for (const a of ACTION_CLASSES.filter((c) => c !== 'mcp.call')) {
    for (const b of ACTION_CLASSES.filter((c) => c !== 'mcp.call')) {
      for (const taint of [null, 'suspect']) {
        assert.equal(
          evaluatePolicy(candidate, [a, b], taint).effect,
          evaluatePolicy({ ...DEFAULT_POLICY, rules: original }, [a, b], taint).effect,
        );
      }
    }
  }
});

test('a single-class denial is not a no-op when an earlier other-class allow can win', async () => {
  const original = [rule('private-allow', ['mcp.call']), ...DEFAULT_POLICY.rules];
  assert.equal(
    evaluatePolicy({ ...DEFAULT_POLICY, rules: original }, ['secret.egress'], null).effect,
    'deny',
  );
  assert.equal(
    evaluatePolicy({ ...DEFAULT_POLICY, rules: original }, ['secret.egress', 'mcp.call'], null)
      .effect,
    'allow',
  );
  const preview = await previewPolicy(source(original), { denyActionClasses: ['secret.egress'] });
  assert.equal(
    evaluatePolicy(parse(preview.candidateText), ['secret.egress', 'mcp.call'], null).effect,
    'deny',
  );
});

test('already universal denials are no-ops and do not fabricate cleanup or improvement', async () => {
  await assert.rejects(previewPolicy(null, { denyActionClasses: ['secret.egress'] }), /no-changes/);
  const preview = await previewPolicy(null, {
    denyActionClasses: ['secret.egress'],
    threshold: 0.5,
  });
  assert.equal(preview.actionControl, null);
  assert.deepEqual(preview.changes, [{ field: 'threshold', from: 0.6, to: 0.5 }]);
  assert.deepEqual(parse(preview.candidateText).rules, DEFAULT_POLICY.rules);
});

test('real ordinary-work replay reports actual interruptions from denying outbound actions', async () => {
  const preview = await previewPolicy(null, { denyActionClasses: ['network.fetch'] });
  assert.equal(preview.check.ok, true);
  assert.equal(preview.simulation.attacksPassing, 0);
  assert.ok(preview.simulation.newInterruptions > 0);
  assert.equal(preview.requiresInterruptionAcknowledgement, true);
  assert.ok(preview.interruptions.some((item) => item.to === 'deny'));
  assert.equal(preview.interruptions.length, preview.simulation.newInterruptions);
});

test('existing shadow warnings remain blockers and generated rule ids cannot collide', async () => {
  const original = [
    rule('stroq-console-deny-actions', ['mcp.call']),
    rule('stroq-console-deny-actions-2', ['mcp.call']),
    ...DEFAULT_POLICY.rules,
  ];
  const preview = await previewPolicy(source(original), { denyActionClasses: ['network.fetch'] });
  const candidate = parse(preview.candidateText);
  assert.equal(candidate.rules[0].id, 'stroq-console-deny-actions-3');
  assert.equal(new Set(candidate.rules.map((item) => item.id)).size, candidate.rules.length);
  assert.ok(preview.check.findings.some((f) => f.kind === 'shadowed-rule'));
  assert.ok(preview.blockers.includes('policy-findings'));
});

test('candidate rule limit stays at 512, including the generated rule', async () => {
  const original = Array.from({ length: 512 }, (_, i) => rule(`private-${i}`, ['mcp.call']));
  await assert.rejects(
    previewPolicy(source(original), {
      denyActionClasses: ['network.fetch'],
    }),
    /policy-invalid/,
  );
  const preview = await previewPolicy(source(original), { denyActionClasses: ['mcp.call'] });
  assert.equal(parse(preview.candidateText).rules.length, 1);
  assert.equal(preview.actionControl.removedRules, 512);
});

test('ordinary previews explicitly carry no action control', async () => {
  const preview = await previewPolicy(null, { defaultEffect: 'ask' });
  assert.equal(preview.actionControl, null);
});
