import { parentPort, workerData } from 'node:worker_threads';
import { SESSION_TAINT_ERRORS } from '../lib/session-taint.ts';
import { checkDeadline, fail, type Options } from './session-taint-files.ts';
import { runSessionTaintWorker } from './session-taint-worker.ts';

interface Request {
  operation: `taint-${string}`;
  input?: Record<string, unknown>;
  options: Options;
}
interface Hooks {
  fault?: (stage: string, details: Record<string, unknown>) => Promise<void> | void;
}
const sha = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

/** Fixed session-taint controls only: no browser-selected path and no other operation. */
export async function runSessionTaintEngine(request: Request, hooks: Hooks = {}) {
  const { operation, options } = request;
  if (!options || !/^workspace-[a-f0-9]{24}$/.test(options.workspaceId))
    fail('context-unavailable');
  if ((options.platform ?? process.platform) === 'win32') fail('platform-unsupported');
  if (!sha(options.runtimeSha256) || typeof options.engineVersion !== 'string')
    fail('runtime-unavailable');
  checkDeadline(options);
  if (typeof operation === 'string' && operation.startsWith('taint-'))
    return runSessionTaintWorker(operation, request.input ?? {}, options, hooks.fault as any);
  return fail('invalid-report');
}

if (parentPort) {
  void runSessionTaintEngine(workerData as Request).then(
    (result) => parentPort?.postMessage({ type: 'result', result }),
    (error: unknown) => {
      const allowed: readonly string[] = [
        ...SESSION_TAINT_ERRORS,
        'runtime-unavailable',
        'context-unavailable',
        'platform-unsupported',
        'preview-stale',
        'deadline-exceeded',
        'write-unconfirmed',
        'unsafe-source',
        'invalid-report',
      ];
      parentPort?.postMessage({
        type: 'error',
        error:
          error instanceof Error && allowed.includes(error.message)
            ? error.message
            : 'worker-failed',
      });
    },
  );
}
