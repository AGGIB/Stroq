import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

const ENTRY = new URL('../.local-engine/policy-engine.js', import.meta.url);
const ERRORS = new Set([
  'policy-invalid',
  'invalid-request',
  'weakening-not-allowed',
  'no-changes',
  'engine-failed',
]);

/** One typed action is cheap to judge; a hostile one is cut off sooner than the longer operations. */
const TRY_DEADLINE_MS = 4_000;

/**
 * Raw YAML remains local to this worker; only the service keeps candidate bytes for apply.
 * Try an action gets a private scratch folder as the worker's temp folder, removed after the worker
 * has stopped, so a run that is cut off cannot leave its throwaway folders (which hold the typed
 * text) behind in the shared temp folder.
 */
export async function runPolicyAdapter(operation, text, changes, options = {}) {
  const scratch = operation === 'try-action' ? await mkdtemp(join(tmpdir(), 'stroq-try-')) : null;
  try {
    return await runInWorker(operation, text, changes, options, scratch);
  } finally {
    if (scratch !== null) await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

function runInWorker(
  operation,
  text,
  changes,
  {
    signal,
    cases = [],
    caseRevision = null,
    createWorker = (entry, options) => new Worker(entry, options),
  },
  scratch,
) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('engine-unavailable'));
    const worker = createWorker(ENTRY, {
      workerData: { operation, text, changes, cases, caseRevision },
      execArgv: [],
      env: scratch === null ? {} : { TMPDIR: scratch, TEMP: scratch, TMP: scratch },
      resourceLimits: { maxOldGenerationSizeMb: 256 },
      stdout: true,
      stderr: true,
    });
    worker.stdout.resume();
    worker.stderr.resume();
    const stopped = new Promise((done) => worker.once('exit', done));
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      // Callers may hold a policy lock: never release it while the worker can still run.
      void (async () => {
        let failure = error;
        try {
          await worker.terminate();
        } catch {
          failure = 'engine-failed';
        }
        await stopped;
        if (failure) reject(new Error(failure));
        else resolve(value);
      })();
    };
    const timer = setTimeout(
      () => finish('deadline-exceeded'),
      operation === 'preview' ||
        operation === 'restore-preview' ||
        operation === 'mcp-governance-preview'
        ? 75_000
        : operation === 'try-action'
          ? TRY_DEADLINE_MS
          : 10_000,
    );
    const abort = () => finish('engine-unavailable');
    signal?.addEventListener('abort', abort, { once: true });
    worker.once('error', (error) =>
      finish(error.code === 'MODULE_NOT_FOUND' ? 'engine-unavailable' : 'engine-failed'),
    );
    worker.once('exit', () => finish('engine-failed'));
    worker.once('message', (message) => {
      if (message?.ok === true) finish(null, message.value);
      else finish(ERRORS.has(message?.error) ? message.error : 'engine-failed');
    });
    if (signal?.aborted) abort();
  });
}

export function runPolicyCaseEvaluation(text, records, options) {
  return runPolicyAdapter('evaluate-cases', text, records, options);
}
