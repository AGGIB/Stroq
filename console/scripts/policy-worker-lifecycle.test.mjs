import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { stat } from 'node:fs/promises';
import { setImmediate as immediate } from 'node:timers/promises';
import { runPolicyAdapter } from './policy-worker.mjs';
class HeldWorker extends EventEmitter {
  stdout = { resume() {} };
  stderr = { resume() {} };
  calls = 0;
  terminate() {
    this.calls++;
    return new Promise((resolve) => {
      this.release = () => {
        this.emit('exit', 0);
        resolve(0);
      };
    });
  }
}
function start(operation = 'inspect', extra = {}) {
  const worker = new HeldWorker();
  let made = false;
  let settled = false;
  const pending = runPolicyAdapter(
    operation,
    null,
    { candidateText: null },
    {
      ...extra,
      createWorker: () => {
        made = true;
        return worker;
      },
    },
  );
  pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  return { worker, pending, made: () => made, settled: () => settled };
}
test('a successful result cannot release its caller until worker termination completes', async () => {
  const fixture = start();
  assert.equal(fixture.made(), true);
  fixture.worker.emit('message', { ok: true, value: { safe: true } });
  await immediate();
  assert.equal(fixture.worker.calls, 1);
  assert.equal(fixture.settled(), false);
  fixture.worker.release();
  assert.deepEqual(await fixture.pending, { safe: true });
});
test('worker failure and cancellation also wait for termination and redact unknown errors', async () => {
  for (const cancel of [false, true]) {
    const signal = new AbortController();
    const fixture = start('inspect', { signal: signal.signal });
    assert.equal(fixture.made(), true);
    const refused = assert.rejects(
      fixture.pending,
      new RegExp(cancel ? 'engine-unavailable' : 'engine-failed'),
    );
    if (cancel) signal.abort();
    else fixture.worker.emit('message', { ok: false, error: '/private/worker-error' });
    await immediate();
    assert.equal(fixture.settled(), false);
    fixture.worker.release();
    await refused;
  }
});
test('restore-preview receives its full 75 second deadline and waits for stop after timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fixture = start('restore-preview');
  assert.equal(fixture.made(), true);
  const refused = assert.rejects(fixture.pending, /deadline-exceeded/);
  t.mock.timers.tick(10001);
  assert.equal(fixture.worker.calls, 0);
  t.mock.timers.tick(64999);
  await immediate();
  assert.equal(fixture.worker.calls, 1);
  assert.equal(fixture.settled(), false);
  fixture.worker.release();
  await refused;
});

test('Try an action runs with a private scratch temp folder that is removed once the worker has stopped, and a short deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const worker = new HeldWorker();
  let options;
  const pending = runPolicyAdapter(
    'try-action',
    null,
    { kind: 'command', subject: 'ls' },
    {
      createWorker: (_entry, given) => {
        options = given;
        return worker;
      },
    },
  );
  const outcome = pending.then(
    () => 'resolved',
    (error) => error.message,
  );
  while (options === undefined) await immediate();
  const scratch = options.env.TMPDIR;
  assert.equal(options.env.TEMP, scratch);
  assert.equal(options.env.TMP, scratch);
  assert.ok((await stat(scratch)).isDirectory(), 'the folder exists while the worker runs');
  t.mock.timers.tick(3_999);
  await immediate();
  assert.equal(worker.calls, 0, 'not yet cut off');
  t.mock.timers.tick(1);
  await immediate();
  assert.equal(worker.calls, 1, 'cut off at four seconds');
  worker.release();
  assert.equal(await outcome, 'deadline-exceeded');
  await assert.rejects(stat(scratch), { code: 'ENOENT' });
});

test('other operations keep an empty worker environment and the longer deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const worker = new HeldWorker();
  let options;
  const pending = runPolicyAdapter('inspect', null, undefined, {
    createWorker: (_entry, given) => {
      options = given;
      return worker;
    },
  });
  const outcome = pending.then(
    () => 'resolved',
    (error) => error.message,
  );
  assert.deepEqual(options.env, {});
  t.mock.timers.tick(9_999);
  await immediate();
  assert.equal(worker.calls, 0);
  t.mock.timers.tick(1);
  await immediate();
  assert.equal(worker.calls, 1);
  worker.release();
  assert.equal(await outcome, 'deadline-exceeded');
});
