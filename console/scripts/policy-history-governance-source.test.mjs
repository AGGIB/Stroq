import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { tsImport } from 'tsx/esm/api';
import { fileURLToPath } from 'node:url';
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

const loader = await mkdtemp(join(tmpdir(), 'stroq-policy-history-source-'));
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
const bridge = join(loader, 'entry.ts');
await writeFile(
  bridge,
  [
    `export {previewPolicyRestore} from ${JSON.stringify(resolve(repositoryRoot, 'console/scripts/policy-engine-entry.ts'))};`,
    `export {BUNDLED} from ${JSON.stringify(resolve(repositoryRoot, 'packages/cli/src/policy/replay.js'))};`,
    `export {DEFAULT_POLICY} from ${JSON.stringify(resolve(repositoryRoot, 'packages/core/src/policy/default-policy.js'))};`,
    `export {validatePolicyRestorePreview} from ${JSON.stringify(resolve(repositoryRoot, 'console/lib/policy-history.ts'))};`,
  ].join('\n'),
);
const { previewPolicyRestore, BUNDLED, DEFAULT_POLICY, validatePolicyRestorePreview } =
  await tsImport(bridge, { parentURL: import.meta.url, tsconfig });

test('actual source Restore preview exposes v2 to v1 gate removal when ordinary settings stay equal', async () => {
  const previous = { attack: BUNDLED.attack, ordinary: BUNDLED.ordinary };
  const priorBudget = process.env.STROQ_SCAN_BUDGET_MS;
  try {
    // One inert attack and one ordinary engine fixture exercise the actual source
    // simulation path. This test is not a full corpus or host enforcement claim.
    BUNDLED.attack = previous.attack.slice(0, 1);
    BUNDLED.ordinary = previous.ordinary.slice(0, 1);
    process.env.STROQ_SCAN_BUDGET_MS = '60000';
    const current = JSON.stringify({
      ...DEFAULT_POLICY,
      version: 2,
      mcpGovernance: {
        allowed: [
          { channel: 'claude-code', name: 'github' },
          { channel: 'codex', name: 'PRIVATE_TOKEN' },
        ],
      },
    });
    const candidateText =
      '\uFEFF# PRIVATE_RESTORE_COMMENT\r\n' +
      JSON.stringify(DEFAULT_POLICY, null, 2).replaceAll('\n', '\r\n') +
      '\r\n';
    const value = await previewPolicyRestore(current, { candidateText });
    assert.equal(value.candidateText, candidateText);
    assert.deepEqual(value.settings.current, value.settings.candidate);
    assert.equal(value.mcpGovernance.current.policyVersion, 2);
    assert.equal(value.mcpGovernance.current.gate, 'enforced');
    assert.equal(value.mcpGovernance.candidate.policyVersion, 1);
    assert.equal(value.mcpGovernance.candidate.gate, 'absent');
    assert.equal(value.mcpGovernance.diff.removed.length, 2);
    assert.deepEqual(value.mcpGovernance.diff.added, []);
    assert.deepEqual(value.mcpGovernance.diff.retained, []);
    assert.equal(value.mcpGovernance.registrationPinned, false);
    assert.equal(value.mcpGovernance.hostEnforcement, false);
    assert.ok(
      value.decisions.some(
        (row) => row.actionClass === 'mcp.call' && row.from === 'deny' && row.to === 'allow',
      ),
    );
    assert.deepEqual(value.simulation.replayed, { attack: 1, ordinary: 1, cases: 0 });
    const { candidateText: privateCandidate, ...projection } = value;
    assert.ok(!JSON.stringify(projection).includes('PRIVATE_TOKEN'));
    assert.ok(!JSON.stringify(projection).includes('PRIVATE_RESTORE_COMMENT'));
    const publicPreview = {
      schema: 'stroq-policy-restore-preview/2',
      previewId: '12345678-1234-4123-8123-123456789abc',
      entryId: '12345678-1234-4123-8123-123456789abd',
      expiresAt: '2026-10-27T12:00:00.000Z',
      recordSha256: 'a'.repeat(64),
      runtimeSha256: 'a'.repeat(64),
      expectedRawSha: 'a'.repeat(64),
      candidateRawSha: 'b'.repeat(64),
      target: 'backup',
      scope: 'stroq-home',
      hostEnforcement: false,
      ...projection,
    };
    assert.equal(validatePolicyRestorePreview(publicPreview), true);
    const { mcpGovernance, ...missingGateDelta } = publicPreview;
    assert.equal(validatePolicyRestorePreview(missingGateDelta), false);
    assert.equal(
      validatePolicyRestorePreview({ ...publicPreview, schema: 'stroq-policy-restore-preview/1' }),
      false,
    );
  } finally {
    BUNDLED.attack = previous.attack;
    BUNDLED.ordinary = previous.ordinary;
    if (priorBudget === undefined) delete process.env.STROQ_SCAN_BUDGET_MS;
    else process.env.STROQ_SCAN_BUDGET_MS = priorBudget;
  }
});
