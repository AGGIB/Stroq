import { Worker } from 'node:worker_threads';

const ENTRY = new URL('../.local-engine/incident-recheck-engine.js', import.meta.url);
const ERRORS = new Set(['unsupported-evidence', 'policy-invalid', 'engine-failed']);

export function runIncidentRecheck(text, classes, { signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('server-stopped'));
    const worker = new Worker(ENTRY, {
      workerData: { text, classes },
      execArgv: [],
      env: {},
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32 },
      stdout: true,
      stderr: true,
    });
    worker.stdout.resume();
    worker.stderr.resume();
    let settled = false;
    const finish = async (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      await worker.terminate().catch(() => undefined);
      if (error) reject(new Error(error));
      else resolve(value);
    };
    const timer = setTimeout(() => finish('deadline-exceeded'), 8_000);
    const abort = () => finish('server-stopped');
    signal?.addEventListener('abort', abort, { once: true });
    worker.once('error', (error) =>
      finish(
        ['MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND'].includes(error.code)
          ? 'engine-unavailable'
          : 'engine-failed',
      ),
    );
    worker.once('exit', () => finish('engine-failed'));
    worker.once('message', (message) =>
      message?.ok === true
        ? finish(null, message.value)
        : finish(ERRORS.has(message?.error) ? message.error : 'engine-failed'),
    );
  });
}
