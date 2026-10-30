import test from 'node:test';
import assert from 'node:assert/strict';
import { quarantineHarness, workspace } from './quarantine-client-harness.mjs';
async function prepared(h) {
  h.render();
  await h.output.prepare();
  await h.flush();
  assert.ok(h.output.preview);
  h.output.acknowledge(true);
  await h.flush();
}
test('quarantine requires an exact source preview and fresh explicit session consent', async () => {
  const h = quarantineHarness();
  h.render();
  assert.deepEqual(h.calls, []);
  await h.output.apply();
  assert.deepEqual(h.calls, []);
  await prepared(h);
  assert.equal(h.output.acknowledged, true);
  await h.output.apply();
  await h.flush();
  assert.equal(h.completed.length, 1);
  assert.equal(h.completed[0].artifact.skillSource, 'codex-skills');
  assert.deepEqual(h.calls[0].body, {
    action: 'quarantine',
    id: h.props.artifact.id,
    expectedSha256: h.props.artifact.sha256,
  });
  assert.deepEqual(Object.keys(h.calls[1].body).sort(), [
    'acknowledgeSessionLimits',
    'confirm',
    'previewId',
  ]);
  assert.equal(h.output.needsRecheck, false);
});
test('unknown completion survives dialog remount and version change until explicit accepted recheck', async () => {
  const h = quarantineHarness();
  await prepared(h);
  h.control.fail = 'apply';
  await h.output.apply();
  await h.flush();
  assert.equal(h.output.needsRecheck, true);
  const calls = h.calls.length;
  await h.output.prepare();
  await h.flush();
  assert.equal(h.calls.length, calls);
  h.remount();
  await h.flush();
  assert.equal(h.output.needsRecheck, true);
  h.props.artifact = { ...h.props.artifact, sha256: 'd'.repeat(64) };
  h.render();
  await h.flush();
  assert.equal(h.output.needsRecheck, true);
  assert.equal(
    h.calls.length,
    calls,
    'Remount and revision changes do not silently reread or clear uncertainty',
  );
  h.control.state = { ...h.stateFor(), workspaceId: `workspace-${'f'.repeat(24)}` };
  await h.output.recheck();
  await h.flush();
  assert.equal(h.output.needsRecheck, true);
  h.control.state = h.stateFor();
  await h.output.recheck();
  await h.flush();
  assert.equal(h.output.needsRecheck, false);
  await h.output.prepare();
  await h.flush();
  assert.ok(h.output.preview);
});
test('unknown restore requires a matching retained record and unavailable reads cannot clear it', async () => {
  const h = quarantineHarness();
  h.props.action = 'restore';
  h.props.recordId = '12345678-1111-4111-8111-111111111111';
  await prepared(h);
  h.control.fail = 'apply';
  await h.output.apply();
  await h.flush();
  await h.output.recheck();
  await h.flush();
  assert.equal(h.output.needsRecheck, true, 'An absent restore record cannot resolve this write');
  const record = {
    id: h.props.recordId,
    artifact: h.props.artifact,
    createdAt: '2026-10-24T09:00:00.000Z',
    restoredAt: '2026-10-24T10:00:00.000Z',
    checkedAt: '2026-10-24T10:00:00.000Z',
    files: 1,
    bytes: 44,
    status: 'restored',
    original: 'same',
    payload: 'match',
  };
  h.control.state = h.stateFor([record]);
  h.control.bad = 'recheck';
  await h.output.recheck();
  await h.flush();
  assert.equal(h.output.needsRecheck, true);
  h.control.bad = '';
  await h.output.recheck();
  await h.flush();
  assert.equal(h.output.needsRecheck, false);
});
test('a late or malformed receipt never clears an aborted physical move uncertainty', async () => {
  const h = quarantineHarness();
  await prepared(h);
  h.control.hold = 'apply';
  const running = h.output.apply();
  await h.flush();
  await h.advance(35000);
  assert.equal(h.output.busy, null);
  assert.equal(h.output.needsRecheck, true);
  h.release();
  await running;
  await h.flush();
  assert.equal(h.completed.length, 0);
  assert.equal(h.output.needsRecheck, true);
});
test('source/locator replacement, changed connection and expired previews revoke consent', async () => {
  for (const mutate of [
    (h) => {
      h.props.artifact = {
        ...h.props.artifact,
        location: { label: 'review/notes', redacted: false },
      };
    },
    (h) => {
      h.platform.localContext = { workspace: { id: workspace } };
    },
  ]) {
    const h = quarantineHarness();
    await prepared(h);
    mutate(h);
    h.render();
    await h.flush();
    assert.equal(h.output.preview, null);
    assert.equal(h.output.acknowledged, false);
    await h.output.apply();
    assert.equal(h.completed.length, 0);
  }
  const h = quarantineHarness();
  await prepared(h);
  await h.advance(120001);
  assert.equal(h.output.preview, null);
  await h.output.apply();
  assert.equal(h.completed.length, 0);
});
test('late previews from an old selection and disabled or foreign workspace actions are refused', async () => {
  const h = quarantineHarness();
  h.render();
  h.control.hold = 'preview';
  const running = h.output.prepare();
  await h.flush();
  h.props.artifact = { ...h.props.artifact, sha256: 'd'.repeat(64) };
  h.render();
  await h.flush();
  h.release();
  await running;
  await h.flush();
  assert.equal(h.output.preview, null);
  h.props.disabled = true;
  h.render();
  await h.output.prepare();
  assert.equal(h.calls.length, 1);
  h.props.disabled = false;
  h.platform.localContext = { workspace: { id: `workspace-${'f'.repeat(24)}` } };
  h.render();
  await h.output.prepare();
  assert.equal(h.calls.length, 1);
});
test('only an explicit successful history recheck resolves an uncertain move across remounts', async () => {
  const h = quarantineHarness();
  await prepared(h);
  h.control.fail = 'apply';
  await h.output.apply();
  await h.flush();
  h.mountHistory();
  await h.flush();
  assert.ok(h.output.state);
  h.mountAction();
  await h.flush();
  assert.equal(h.output.needsRecheck, true, 'Automatic history reads do not clear uncertainty');
  h.mountHistory();
  await h.flush();
  await h.output.refresh();
  await h.flush();
  h.mountAction();
  await h.flush();
  assert.equal(h.output.needsRecheck, false);
});
test('unavailable or substituted record rechecks and malformed receipts retain uncertainty', async () => {
  const h = quarantineHarness();
  await prepared(h);
  const preview = h.output.preview;
  h.control.bad = 'apply';
  await h.output.apply();
  await h.flush();
  assert.equal(h.completed.length, 0);
  assert.equal(h.output.needsRecheck, true);
  h.control.state = { ...h.stateFor(), available: false, reason: 'vault-unavailable' };
  await h.output.recheck();
  await h.flush();
  assert.equal(h.output.needsRecheck, true);
  h.control.state = h.stateFor([
    {
      id: preview.recordId,
      artifact: { ...h.props.artifact, location: { label: 'review/notes', redacted: false } },
      createdAt: '2026-10-24T10:00:00.000Z',
      restoredAt: null,
      checkedAt: '2026-10-24T10:00:00.000Z',
      files: 1,
      bytes: 44,
      status: 'quarantined',
      original: 'absent',
      payload: 'match',
    },
  ]);
  await h.output.recheck();
  await h.flush();
  assert.equal(h.output.needsRecheck, true);
  h.control.state.records[0].artifact = h.props.artifact;
  await h.output.recheck();
  await h.flush();
  assert.equal(h.output.needsRecheck, false);
});
