import { jsonAction } from './control-http.mjs';
import { parseMcpRequestJson } from './mcp-request-json.mjs';

/** The outer server authenticates the local bearer and Host before dispatch. */
export function routeTaskAccess(req, path, origin, service) {
  if (path === '/api/task-locks/access/preview' || path === '/api/task-locks/access/issue')
    return jsonAction(
      req,
      origin,
      (input) => service[path.endsWith('/preview') ? 'preview' : 'issue'](input),
      4096,
      parseMcpRequestJson,
    );
  if (path.startsWith('/api/task-locks/access/')) {
    if (req.method !== 'GET') return { status: 405, body: { error: 'method-not-allowed' } };
    const match = /^\/api\/task-locks\/access\/(task-[a-f0-9]{64})\/([a-f0-9]{64})$/.exec(path);
    return match
      ? service.getState({ id: match[1], expectedPermitSha256: match[2] })
      : { status: 404, body: { error: 'not-found' } };
  }
  return { status: 404, body: { error: 'not-found' } };
}
