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
  'Opaque cursor navigation visits beyond first64 and Back/First reread rather than merge pages',
  async () => {
    const h = harness(false);
    h.mode('pages');
    h.render();
    await h.flush();
    assert.equal(h.output.page.page.index, 1);
    assert.equal(h.output.state.tasks[0].id, tb);
    h.output.nextPage();
    await h.flush();
    assert.equal(h.output.page.page.index, 2);
    assert.equal(h.output.state.tasks[0].id, ta);
    assert.equal(h.output.state.coverage.complete, false);
    assert.deepEqual(clone(h.calls.at(-1).body), { cursor: uuid(500) });
    assert.equal(h.output.canGoBack, true);
    h.output.nextPage();
    await h.flush();
    assert.equal(h.output.page.page.index, 3);
    h.output.previousPage();
    await h.flush();
    assert.equal(h.output.page.page.index, 2);
    assert.deepEqual(clone(h.calls.at(-1).body), { cursor: uuid(500) });
    h.output.firstPage();
    await h.flush();
    assert.equal(h.output.page.page.index, 1);
    assert.equal(h.calls.at(-1).body, undefined);
    assert.equal(
      h.calls.some((c) => c.path.endsWith('/preview') || c.path.endsWith('/apply')),
      false,
    );
    h.unmount();
  },
);
await check(
  'Exact current and versioned links open containing page beyond64 using only opaque task+SHA',
  async () => {
    for (const expectedPermitSha256 of [null, permit]) {
      const h = harness();
      h.mode('pages');
      await h.context({ expectedPermitSha256 });
      assert.deepEqual(clone(h.calls[0].body), { id: ta, expectedPermitSha256 });
      assert.equal(h.output.page.page.index, 2);
      assert.equal(h.output.task.id, ta);
      assert.equal(h.calls.length, 1);
      await h.prepare();
      assert.deepEqual(clone(h.calls.at(-1).body), { id: ta, expectedPermitSha256: permit });
      h.unmount();
    }
  },
);
await check(
  'Stale/expired cursor and hard-bound lookup failures are gaps with first-page recovery',
  async () => {
    for (const mode of ['page-stale', 'page-expired', 'lookup-limit']) {
      const h = harness(false);
      h.mode('pages');
      h.render();
      await h.flush();
      h.mode(mode);
      h.output.nextPage();
      await h.flush();
      assert.equal(h.output.state, null);
      assert.equal(h.output.task, null);
      assert.equal(h.output.canResetPage, true);
      assert.ok(h.output.error);
      if (mode === 'lookup-limit') assert.match(h.output.error, /limit|absence|beyond/i);
      h.mode('ok');
      h.output.firstPage();
      await h.flush();
      assert.equal(h.output.page.page.index, 1);
      assert.equal(h.output.error, null);
      h.unmount();
    }
  },
);
await check(
  'Private catalog metadata and foreign wrappers are not accepted as page state',
  async () => {
    for (const mode of ['private-page', 'foreign-read']) {
      const h = harness(false);
      h.mode(mode);
      h.render();
      await h.flush();
      assert.equal(h.output.state, null);
      assert.ok(h.output.error);
      assert.ok(!h.output.error.includes('PRIVATE_FIXTURE'));
      h.unmount();
    }
  },
);
await check(
  'Page navigation synchronously clears preview/consent and fences old apply before route rerender',
  async () => {
    const h = harness();
    h.mode('pages');
    h.render();
    await h.flush();
    await h.prepare();
    h.output.acknowledge(true);
    await h.flush();
    const old = h.output;
    h.output.nextPage();
    const count = h.calls.length;
    await old.apply();
    await old.prepare();
    old.refresh();
    old.previousPage();
    assert.equal(h.calls.length, count);
    await h.context({
      requested: false,
      taskId: null,
      workspaceId: null,
      expectedPermitSha256: null,
    });
    assert.equal(h.output.preview, null);
    assert.equal(h.output.acknowledged, false);
    assert.equal(h.output.page.page.index, 3);
    h.unmount();
  },
);
await check(
  'Retained next/back/first/refresh cannot abort or replace a newer context read',
  async () => {
    const h = harness(false);
    h.mode('pages');
    h.render();
    await h.flush();
    const old = h.output;
    h.mode('hold-read');
    await h.context({}, wb);
    const signal = h.calls.at(-1).signal,
      count = h.calls.length;
    old.nextPage();
    old.previousPage();
    old.firstPage();
    old.refresh();
    assert.equal(h.calls.length, count);
    assert.equal(signal.aborted, false);
    h.release();
    await h.flush();
    h.unmount();
  },
);
await check(
  'Unmount rejects retained page/preview/apply handlers; StrictMode re-entry starts a fresh read',
  async () => {
    const h = harness(false);
    h.mode('pages');
    h.render();
    await h.flush();
    const before = h.calls.length;
    await h.strictCycle();
    assert.equal(h.calls.length, before + 1);
    assert.ok(h.output.state);
    const old = h.output;
    h.unmount();
    const count = h.calls.length;
    old.firstPage();
    old.nextPage();
    old.previousPage();
    old.refresh();
    await old.prepare();
    await old.apply();
    assert.equal(h.calls.length, count);
  },
);
await check('Ignored late page response cannot replace a newer first-page read', async () => {
  const h = harness(false);
  h.mode('pages');
  h.render();
  await h.flush();
  h.mode('hold-page');
  h.output.nextPage();
  await h.flush();
  h.mode('ok');
  h.output.firstPage();
  await h.flush();
  assert.equal(h.output.page.page.index, 1);
  h.release();
  await h.flush();
  assert.equal(h.output.page.page.index, 1);
  h.unmount();
});

await check(
  'Unknown later-page revocation cannot be cleared by refreshing an unrelated available first page',
  async () => {
    const h = harness();
    h.mode('pages');
    h.render();
    await h.flush();
    await h.prepare();
    h.output.acknowledge(true);
    await h.flush();
    h.mode('wrong-receipt-id');
    await h.apply();
    assert.equal(h.output.needsRecheck, true);
    h.mode('pages');
    h.output.firstPage();
    await h.context({
      requested: false,
      taskId: null,
      workspaceId: null,
      expectedPermitSha256: null,
    });
    assert.equal(h.output.page.page.index, 1);
    assert.equal(
      h.output.state.tasks.some((row) => row.id === ta),
      false,
    );
    h.output.refresh();
    await h.flush();
    assert.equal(
      h.output.needsRecheck,
      true,
      'An unrelated page cannot resolve the affected permit',
    );
    assert.equal(h.output.unknownTask.id, ta);
    assert.equal(h.output.unknownTask.permitSha256, permit);
    await h.context({ requested: true, taskId: ta, workspaceId: wa, expectedPermitSha256: permit });
    assert.equal(
      h.output.needsRecheck,
      true,
      'Opening the affected permission is read-only, not explicit recheck',
    );
    h.output.refresh();
    await h.flush();
    assert.equal(h.output.needsRecheck, false);
    assert.equal(h.output.task.standing, 'revoked');
    h.unmount();
  },
);
