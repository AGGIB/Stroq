import test from 'node:test';
import assert from 'node:assert/strict';
import {
  monitorHarness,
  workspace,
  foreignWorkspace,
} from './workspace-monitor-client-harness.mjs';

function fixtures() {
  return {
    queue: true,
    state: () => ({
      '/api/workspace-task-controls': {
        schema: 'stroq-workspace-task-controls/1',
        workspaceId: workspace,
        generatedAt: '2026-10-24T00:00:00.000Z',
        available: true,
        history: 'missing',
        error: null,
        records: [],
      },
    }),
  };
}
async function start() {
  const h = monitorHarness(fixtures());
  h.render();
  await h.flush();
  return h;
}
test('Protection reads exact workspace task recovery without starting a change or capture', async () => {
  const h = await start();
  assert.equal(h.output.workspaceTasks?.workspaceId, workspace);
  assert.equal(h.output.workspaceTasks?.history, 'missing');
  assert.equal(h.calls.filter((call) => call.path === '/api/workspace-task-controls').length, 1);
  assert(h.calls.every((call) => call.body === undefined));
  const count = h.calls.length;
  await h.advance(600000);
  assert.equal(h.calls.length, count, 'task recovery never enables a background writer or check');
  h.unmount();
});
test('failed, malformed and foreign task history becomes an explicit gap after refresh', async () => {
  for (const kind of ['fail', 'bad', 'foreign']) {
    const h = await start();
    if (kind === 'foreign')
      h.control.state['/api/workspace-task-controls'].workspaceId = foreignWorkspace;
    else h.control[kind] = '/api/workspace-task-controls';
    await h.output.refresh();
    await h.flush();
    assert.equal(h.output.workspaceTasks, null);
    assert.match(h.output.error, /Task change history could not be refreshed/);
    h.unmount();
  }
});
test('pending task history loses current authority; a late reply after timeout cannot restore it', async () => {
  const h = await start();
  h.control.hold = '/api/workspace-task-controls';
  const pending = h.output.refresh();
  await h.flush();
  assert.equal(h.output.workspaceTasks, null);
  await h.advance(45000);
  assert.equal(h.output.loading, false);
  h.control.hold = '';
  h.release();
  await pending;
  await h.flush();
  assert.equal(h.output.workspaceTasks, null);
  await h.output.refresh();
  await h.flush();
  assert.equal(h.output.workspaceTasks?.workspaceId, workspace);
  h.unmount();
});
test('workspace, context and transport changes synchronously hide the former task history', async () => {
  for (const kind of ['workspace', 'context', 'transport']) {
    const h = await start();
    if (kind === 'transport') {
      const original = h.platform.requestLocal;
      h.platform.requestLocal = (...args) => original(...args);
    } else
      h.platform.localContext = {
        workspace: { id: kind === 'workspace' ? foreignWorkspace : workspace },
      };
    h.render(false);
    assert.equal(h.output.workspaceTasks, null);
    h.unmount();
  }
});
