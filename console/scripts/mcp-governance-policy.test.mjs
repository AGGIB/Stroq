import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { tsImport } from 'tsx/esm/api';
import { fileURLToPath } from 'node:url';
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const loader = await mkdtemp(join(tmpdir(), 'stroq-governance-policy-'));
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
const api = await tsImport('./mcp-governance-policy.ts', { parentURL: import.meta.url, tsconfig });
const text =
  '# operator comment\nversion: 1\ndefault: ask\nthreshold: 0.4\nrules:\n  - id: protected\n    effect: deny\n    reason: Keep this reason\n    when:\n      classes: [mcp.side_effect]\n      taint: any\n';
const allowed = [{ channel: 'claude-code', name: 'notes' }];
test('upgrade preserves existing policy and comments; pair summaries are display only', () => {
  const p = api.buildMcpGovernancePolicy(text, allowed);
  assert.match(p.candidateText, /# operator comment/);
  assert.match(p.candidateText, /Keep this reason/);
  assert.equal(p.policy.version, 2);
  assert.equal(p.policy.default, 'ask');
  assert.equal(p.policy.threshold, 0.4);
  assert.deepEqual(p.policy.rules[0].when.classes, ['mcp.side_effect']);
  assert.deepEqual(p.policy.mcpGovernance.allowed, allowed);
  assert.equal(p.requiresWeakening, false);
  assert.equal(p.diff.added.length, 1);
  assert.throws(() => api.buildMcpGovernancePolicy(p.candidateText, allowed), /no-changes/);
  const q = api.buildMcpGovernancePolicy(p.candidateText, [
    ...allowed,
    { channel: 'codex', name: 'notes' },
  ]);
  assert.equal(q.requiresWeakening, true);
});
test('strict authority refuses unknown fields, aliases, forged pairs and duplicate identities', () => {
  for (const source of [
    text + 'typo: true\n',
    text.replace('classes: [mcp.side_effect]', 'classes: &x [mcp.side_effect]') + 'extra: *x\n',
  ])
    assert.throws(() => api.buildMcpGovernancePolicy(source, allowed), /policy-invalid/);
  for (const pairs of [
    [...allowed, ...allowed],
    [{ channel: 'copilot', name: 'notes' }],
    [{ channel: 'codex', name: ' notes' }],
  ])
    assert.throws(() => api.buildMcpGovernancePolicy(text, pairs), /invalid-request/);
});
test('gate fixtures check deny-only behavior including existing side-effect denial', () => {
  const p = api.buildMcpGovernancePolicy(text, allowed);
  const checks = api.checkMcpGovernanceGate(p.policy, 'a'.repeat(64));
  assert.equal(checks.passed, true);
  assert.deepEqual(
    checks.cases.map((c) => c.status),
    ['passed', 'passed', 'passed', 'passed'],
  );
  const empty = api.buildMcpGovernancePolicy(text, []);
  assert.equal(
    api.checkMcpGovernanceGate(empty.policy, 'a'.repeat(64)).cases[0].status,
    'not-applicable',
  );
});
test('whole-policy restore exposes removal of MCP gate and every removed identity', () => {
  const p = api.buildMcpGovernancePolicy(text, allowed);
  const diff = api.mcpGovernanceRestoreDiff(p.policy, api.readGovernancePolicy(text));
  assert.equal(diff.current.gate, 'enforced');
  assert.equal(diff.candidate.gate, 'absent');
  assert.equal(diff.diff.removed.length, 1);
  assert.equal(diff.registrationPinned, false);
});
