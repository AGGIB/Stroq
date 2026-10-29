import test from 'node:test';
import assert from 'node:assert/strict';
import { monitorHarness } from './workspace-monitor-client-harness.mjs';
const state = () => ({
  schema: 'stroq-incident-assessments/1',
  scope: 'local-journal',
  generatedAt: '2026-10-24T00:00:00.000Z',
  history: 'missing',
  revision: null,
  records: [],
  canRecord: true,
  error: null,
});
async function start() {
  const h = monitorHarness({
    queue: true,
    state: () => ({ '/api/incident-assessments': state() }),
  });
  h.render();
  await h.flush();
  return h;
}
test('Protection reads bounded local journal assessments once without preview or apply', async () => {
  const h = await start();
  assert.equal(h.output.assessments?.history, 'missing');
  assert.equal(h.calls.filter((c) => c.path === '/api/incident-assessments').length, 1);
  assert(h.calls.every((c) => c.body === undefined));
  const count = h.calls.length;
  await h.advance(600000);
  assert.equal(h.calls.length, count);
  h.unmount();
});
test('failed or malformed summary refresh cannot retain an old assessment as current authority', async () => {
  for (const kind of ['fail', 'bad']) {
    const h = await start();
    h.control[kind] = '/api/incident-assessments';
    await h.output.refresh();
    await h.flush();
    assert.equal(h.output.assessments, null);
    assert.match(h.output.error, /Operator assessments could not be refreshed/);
    h.unmount();
  }
});
test('a held assessment read loses authority at timeout and a late ignored abort cannot restore it', async () => {
  const h = await start();
  h.control.hold = '/api/incident-assessments';
  const pending = h.output.refresh();
  await h.flush();
  assert.equal(h.output.assessments, null);
  await h.advance(45000);
  assert.equal(h.output.loading, false);
  h.control.hold = '';
  h.release();
  await pending;
  await h.flush();
  assert.equal(h.output.assessments, null);
  await h.output.refresh();
  await h.flush();
  assert.equal(h.output.assessments?.history, 'missing');
  h.unmount();
});
