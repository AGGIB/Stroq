import assert from 'node:assert/strict';
import { lstat, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Built-in-only transport fixture, also copied outside the source tree for the
// installed-package smoke. All writes target the caller's disposable profile.
export async function exercisePolicyHistory({
  origin,
  headers,
  inspectHeaders,
  home,
  schema,
  defaultPolicy,
}) {
  const path = join(home, 'policy.yaml');
  const request = async (route, input) => {
    const response = await fetch(origin + route, {
      method: input === undefined ? 'GET' : 'POST',
      headers: input === undefined ? headers : inspectHeaders,
      body: input === undefined ? undefined : JSON.stringify(input),
    });
    return { status: response.status, body: await response.json() };
  };
  const get = async () => {
    const state = await request('/api/policy/history');
    assert.equal(state.status, 200, JSON.stringify(state));
    assert(schema.validatePolicyHistoryState(state.body), JSON.stringify(state.body));
    return state.body;
  };
  const tighten = async () => {
    const current = await request('/api/policy');
    const preview = await request('/api/policy/preview', {
      expectedRawSha: current.body.expectedRawSha,
      changes: { denyActionClasses: ['shell.network'] },
    });
    assert.equal(preview.status, 200, JSON.stringify(preview));
    assert.equal(preview.body.blockers.length, 0);
    const receipt = await request('/api/policy/apply', {
      previewId: preview.body.previewId,
      expectedRawSha: preview.body.expectedRawSha,
      candidateFingerprint: preview.body.candidateFingerprint,
      acknowledgeInterruptions: true,
      acknowledgeActionScope: true,
    });
    assert.equal(receipt.status, 200, JSON.stringify(receipt));
    return receipt.body;
  };
  const prepare = async (entryId) => {
    const state = await get();
    const entry = state.entries.find((entry) => entry.id === entryId);
    assert(entry, 'recorded change must survive refresh');
    const result = await request('/api/policy/restore/preview', {
      entryId,
      recordSha256: entry.recordSha256,
      expectedRawSha: state.currentRawSha,
    });
    assert.equal(result.status, 200, JSON.stringify(result));
    assert(schema.validatePolicyRestorePreview(result.body), JSON.stringify(result.body));
    assert.equal(result.body.schema, 'stroq-policy-restore-preview/2');
    assert.equal(result.body.mcpGovernance.registrationPinned, false);
    assert.equal(result.body.mcpGovernance.hostEnforcement, false);
    assert.equal(result.body.blockers.length, 0);
    return result.body;
  };
  const commit = (preview) => ({
    previewId: preview.previewId,
    entryId: preview.entryId,
    recordSha256: preview.recordSha256,
    expectedRawSha: preview.expectedRawSha,
    candidateFingerprint: preview.candidateFingerprint,
    acknowledgeSharedScope: true,
    acknowledgeReducedProtection: true,
    acknowledgeBackup: true,
    acknowledgeInterruptions: true,
  });
  const restore = async (preview) => {
    const result = await request('/api/policy/restore/apply', commit(preview));
    assert.equal(result.status, 200, JSON.stringify(result));
    assert(schema.validatePolicyRestoreReceipt(result.body), JSON.stringify(result.body));
    return result.body;
  };
  const original = Buffer.from(
    '\uFEFF# PRIVATE_POLICY_RECOVERY_COMMENT\r\n' +
      JSON.stringify(defaultPolicy, null, 2).replaceAll('\n', '\r\n') +
      '\r\n',
  );
  await writeFile(path, original, { mode: 0o600 });
  const changed = await tighten();
  const tightened = await readFile(path);
  assert(!tightened.equals(original));
  const preview = await prepare(changed.receiptId);
  assert.equal(preview.target, 'backup');
  assert(
    preview.decisions.some(
      (row) => row.actionClass === 'shell.network' && row.from === 'deny' && row.to !== 'deny',
    ),
  );
  for (const field of [
    'acknowledgeSharedScope',
    'acknowledgeReducedProtection',
    'acknowledgeBackup',
  ]) {
    const refused = await request('/api/policy/restore/apply', {
      ...commit(preview),
      [field]: false,
    });
    assert(refused.status >= 400 && refused.status < 500, JSON.stringify(refused));
    assert.deepEqual(await readFile(path), tightened);
  }
  const receipt = await restore(preview);
  assert.deepEqual(await readFile(path), original, 'restore exact BOM, comments and CRLF bytes');
  assert(receipt.backupId);
  assert.deepEqual(
    await readFile(join(home, 'backups', 'console-policy', receipt.backupId + '.yaml')),
    tightened,
  );
  assert.equal(
    (await lstat(join(home, 'backups', 'console-policy', receipt.backupId + '.yaml'))).mode & 0o777,
    0o600,
  );
  const afterRestore = await get();
  assert.equal(afterRestore.currentRawSha, receipt.rawSha);
  assert.equal(afterRestore.currentPolicyFingerprint, receipt.policyFingerprint);
  assert.equal((await request('/api/policy/restore/apply', commit(preview))).status, 409);

  // Begin a second independent fixture phase from absent policy.yaml. Choosing
  // current-default is explicit; it does not claim retained historical defaults.
  await rm(path);
  const fromDefault = await tighten();
  assert.equal(fromDefault.backupId, null);
  const beforeDefault = await readFile(path);
  const defaultPreview = await prepare(fromDefault.receiptId);
  assert.equal(defaultPreview.target, 'current-default');
  assert.equal(defaultPreview.candidateRawSha, null);
  const defaultReceipt = await restore(defaultPreview);
  assert.equal(defaultReceipt.rawSha, null);
  await assert.rejects(lstat(path), { code: 'ENOENT' });
  const defaultState = await get();
  assert.equal(defaultState.currentRawSha, null);
  assert.equal(defaultState.currentPolicyFingerprint, defaultReceipt.policyFingerprint);

  // The delete intent itself retains the stricter bytes: recovery remains usable
  // when the active source is now the built-in default.
  const redoPreview = await prepare(defaultReceipt.receiptId);
  assert.equal(redoPreview.target, 'backup');
  const redoReceipt = await restore(redoPreview);
  assert.equal(redoReceipt.backupId, null);
  assert.deepEqual(await readFile(path), beforeDefault);
  const serialized = JSON.stringify({
    preview,
    receipt,
    afterRestore,
    defaultPreview,
    defaultReceipt,
    defaultState,
    redoPreview,
    redoReceipt,
  });
  for (const privateText of [
    home,
    'PRIVATE_POLICY_RECOVERY_COMMENT',
    defaultPolicy.rules[0].reason,
  ])
    assert(!serialized.includes(privateText), 'public projection excludes private policy content');
  return {
    exactBackup: true,
    explicitCurrentDefault: true,
    recoveryFromDefault: true,
    missingConsentRefused: true,
  };
}
