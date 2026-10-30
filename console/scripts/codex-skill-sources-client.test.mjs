import test from 'node:test';
import assert from 'node:assert/strict';
import { codexSourcesHarness } from './codex-skill-sources-client-harness.mjs';
import { codexSourcesFixture, workspace } from './codex-skill-sources-fixtures.mjs';
test('mount, StrictMode re-entry and elapsed time perform no source capture', async () => {
  const h = codexSourcesHarness();
  h.render();
  await h.flush();
  h.reenterEffects();
  await h.advance(600000);
  assert.equal(h.calls.length, 0);
  assert.equal(h.output.report, null);
  h.unmount();
});
test('one explicit inspection posts only an empty body and retains exact runtime-bound report', async () => {
  const h = codexSourcesHarness();
  h.render();
  await h.output.inspect();
  await h.flush();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].path, '/api/inventory/codex-sources');
  assert.deepEqual(h.calls[0].body, {});
  assert.deepEqual(JSON.parse(JSON.stringify(h.output.report)), codexSourcesFixture());
  assert.equal(h.output.historical, false);
  h.unmount();
});
test('an accepted configuration change marks captured source declarations historical without a new scan', async () => {
  const h = codexSourcesHarness();
  h.render();
  await h.output.inspect();
  await h.flush();
  h.output.markHistorical();
  await h.flush();
  assert.equal(h.output.historical, true);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(h.output.report)), codexSourcesFixture());
  h.unmount();
});
test('duplicate clicks serialize; closing aborts and ignored-abort replies cannot publish', async () => {
  const h = codexSourcesHarness();
  h.render();
  h.control.hold = true;
  const pending = h.output.inspect();
  await h.flush();
  await h.output.inspect();
  assert.equal(h.calls.length, 1);
  h.output.cancel();
  await h.flush();
  assert.equal(h.calls[0].signal.aborted, true);
  assert.equal(h.output.busy, false);
  h.release();
  await pending;
  await h.flush();
  assert.equal(h.output.report, null);
  h.unmount();
});
test('failed and malformed refresh retain prior same-context evidence as historical and allow retry', async () => {
  for (const failure of ['network', 'schema', 'workspace', 'runtime']) {
    const h = codexSourcesHarness();
    h.render();
    await h.output.inspect();
    await h.flush();
    if (failure === 'network') h.control.fail = true;
    else if (failure === 'schema') h.control.report.loaded = true;
    else if (failure === 'workspace') h.control.report.workspaceId = 'workspace-' + 'f'.repeat(24);
    else h.control.report.runtimeSha256 = 'invalid';
    await h.output.inspect();
    await h.flush();
    assert.equal(h.output.report.workspaceId, workspace);
    assert.equal(h.output.historical, true);
    assert.ok(h.output.error);
    assert.doesNotMatch(h.output.error, /PRIVATE|loaded/);
    h.control.fail = false;
    h.control.report = codexSourcesFixture();
    await h.output.inspect();
    await h.flush();
    assert.equal(h.output.historical, false);
    assert.equal(h.output.error, null);
    h.unmount();
  }
});
test('deadline ends busy, retains historical report and ignores a late response after retry', async () => {
  const h = codexSourcesHarness();
  h.render();
  await h.output.inspect();
  await h.flush();
  h.control.hold = true;
  const pending = h.output.inspect();
  await h.flush();
  await h.advance(30000);
  assert.equal(h.output.busy, false);
  assert.equal(h.output.historical, true);
  assert.ok(h.output.error);
  assert.equal(h.calls.at(-1).signal.aborted, true);
  h.control.hold = false;
  h.control.report = { ...codexSourcesFixture(), runtimeSha256: 'e'.repeat(64) };
  await h.output.inspect();
  await h.flush();
  h.release();
  await pending;
  await h.flush();
  assert.equal(h.output.report.runtimeSha256, 'e'.repeat(64));
  assert.equal(h.output.historical, false);
  h.unmount();
});
test('synchronous A→B→A workspace, context and transport changes invalidate old captures before effects', async () => {
  for (const change of ['workspace', 'context', 'transport']) {
    const h = codexSourcesHarness();
    h.render();
    h.control.hold = true;
    const pending = h.output.inspect();
    await h.flush();
    const context = h.platform.localContext,
      transport = h.platform.requestLocal;
    if (change === 'transport') h.platform.requestLocal = (...args) => transport(...args);
    else
      h.platform.localContext = {
        workspace: { id: change === 'workspace' ? 'workspace-' + 'f'.repeat(24) : workspace },
      };
    h.render(false);
    h.platform.localContext = context;
    h.platform.requestLocal = transport;
    h.render(false);
    h.release();
    await pending;
    h.render(false);
    assert.equal(h.output.report, null);
    await h.flush();
    h.unmount();
  }
});
test('lost access, missing context and retained handlers after unmount cannot send a request', async () => {
  const h = codexSourcesHarness();
  h.platform.localAccess = false;
  h.render();
  await h.output.inspect();
  assert.equal(h.calls.length, 0);
  h.platform.localAccess = true;
  h.platform.localContext = null;
  h.render();
  await h.output.inspect();
  assert.equal(h.calls.length, 0);
  h.platform.localContext = { workspace: { id: workspace } };
  h.render();
  const old = h.output;
  h.unmount();
  await old.inspect();
  assert.equal(h.calls.length, 0);
});
