import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { parse, stringify } from 'yaml';
import { runPolicyAdapter } from './policy-worker.mjs';

const built = existsSync(new URL('../.local-engine/policy-engine.js', import.meta.url));
const real = { skip: built ? false : 'Run pnpm build:engine to test the bundled policy engine' };
const defaultText = await readFile(new URL('../../policies/default.yaml', import.meta.url), 'utf8');

test(
  'real inspection reports default policy; informational findings do not fail it',
  real,
  async () => {
    const result = await runPolicyAdapter('inspect', null);
    assert.equal(result.editable, true);
    assert.equal(result.rules.length, 21);
    assert.equal(result.check.ok, true);
    assert.deepEqual(result.check.findings, [
      { kind: 'loose-default', severity: 'info', count: 1 },
    ]);
    assert.equal(
      result.rules.some((rule) => 'id' in rule || 'reason' in rule),
      false,
    );
  },
);

test(
  'real preview freezes the current policy and preserves comments, rule order and predicates',
  real,
  async () => {
    const policy = parse(defaultText);
    policy.default = 'deny';
    policy.rules.push({
      id: 'private-rule-label',
      reason: 'PRIVATE_REASON_SENTINEL',
      effect: 'ask',
      when: { classes: ['mcp.call'], taint: 'none' },
    });
    const source = `# Keep owner comment\n${stringify(policy)}`;
    const current = await runPolicyAdapter('inspect', source);
    const builtin = await runPolicyAdapter('inspect', null);
    const preview = await runPolicyAdapter('preview', source, {
      threshold: 0.5,
      promoteRuleIndexes: [21],
    });
    assert.equal(preview.currentPolicyFingerprint, current.policyFingerprint);
    assert.notEqual(preview.currentPolicyFingerprint, builtin.policyFingerprint);
    assert.match(preview.candidateText, /# Keep owner comment/);
    const candidate = parse(preview.candidateText);
    assert.deepEqual(candidate.rules.slice(0, 21), policy.rules.slice(0, 21));
    assert.deepEqual(candidate.rules[21], { ...policy.rules[21], effect: 'deny' });
    assert.equal(candidate.default, 'deny');
    assert.equal(candidate.threshold, 0.5);
    assert.equal(preview.simulation.replayed.attack, 36);
    assert.equal(preview.simulation.replayed.ordinary, 75);
    assert.equal(preview.simulation.notJudged, 0);
    const { candidateText, ...publicFields } = preview;
    assert.equal(JSON.stringify(publicFields).includes('PRIVATE_REASON_SENTINEL'), false);
    assert.equal(JSON.stringify(publicFields).includes('private-rule-label'), false);
  },
);

test('real strengthening preview surfaces ordinary-work interruptions', real, async () => {
  const result = await runPolicyAdapter('preview', null, { defaultEffect: 'ask' });
  assert.equal(result.check.ok, true);
  assert.equal(result.simulation.attacksPassing, 0);
  assert.ok(result.simulation.newInterruptions > 0);
  assert.equal(result.requiresInterruptionAcknowledgement, true);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.interruptions.length, result.simulation.newInterruptions);
  assert.equal(result.interruptionsTruncated, false);
  assert.deepEqual(result.interruptions[0], {
    label: 'Look at what changed',
    step: 1,
    from: 'allow',
    to: 'ask',
  });
  assert.ok(
    result.interruptions.every(
      (item) =>
        Object.keys(item).sort().join(',') === 'from,label,step,to' && item.label.length <= 240,
    ),
  );
  assert.equal(JSON.stringify(result.interruptions).includes('git status'), false);
});

test(
  'content findings retain clean/suspect outcomes instead of pretending to block a call',
  real,
  async () => {
    const result = await runPolicyAdapter('preview', null, { threshold: 0 });
    assert.ok(result.interruptions.some((item) => item.from === 'clean' && item.to === 'suspect'));
    assert.equal(result.interruptions.length, result.simulation.newInterruptions);
    assert.equal(result.interruptionsTruncated, false);
  },
);

test(
  'impact projection rejects unknown fixtures, bounds details and omits private report values',
  real,
  async () => {
    const { projectPolicyInterruptions } = await import('../.local-engine/policy-engine.js');
    const interruption = {
      id: '01-git-status-and-diff',
      step: 1,
      baseline: 'allow',
      candidate: 'ask',
      tool: 'PRIVATE_TOOL_SENTINEL',
      subject: 'PRIVATE_COMMAND_SENTINEL',
      ruleId: 'PRIVATE_RULE_SENTINEL',
    };
    const report = projectPolicyInterruptions({ newInterruptions: Array(129).fill(interruption) });
    assert.equal(report.interruptions.length, 128);
    assert.equal(report.interruptionsTruncated, true);
    assert.equal(JSON.stringify(report).includes('PRIVATE_'), false);
    for (const invalid of [
      { id: 'untrusted-fixture' },
      { step: 0 },
      { step: 2 },
      { candidate: 'blocked' },
      { baseline: 'executed' },
    ]) {
      assert.throws(
        () => projectPolicyInterruptions({ newInterruptions: [{ ...interruption, ...invalid }] }),
        /engine-failed/,
      );
    }
  },
);

test(
  'weakening, unknown changes, invalid rule indexes and aliases are rejected',
  real,
  async () => {
    await assert.rejects(
      runPolicyAdapter('preview', null, { threshold: 0.7 }),
      /weakening-not-allowed/,
    );
    await assert.rejects(
      runPolicyAdapter('preview', null, { file: '/tmp/nope' }),
      /invalid-request/,
    );
    await assert.rejects(
      runPolicyAdapter('preview', null, { promoteRuleIndexes: [0] }),
      /invalid-request/,
    );
    await assert.rejects(
      runPolicyAdapter('preview', defaultText.replace('default: allow', 'default: deny'), {
        defaultEffect: 'ask',
      }),
      /weakening-not-allowed/,
    );
    const aliased = 'version: 1\nthreshold: &level 0.6\ndefault: allow\nrules: []\nextra: *level\n';
    assert.equal((await runPolicyAdapter('inspect', aliased)).editable, false);
    await assert.rejects(
      runPolicyAdapter('preview', aliased, { threshold: 0.5 }),
      /policy-invalid/,
    );
  },
);

test('an existing custom policy that loses default protections cannot apply', real, async () => {
  const result = await runPolicyAdapter(
    'preview',
    'version: 1\nthreshold: 0.6\ndefault: allow\nrules: []\n',
    { threshold: 0.5 },
  );
  assert.equal(result.check.ok, false);
  assert.ok(result.blockers.includes('policy-findings'));
  assert.ok(result.check.findings.some((finding) => finding.kind === 'dropped-protection'));
});
