import test from 'node:test';
import assert from 'node:assert/strict';
import {
  harness,
  wa,
  wb,
  ta,
  tb,
  permit,
  policy,
  clone,
  uuid,
} from './task-lock-client-harness.mjs';
const check = (name, fn) => test(name, fn);
await check(
  'Overview and exact selection read once; opening never previews or applies',
  async () => {
    for (const selected of [false, true]) {
      const h = harness(selected);
      h.render();
      await h.flush();
      assert.equal(h.calls.length, 1);
      assert.equal(h.calls[0].path, '/api/task-locks/page');
      assert.deepEqual(
        clone(h.calls[0].body ?? null),
        selected ? { id: ta, expectedPermitSha256: null } : null,
      );
      assert.equal(h.output.preview, null);
      assert.equal(Boolean(h.output.task), selected);
      h.unmount();
    }
  },
);
await check(
  'Invalid, incomplete/foreign workspace links and disconnected context send nothing',
  async () => {
    for (const kind of ['invalid', 'foreign', 'disconnected']) {
      const h = harness();
      if (kind === 'invalid') await h.context({ invalid: true });
      if (kind === 'foreign') await h.context({ workspaceId: wb });
      if (kind === 'disconnected') await h.context({}, undefined, false);
      assert.equal(h.calls.length, 0);
      assert.equal(h.output.state, null);
      h.unmount();
    }
  },
);
await check('An exact missing task never resolves to another task', async () => {
  const h = harness();
  h.mode('missing-task');
  h.render();
  await h.flush();
  assert.equal(h.output.task, null);
  assert.equal(h.output.state, null);
  await h.prepare();
  assert.equal(h.calls.length, 1);
  h.unmount();
});
await check(
  'Explicit preview binds permit and exact acknowledgement; apply sends no grants',
  async () => {
    const h = harness();
    h.render();
    await h.flush();
    await h.prepare();
    assert.deepEqual(clone(h.calls.at(-1).body), { id: ta, expectedPermitSha256: permit });
    const preview = h.output.preview;
    await h.apply();
    assert.equal(h.calls.length, 2);
    h.output.acknowledge(true);
    await h.flush();
    await h.apply();
    assert.deepEqual(clone(h.calls.find((c) => c.path.endsWith('/apply')).body), {
      previewId: preview.id,
      acknowledgeTaskInterruption: true,
    });
    assert.equal(h.output.receipt.status, 'revoked');
    assert.equal(h.output.task.standing, 'revoked');
    assert.equal(h.output.needsRecheck, false);
    h.unmount();
  },
);
await check('Mismatched or private preview data is refused without action', async () => {
  for (const mode of [
    'wrong-preview-workspace',
    'wrong-preview-permit',
    'wrong-preview-scope',
    'private-preview',
  ]) {
    const h = harness();
    h.render();
    await h.flush();
    h.mode(mode);
    await h.prepare();
    assert.equal(h.output.preview, null);
    assert.ok(h.output.error);
    assert.ok(!h.output.error.includes('PRIVATE_FIXTURE'));
    h.unmount();
  }
});
await check(
  'Late previews are fenced by URL task, workspace, local access, refresh and connection',
  async () => {
    for (const kind of ['task', 'workspace', 'access', 'refresh', 'connection']) {
      const h = harness();
      h.render();
      await h.flush();
      h.mode('hold-preview');
      const pending = h.output.prepare();
      await h.flush();
      const signal = h.calls.at(-1).signal;
      h.mode('ok');
      if (kind === 'task') await h.context({ taskId: tb });
      else if (kind === 'workspace') await h.context({ workspaceId: wb }, wb);
      else if (kind === 'access') await h.context({}, undefined, false);
      else if (kind === 'refresh') {
        h.output.refresh();
        await h.flush();
      } else await h.reconnect();
      assert.equal(signal.aborted, true);
      h.release();
      await pending;
      await h.flush();
      assert.equal(h.output.preview, null);
      h.unmount();
    }
  },
);
await check(
  'Retained old handlers cannot preview/apply/refresh another context or abort its read',
  async () => {
    const h = harness();
    h.render();
    await h.flush();
    await h.prepare();
    h.output.acknowledge(true);
    await h.flush();
    const old = h.output;
    h.mode('hold-read');
    await h.context({ workspaceId: wb }, wb);
    const signal = h.calls.at(-1).signal,
      count = h.calls.length;
    await old.prepare();
    await old.apply();
    old.refresh();
    assert.equal(h.calls.length, count);
    assert.equal(signal.aborted, false);
    h.release();
    await h.flush();
    h.unmount();
  },
);
await check(
  'Acknowledgement cannot follow a superseded preview, even in the same task context',
  async () => {
    const h = harness();
    h.render();
    await h.flush();
    await h.prepare();
    h.output.acknowledge(true);
    await h.flush();
    const old = h.output;
    await h.prepare();
    assert.equal(h.output.acknowledged, false);
    const count = h.calls.length;
    old.acknowledge(true);
    await old.apply();
    await h.flush();
    assert.equal(h.calls.length, count);
    assert.equal(h.output.acknowledged, false);
    h.unmount();
  },
);
await check('Receipt mismatches never claim success and block further mutations', async () => {
  for (const mode of [
    'wrong-receipt-id',
    'wrong-receipt-permit',
    'foreign-receipt',
    'private-receipt',
  ]) {
    const h = harness();
    h.render();
    await h.flush();
    await h.prepare();
    h.output.acknowledge(true);
    await h.flush();
    h.mode(mode);
    await h.apply();
    assert.equal(h.output.receipt, null);
    assert.equal(h.output.needsRecheck, true);
    const count = h.calls.length;
    await h.prepare();
    await h.apply();
    assert.equal(h.calls.length, count);
    h.unmount();
  }
});
await check(
  'Unknown apply clears only after an explicit valid exact affected-permit read',
  async () => {
    for (const mode of ['failed-read', 'foreign-read', 'unavailable-read']) {
      const h = harness();
      h.render();
      await h.flush();
      await h.prepare();
      h.output.acknowledge(true);
      await h.flush();
      h.mode('wrong-receipt-id');
      await h.apply();
      await h.context({ expectedPermitSha256: permit });
      assert.equal(h.output.needsRecheck, true);
      h.mode(mode);
      h.output.refresh();
      await h.flush();
      assert.equal(h.output.needsRecheck, true);
      h.mode('ok');
      h.output.refresh();
      await h.flush();
      assert.equal(h.output.needsRecheck, false);
      assert.equal(h.output.task.standing, 'revoked');
      assert.equal(h.output.receipt, null);
      h.unmount();
    }
  },
);
await check(
  'Abort-ignoring read and preview deadlines clear visible busy and refuse late data',
  async () => {
    for (const mode of ['hold-read', 'hold-preview']) {
      const h = harness();
      if (mode === 'hold-read') h.mode(mode);
      h.render();
      await h.flush();
      let pending;
      if (mode === 'hold-preview') {
        h.mode(mode);
        pending = h.output.prepare();
        await h.flush();
      }
      await h.advance(25000);
      assert.equal(h.output.busy, null);
      assert.match(h.output.error, /timed out/);
      h.release();
      await pending;
      await h.flush();
      assert.equal(h.output.preview, null);
      if (mode === 'hold-read') assert.equal(h.output.state, null);
      h.unmount();
    }
  },
);
await check(
  'Abort-ignoring apply timeout remains unknown, recheck does not accept a late receipt',
  async () => {
    const h = harness();
    h.render();
    await h.flush();
    await h.prepare();
    h.output.acknowledge(true);
    await h.flush();
    h.mode('hold-apply');
    const pending = h.output.apply();
    await h.flush();
    await h.advance(25000);
    assert.equal(h.output.busy, null);
    assert.equal(h.output.needsRecheck, true);
    h.mode('ok');
    await h.context({ expectedPermitSha256: permit });
    assert.equal(h.output.needsRecheck, true);
    h.output.refresh();
    await h.flush();
    assert.equal(h.output.needsRecheck, false);
    h.release();
    await pending;
    await h.flush();
    assert.equal(h.output.receipt, null);
    h.unmount();
  },
);
await check(
  'Navigation away during apply preserves uncertainty; automatic reads cannot clear it',
  async () => {
    const h = harness();
    h.render();
    await h.flush();
    await h.prepare();
    h.output.acknowledge(true);
    await h.flush();
    h.mode('hold-apply');
    const pending = h.output.apply();
    await h.flush();
    const signal = h.calls.at(-1).signal;
    h.mode('ok');
    await h.context({ requested: false, taskId: null, workspaceId: null });
    assert.equal(signal.aborted, true);
    assert.equal(h.output.needsRecheck, true);
    h.release();
    await pending;
    await h.flush();
    await h.context({ requested: true, taskId: ta, workspaceId: wa, expectedPermitSha256: permit });
    assert.equal(h.output.needsRecheck, true);
    assert.equal(h.output.receipt, null);
    h.output.refresh();
    await h.flush();
    assert.equal(h.output.needsRecheck, false);
    h.unmount();
  },
);
await check(
  'Verified receipt survives a failed follow-up refresh without being relabeled unknown',
  async () => {
    const h = harness();
    h.render();
    await h.flush();
    await h.prepare();
    h.output.acknowledge(true);
    await h.flush();
    h.mode('hold-read-failure');
    await h.apply();
    assert.ok(h.output.receipt);
    assert.ok(h.output.receiptTask);
    assert.equal(h.output.busy, 'load');
    h.release();
    await h.flush();
    assert.ok(h.output.receipt);
    assert.equal(h.output.needsRecheck, false);
    assert.ok(h.output.error);
    h.unmount();
  },
);
await check('Receipt is cleared on close/reopen navigation and connection changes', async () => {
  for (const kind of ['navigation', 'connection']) {
    const h = harness();
    h.render();
    await h.flush();
    await h.prepare();
    h.output.acknowledge(true);
    await h.flush();
    await h.apply();
    assert.ok(h.output.receipt);
    if (kind === 'navigation') {
      await h.context({ requested: false, taskId: null, workspaceId: null });
      await h.context({ requested: true, taskId: ta, workspaceId: wa });
    } else await h.reconnect();
    assert.equal(h.output.receipt, null);
    assert.equal(h.output.task.standing, 'revoked');
    h.unmount();
  }
});
await check('Preview expiry removes consent and permits no automatic mutation', async () => {
  const h = harness();
  h.render();
  await h.flush();
  await h.prepare();
  h.output.acknowledge(true);
  await h.flush();
  const count = h.calls.length;
  await h.advance(120000);
  assert.equal(h.output.preview, null);
  assert.equal(h.output.acknowledged, false);
  await h.apply();
  assert.equal(h.calls.length, count);
  h.unmount();
});
await check('Unmount aborts apply and its late receipt cannot publish success', async () => {
  const h = harness();
  h.render();
  await h.flush();
  await h.prepare();
  h.output.acknowledge(true);
  await h.flush();
  h.mode('hold-apply');
  const pending = h.output.apply();
  await h.flush();
  const signal = h.calls.at(-1).signal;
  h.unmount();
  assert.equal(signal.aborted, true);
  h.release();
  await pending;
  await h.flush();
  assert.equal(h.output.receipt, null);
});
await check(
  'A fresh contradictory standing replaces the receipt success view with an explicit mismatch',
  async () => {
    const h = harness();
    h.render();
    await h.flush();
    await h.prepare();
    h.output.acknowledge(true);
    await h.flush();
    h.mode('reappeared-read');
    await h.apply();
    assert.equal(h.output.task.standing, 'present');
    assert.equal(h.output.receipt, null);
    assert.match(h.output.error, /no longer matches/);
    h.unmount();
  },
);

