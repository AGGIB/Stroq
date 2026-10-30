import { Worker } from 'node:worker_threads';
import { lstat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { runtimeLayout } from './runtime-layout.mjs';
import { jsonAction } from './control-http.mjs';
import { parseFixedControlJson } from './workspace-monitor-bridge.mjs';

const ENTRY = new URL('../.local-engine/incidents-engine.js', import.meta.url);

let loading;
function assessmentAdapter() {
  loading ??= (async () => {
    const file = runtimeLayout().adapter('incidents-engine.js');
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 16 * 1024 * 1024)
      throw Error('runtime-unavailable');
    const engine = await import(pathToFileURL(file).href);
    if (
      typeof engine.createIncidentAssessmentService !== 'function' ||
      typeof engine.routeIncidentAssessments !== 'function'
    )
      throw Error('runtime-unavailable');
    return engine;
  })();
  return loading;
}
/** Fixed installed adapter only; a missing build grants no fallback annotation writer. */
export async function createIncidentAssessmentService(configuration = {}) {
  try {
    return await (await assessmentAdapter()).createIncidentAssessmentService(configuration);
  } catch {
    let stopped = false;
    const refused = async () => ({
      status: 503,
      body: { error: stopped ? 'server-stopped' : 'runtime-unavailable' },
    });
    return {
      getState: async () => ({
        status: 200,
        body: {
          schema: 'stroq-incident-assessments/1',
          scope: 'local-journal',
          generatedAt: new Date().toISOString(),
          history: 'unavailable',
          revision: null,
          records: [],
          canRecord: false,
          error: stopped ? 'server-stopped' : 'runtime-unavailable',
        },
      }),
      preview: refused,
      apply: refused,
      recheck: refused,
      close: async () => {
        stopped = true;
      },
    };
  }
}
export async function routeIncidentAssessments(req, path, origin, service) {
  let dispatch;
  try {
    dispatch = (await assessmentAdapter()).routeIncidentAssessments;
  } catch {
    if (typeof req.url !== 'string' || req.url.includes('?') || req.url.includes('#')) {
      req.resume();
      return { status: 400, body: { error: 'invalid-request' } };
    }
    if (path === '/api/incident-assessments') {
      if (req.method !== 'GET') return { status: 405, body: { error: 'method-not-allowed' } };
      if (
        req.headers['transfer-encoding'] !== undefined ||
        (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0')
      ) {
        req.resume();
        return { status: 400, body: { error: 'invalid-request' } };
      }
      return service.getState();
    }
    for (const method of ['preview', 'apply', 'recheck'])
      if (path === `/api/incident-assessments/${method}`)
        return jsonAction(
          req,
          origin,
          (input) => service[method](input),
          4096,
          parseFixedControlJson,
        );
    return { status: 404, body: { error: 'not-found' } };
  }
  return dispatch(req, path, origin, service);
}

/** Verify only the private captured file prepared by this service; no CLI or arbitrary runner. */
export function verifyIncidentJournal(path) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(ENTRY, {
      workerData: { path },
      execArgv: [],
      env: {},
      resourceLimits: { maxOldGenerationSizeMb: 256 },
      stdout: true,
      stderr: true,
    });
    worker.stdout.resume();
    worker.stderr.resume();
    let settled = false;
    const finish = async (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      await worker.terminate().catch(() => undefined);
      if (error) reject(new Error('engine-unavailable'));
      else resolve(result);
    };
    const timer = setTimeout(() => finish(true), 8000);
    worker.once('error', () => finish(true));
    worker.once('exit', () => finish(true));
    worker.once('message', (message) =>
      message?.ok === true ? finish(false, message.value) : finish(true),
    );
  });
}
