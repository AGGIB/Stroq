import { jsonAction } from './control-http.mjs';

/** The server authenticates the bearer token and checks Host before this router. */
export async function routeAgentSetup(req, path, origin, setup) {
  if (path === '/api/agent-setup')
    return req.method === 'GET'
      ? { status: 200, body: setup.getState() }
      : { status: 405, body: { error: 'method-not-allowed' } };
  const action =
    path === '/api/agent-setup/preview'
      ? 'preview'
      : path === '/api/agent-setup/apply'
        ? 'apply'
        : null;
  if (action === null) return { status: 404, body: { error: 'not-found' } };
  return jsonAction(req, origin, (input) => setup[action](input), 4096);
}