await check(
  'Matching captured permit handoff selects exact row; replacement SHA blocks preview instead of substituting current permit',
  async () => {
    for (const mismatch of [false, true]) {
      const h = harness();
      await h.context({
        expectedPermitSha256: mismatch ? '2'.repeat(64) : permit,
        originIncidentId: 'incident-' + '3'.repeat(64),
      });
      assert.equal(h.output.permitMismatch, mismatch);
      assert.equal(Boolean(h.output.task), !mismatch);
      const count = h.calls.length;
      await h.prepare();
      assert.equal(h.calls.length, count + (mismatch ? 0 : 1));
      h.unmount();
    }
  },
);
await check(
  'Permit-only and origin-only URL changes synchronously invalidate capture/preview/ack before passive effects',
  async () => {
    for (const field of ['expectedPermitSha256', 'originIncidentId']) {
      const h = harness();
      h.render();
      await h.flush();
      await h.prepare();
      h.output.acknowledge(true);
      await h.flush();
      const old = h.output;
      await h.routeImmediate({
        [field]: field === 'expectedPermitSha256' ? permit : 'incident-' + '3'.repeat(64),
      });
      assert.equal(h.output.state, null, field);
      assert.equal(h.output.preview, null, field);
      assert.equal(h.output.acknowledged, false, field);
      const count = h.calls.length;
      await old.prepare();
      await old.apply();
      old.refresh();
      assert.equal(h.calls.length, count, field);
      h.unmount();
    }
  },
);
await check(
  'A→B→A route before passive cleanup cannot resurrect acknowledged preview or old apply handler',
  async () => {
    const h = harness();
    h.render();
    await h.flush();
    await h.prepare();
    h.output.acknowledge(true);
    await h.flush();
    const old = h.output;
    await h.routeImmediate({
      originIncidentId: 'incident-' + '3'.repeat(64),
      expectedPermitSha256: permit,
    });
    await h.routeImmediate({ originIncidentId: null, expectedPermitSha256: null });
    assert.equal(h.output.state, null);
    assert.equal(h.output.preview, null);
    assert.equal(h.output.acknowledged, false);
    const count = h.calls.length;
    await old.apply();
    await old.prepare();
    assert.equal(h.calls.length, count);
    h.unmount();
  },
);
await check('Late previews from permit-only/origin-only navigation are discarded', async () => {
  for (const field of ['expectedPermitSha256', 'originIncidentId']) {
    const h = harness();
    h.render();
    await h.flush();
    h.mode('hold-preview');
    const pending = h.output.prepare();
    await h.flush();
    h.mode('ok');
    await h.context({
      [field]: field === 'expectedPermitSha256' ? permit : 'incident-' + '3'.repeat(64),
    });
    assert.equal(h.calls.find((c) => c.path.endsWith('/preview')).signal.aborted, true);
    h.release();
    await pending;
    await h.flush();
    assert.equal(h.output.preview, null);
    assert.equal(h.output.acknowledged, false);
    h.unmount();
  }
});
await check(
  'Origin-only navigation during apply preserves uncertainty and rejects late receipt',
  async () => {
    const h = harness();
    h.render();
    await h.flush();
    await h.prepare();
    h.output.acknowledge(true);
    await h.flush();
    h.mode('hold-apply');
    const pending = h.output.apply();
    await h.flush();
    h.mode('ok');
    await h.context({
      expectedPermitSha256: permit,
      originIncidentId: 'incident-' + '3'.repeat(64),
    });
    assert.equal(h.output.needsRecheck, true);
    assert.equal(h.output.receipt, null);
    h.release();
    await pending;
    await h.flush();
    assert.equal(h.output.receipt, null);
    assert.equal(h.output.needsRecheck, true);
    h.output.refresh();
    await h.flush();
    assert.equal(h.output.needsRecheck, false);
    h.unmount();
  },
);
await check(
  'Same workspace reconnected context fences a pending preview and retained handlers',
  async () => {
    const h = harness();
    h.render();
    await h.flush();
    h.mode('hold-preview');
    const pending = h.output.prepare();
    await h.flush();
    const old = h.output;
    h.mode('ok');
    await h.reconnectContext();
    assert.equal(h.calls.find((c) => c.path.endsWith('/preview')).signal.aborted, true);
    const count = h.calls.length;
    await old.prepare();
    await old.apply();
    assert.equal(h.calls.length, count);
    h.release();
    await pending;
    await h.flush();
    assert.equal(h.output.preview, null);
    h.unmount();
  },
);
