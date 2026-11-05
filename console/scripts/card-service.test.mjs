import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCardService } from './card-service.mjs';

const presentation = { schema: 'stroq-card-view/1', owl: 'happy' };
function service(extra = {}) {
  let clock = Date.parse('2026-11-03T10:00:00.000Z');
  return createCardService({
    home: '/h/.stroq',
    userHome: '/h',
    project: '/h/project',
    environment: {},
    now: () => (clock += 1000),
    available: async () => ({ available: true, version: '0.29.0' }),
    present: async (raw) => (raw === 'bad' ? null : { ...presentation, raw }),
    run: async () => 'ok',
    ...extra,
  });
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('it starts idle, with no card made up', async () => {
  const card = await service();
  const state = await card.getState();
  assert.equal(state.schema, 'stroq-card-state/1');
  assert.equal(state.status, 'idle');
  assert.equal(state.result, null);
  assert.deepEqual(state.engine, { available: true, version: '0.29.0' });
  await card.close();
});

test('a run produces the presentation of the answer', async () => {
  const card = await service();
  const started = await card.start();
  assert.equal(started.status, 202);
  assert.equal(started.body.status, 'running');
  await settle();
  const state = await card.getState();
  assert.equal(state.status, 'done');
  assert.deepEqual(state.result, { ...presentation, raw: 'ok' });
  assert.match(state.finishedAt, /^2026-11-03T/);
  await card.close();
});

test('asking again while a run is going is the run that is going', async () => {
  let runs = 0;
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const card = await service({
    run: async () => {
      runs++;
      await gate;
      return 'late';
    },
  });
  await card.start();
  assert.equal((await card.start()).body.status, 'running');
  release();
  await settle();
  assert.equal(runs, 1);
  assert.equal((await card.getState()).status, 'done');
  await card.close();
});

test('the last card stays while the next is made, and a failed run does not erase it', async () => {
  let n = 0;
  let release;
  const card = await service({
    run: async () => {
      n++;
      if (n === 2) await new Promise((resolve) => (release = resolve));
      if (n === 3) throw new Error('deadline-exceeded');
      return `run-${n}`;
    },
  });
  await card.start();
  await settle();
  await card.start();
  const running = await card.getState();
  assert.equal(running.status, 'running');
  assert.equal(running.result.raw, 'run-1');
  release();
  await settle();
  assert.equal((await card.getState()).result.raw, 'run-2');
  await card.start();
  await settle();
  const failed = await card.getState();
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'deadline-exceeded');
  assert.equal(failed.result.raw, 'run-2');
  await card.close();
});

test('an answer the presentation refuses is reported, never shown', async () => {
  const card = await service({ run: async () => 'bad' });
  await card.start();
  await settle();
  const state = await card.getState();
  assert.equal(state.status, 'failed');
  assert.equal(state.error, 'invalid-report');
  assert.equal(state.result, null);
  await card.close();
});

test('an error with an unknown message is reported as a failed card, not repeated', async () => {
  const card = await service({
    run: async () => {
      throw new Error('/Users/someone/secret/path exploded');
    },
  });
  await card.start();
  await settle();
  const state = await card.getState();
  assert.equal(state.error, 'card-failed');
  assert.ok(!JSON.stringify(state).includes('someone'));
  await card.close();
});

test('without an engine it says so and runs nothing', async () => {
  let runs = 0;
  const card = await service({
    available: async () => ({ available: false, version: null }),
    run: async () => runs++,
  });
  const started = await card.start();
  assert.equal(started.body.status, 'failed');
  assert.equal(started.body.error, 'engine-unavailable');
  assert.equal(runs, 0);
  await card.close();
});

test('a stopped server starts nothing, and stops the run that is going', async () => {
  let aborted = false;
  const card = await service({
    run: ({ signal }) =>
      new Promise((_, reject) =>
        signal.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('cancelled'));
        }),
      ),
  });
  await card.start();
  await card.close();
  assert.equal(aborted, true);
  assert.deepEqual((await card.start()).body, { error: 'server-stopped' });
});
