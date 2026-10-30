import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePolicyCaseDefinitions, previewPolicy } from '../.local-engine/policy-engine.js';
const record = {
  id: 'case-' + 'a'.repeat(64),
  createdAt: '2026-10-23T00:00:00.000Z',
  source: {
    incidentId: 'incident-' + 'b'.repeat(64),
    evidenceSha: 'b'.repeat(64),
    workspaceId: 'workspace-' + 'c'.repeat(24),
  },
  classes: ['mcp.call', 'shell.network'],
  expected: [
    { taint: 'none', effect: 'allow' },
    { taint: 'suspect', effect: 'deny' },
  ],
};
test('saved cases evaluate the complete combination with two exact expected effects', () => {
  const report = evaluatePolicyCaseDefinitions(null, [record]);
  assert.equal(report.total, 1);
  assert.equal(report.passed, 1);
  assert.equal(report.failed, 0);
  assert.deepEqual(report.results[0], {
    caseId: record.id,
    passed: true,
    scenarios: [
      { taint: 'none', expected: 'allow', actual: 'allow' },
      { taint: 'suspect', expected: 'deny', actual: 'deny' },
    ],
  });
  const mismatch = evaluatePolicyCaseDefinitions(null, [
    { ...record, expected: [{ taint: 'none', effect: 'ask' }, record.expected[1]] },
  ]);
  assert.equal(mismatch.failed, 1);
});
test('missing cases are a zero-case evaluation but invalid policy and private records are refused', () => {
  assert.equal(evaluatePolicyCaseDefinitions(null, []).total, 0);
  assert.throws(() => evaluatePolicyCaseDefinitions('broken: [', []), /policy-invalid/);
  for (const cases of [
    [{ ...record, command: 'PRIVATE_COMMAND' }],
    [{ ...record, classes: [] }],
    [record, record],
    [{ ...record, classes: ['PRIVATE_CLASS'] }],
    Array(65).fill(record),
  ])
    assert.throws(() => evaluatePolicyCaseDefinitions(null, cases), /invalid-request/);
});
test('saved-case failure independently blocks a candidate with a passing bundled corpus', async () => {
  const preview = await previewPolicy(
    null,
    { denyActionClasses: ['shell.network'] },
    [record],
    'd'.repeat(64),
  );
  assert.equal(preview.simulation.attacksPassing, 0);
  assert.equal(preview.simulation.notJudged, 0);
  assert.equal(preview.regressions.total, 1);
  assert.equal(preview.regressions.failed, 1);
  assert.equal(preview.regressions.revision, 'd'.repeat(64));
  assert.ok(preview.blockers.includes('saved-case-failures'));
});
