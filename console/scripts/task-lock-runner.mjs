import { lstat } from 'node:fs/promises';
import { serialize } from 'node:v8';
import { Worker } from 'node:worker_threads';
import { runtimeLayout } from './runtime-layout.mjs';

const MAX_REPLY = 8 * 1024 * 1024;
const closed = (v, keys) =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).length === keys.length &&
  keys.every((key) => Object.hasOwn(v, key));

/** Resolve only after termination, so the caller's real configuration lock outlives all writes. */
export async function executeTaskLock(operation, input, options) {
  const file = options.workerPath ?? runtimeLayout().adapter('task-lock-worker.js');
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16 * 1024 * 1024)
      throw new Error();
  } catch {
    throw new Error('runtime-unavailable');
  }
  if (options.signal?.aborted) throw new Error('server-stopped');
  const timeout = Math.max(100, Math.min(25_000, options.timeoutMs ?? 25_000));
  return new Promise((resolve, reject) => {
    let worker,
      timer,
      settled = false,
      output = 0;
    const abort = () => finish(new Error('server-stopped'));
    const finish = async (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      try {
        if (worker) await worker.terminate();
      } catch {
        error = new Error('task-lock-failed');
      }
      if (error) reject(error);
      else resolve(value);
    };
    try {
      worker = new Worker(file, {
        workerData: {
          operation,
          input,
          options: { ...options.context, deadline: Date.now() + timeout },
        },
        env: {},
        execArgv: [],
        stdout: true,
        stderr: true,
        resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 },
      });
      options.onStart?.();
    } catch {
      void finish(new Error('runtime-unavailable'));
      return;
    }
    timer = setTimeout(() => void finish(new Error('deadline-exceeded')), timeout);
    options.signal?.addEventListener('abort', abort, { once: true });
    const count = (chunk) => {
      output += chunk.length;
      if (output > 1024 * 1024) void finish(new Error('invalid-report'));
    };
    worker.stdout.on('data', count);
    worker.stderr.on('data', count);
    worker.once('error', () => void finish(new Error('task-lock-failed')));
    worker.once('exit', () => void finish(new Error('invalid-report')));
    worker.on('message', (message) => {
      try {
        if (serialize(message).byteLength > MAX_REPLY) throw new Error();
        if (closed(message, ['type', 'result']) && message.type === 'result')
          void finish(null, message.result);
        else if (
          closed(message, ['type', 'error']) &&
          message.type === 'error' &&
          typeof message.error === 'string' &&
          message.error.length <= 100
        )
          void finish(new Error(message.error));
        else throw new Error();
      } catch {
        void finish(new Error('invalid-report'));
      }
    });
    if (options.signal?.aborted) abort();
  });
}
