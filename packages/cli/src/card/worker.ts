// The workers of the card: `worker_threads` that run jobs (`jobs.ts`), and the same thing in this process.
//
// The CLI is one bundle, so a worker is this same file started again in a thread (`workerData` says
// what it is for), not a second program. The code at the bottom runs only in such a thread; loaded
// anywhere else (the CLI, a test) this file just exports what it has. A thread cannot start from
// TypeScript source (the tests, `tsx`): there the card runs its jobs in this process, which is slower
// and gives the same results.
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { handleJob, type CardJob, type CardResult } from './jobs.js';
import type { Channel } from './pool.js';

const ROLE = 'stroq-card-worker';
/** A worker that holds more than this much is stopped, and its jobs are lost: one huge transcript is one session. */
const WORKER_HEAP_MB = 1_536;

interface Request {
  readonly id: number;
  readonly job: CardJob;
}
interface Reply {
  readonly id: number;
  readonly result: CardResult;
}

/** Whether threads can be started from this file: only the built bundle can. */
export const canUseThreads = (): boolean =>
  process.env['STROQ_CARD_THREADS'] !== '0' && import.meta.url.endsWith('.js');

/** A worker thread, as the pool sees it. */
export function threadChannel(): Channel<CardJob, CardResult> {
  const worker = new Worker(fileURLToPath(import.meta.url), {
    workerData: { role: ROLE },
    resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB },
  });
  let failure: (reason: string) => void = () => undefined;
  let dead = false;
  const lose = (reason: string): void => {
    if (dead) return;
    dead = true;
    failure(reason);
  };
  worker.on('error', (err) => lose(err instanceof Error ? err.message : String(err)));
  worker.on('exit', (code) => lose(`worker exited with code ${code}`));
  return {
    send: (id, job) => worker.postMessage({ id, job } satisfies Request),
    onMessage: (callback) => {
      worker.on('message', (reply: Reply) => callback(reply.id, reply.result));
    },
    onFailure: (callback) => {
      failure = callback;
    },
    close: async () => {
      dead = true;
      await worker.terminate();
    },
  };
}

/**
 * The same, in this process: jobs run one after another, each a little later than it was sent, so that
 * the pool sees what it sees from a thread. A job that takes long holds the process; there is no one
 * to stop it.
 */
export function inProcessChannel(): Channel<CardJob, CardResult> {
  let message: (id: number, result: CardResult) => void = () => undefined;
  let closed = false;
  let chain: Promise<void> = Promise.resolve();
  return {
    send: (id, job) => {
      chain = chain.then(async () => {
        if (closed) return;
        const result = await handleJob(job);
        if (!closed) message(id, result);
      });
    },
    onMessage: (callback) => {
      message = callback;
    },
    onFailure: () => undefined,
    close: () => {
      closed = true;
      return Promise.resolve();
    },
  };
}

/** The channel to use: a thread when one can start, else this process. */
export const openChannel = (): Channel<CardJob, CardResult> =>
  canUseThreads() ? threadChannel() : inProcessChannel();

// -- Only in a worker thread started by `threadChannel` --------------------------------------------
const isWorkerStart = (): boolean =>
  !isMainThread &&
  parentPort !== null &&
  typeof workerData === 'object' &&
  workerData !== null &&
  (workerData as { role?: unknown }).role === ROLE;

if (isWorkerStart() && parentPort !== null) {
  const port = parentPort;
  port.on('message', (request: Request) => {
    void handleJob(request.job).then((result) => {
      port.postMessage({ id: request.id, result } satisfies Reply);
    });
  });
}
