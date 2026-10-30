import { jsonAction } from './control-http.mjs';
import { routeTaskAccess } from './task-access-http.mjs';
import { parseTaskLockPageJson } from './task-lock-pages.mjs';
import { parseFixedControlJson } from './workspace-monitor-bridge.mjs';
const ERROR_STATUS = new Map([
  ['task-lock-busy', 409],
  ['task-page-stale', 409],
  ['task-page-expired', 409],
  ['task-lookup-limit', 422],
  ['runtime-unavailable', 503],
  ['context-unavailable', 503],
  ['platform-unsupported', 422],
  ['task-lock-failed', 503],
  ['invalid-report', 503],
  ['unsafe-source', 503],
  ['invalid-request', 400],
  ['stale-evidence', 409],
  ['busy', 409],
  ['review-unavailable', 503],
  ['server-stopped', 503],
  ['unsupported-evidence', 422],
  ['policy-unavailable', 503],
  ['policy-invalid', 422],
  ['stale-policy', 409],
  ['deadline-exceeded', 504],
  ['engine-unavailable', 503],
  ['engine-failed', 503],
  ['workspace-review-busy', 409],
  ['history-unavailable', 503],
  ['baseline-unavailable', 503],
  ['stale-capture', 409],
  ['stale-baseline', 409],
  ['workspace-review-failed', 503],
]);
const noMethod = () => ({ status: 405, body: { error: 'method-not-allowed' } });
async function evidence(action) {
  try {
    return { status: 200, body: await action() };
  } catch (error) {
    const status = ERROR_STATUS.get(error?.message);
    return {
      status: status ?? 503,
      body: { error: status ? error.message : 'operation-unavailable' },
    };
  }
}
/** Called only after the outer server authenticates bearer, Host and request origin. */
export async function routeOperational(
  req,
  path,
  origin,
  {
    agents,
    incidents,
    live,
    secrets,
    comparisons,
    hookChecks,
    taskLocks,
    taskAccess,
    workspaceReview,
  },
) {
  if (path === '/api/workspace-review')
    return req.method === 'GET' ? evidence(() => workspaceReview.getState()) : noMethod();
  if (
    [
      '/api/workspace-review/check',
      '/api/workspace-review/cancel',
      '/api/workspace-review/review',
    ].includes(path)
  )
    return jsonAction(
      req,
      origin,
      (input) => workspaceReview[path.slice('/api/workspace-review/'.length)](input),
      4096,
    );
  if (path.startsWith('/api/task-locks/access/'))
    return routeTaskAccess(req, path, origin, taskAccess);
  if (path === '/api/task-locks')
    return req.method === 'GET' ? evidence(() => taskLocks.getState()) : noMethod();
  if (path === '/api/task-locks/page') {
    if (
      req.url?.includes('?') ||
      (req.method === 'GET' &&
        (req.headers['transfer-encoding'] !== undefined ||
          (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0')))
    ) {
      req.resume();
      return { status: 400, body: { error: 'invalid-request' } };
    }
    return req.method === 'GET'
      ? evidence(() => taskLocks.getPage())
      : jsonAction(req, origin, (input) => taskLocks.page(input), 4096, parseTaskLockPageJson);
  }
  if (['/api/task-locks/preview', '/api/task-locks/apply'].includes(path))
    return jsonAction(
      req,
      origin,
      (input) => taskLocks[path.slice('/api/task-locks/'.length)](input),
      4096,
    );
  if (path === '/api/hook-checks')
    return req.method === 'GET' ? evidence(() => hookChecks.getState()) : noMethod();
  if (path.startsWith('/api/hook-checks/jobs/')) {
    if (req.method !== 'GET') return noMethod();
    const id = path.slice('/api/hook-checks/jobs/'.length);
    const job = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id)
      ? hookChecks.getJob(id)
      : null;
    return job ? { status: 200, body: job } : { status: 404, body: { error: 'not-found' } };
  }
  if (
    ['/api/hook-checks/preview', '/api/hook-checks/start', '/api/hook-checks/cancel'].includes(path)
  )
    return jsonAction(
      req,
      origin,
      (input) => hookChecks[path.slice('/api/hook-checks/'.length)](input),
      4096,
    );
  if (path === '/api/agents') return req.method === 'GET' ? agents.read() : noMethod();
  if (path === '/api/incidents')
    return req.method === 'GET' ? evidence(() => incidents.read()) : noMethod();
  if (path === '/api/incidents/evidence') {
    if (typeof req.url !== 'string' || req.url.includes('?') || req.url.includes('#')) {
      req.resume();
      return { status: 400, body: { error: 'invalid-request' } };
    }
    return jsonAction(
      req,
      origin,
      (input) => evidence(() => incidents.explain(input)),
      4096,
      parseFixedControlJson,
    );
  }
  if (path === '/api/incidents/review' || path === '/api/incidents/verify') {
    const method = path.endsWith('/review') ? 'review' : 'verify';
    return jsonAction(req, origin, (input) => evidence(() => incidents[method](input)), 4096);
  }
  if (path === '/api/incidents/compare')
    return jsonAction(req, origin, (input) => evidence(() => comparisons.compare(input)), 4096);
  if (path === '/api/incidents/task')
    return jsonAction(req, origin, (input) => taskLocks.relateIncident(input), 4096);
  if (path === '/api/live')
    return req.method === 'GET' ? evidence(() => live.getState()) : noMethod();
  if (path.startsWith('/api/live/jobs/')) {
    if (req.method !== 'GET') return noMethod();
    const id = path.slice('/api/live/jobs/'.length);
    const job = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id) ? live.getJob(id) : null;
    return job ? { status: 200, body: job } : { status: 404, body: { error: 'not-found' } };
  }
  if (['/api/live/preview', '/api/live/start', '/api/live/cancel'].includes(path)) {
    return jsonAction(req, origin, (input) => live[path.slice('/api/live/'.length)](input), 4096);
  }
  if (path === '/api/secrets')
    return req.method === 'GET' ? evidence(() => secrets.getState()) : noMethod();
  if (path.startsWith('/api/secrets/jobs/')) {
    if (req.method !== 'GET') return noMethod();
    const id = path.slice('/api/secrets/jobs/'.length);
    const job = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id)
      ? secrets.getJob(id)
      : null;
    return job ? { status: 200, body: job } : { status: 404, body: { error: 'not-found' } };
  }
  if (['/api/secrets/preview', '/api/secrets/start', '/api/secrets/cancel'].includes(path))
    return jsonAction(
      req,
      origin,
      (input) => secrets[path.slice('/api/secrets/'.length)](input),
      4096,
    );
  return { status: 404, body: { error: 'not-found' } };
}
