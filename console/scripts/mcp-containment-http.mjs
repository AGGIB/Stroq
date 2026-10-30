import { jsonAction } from './control-http.mjs';
import { parseMcpRequestJson } from './mcp-request-json.mjs';
import { parseFixedControlJson } from './workspace-monitor-bridge.mjs';

/** The outer server authenticates bearer, exact Host/Origin and Fetch-Site first. */
export async function routeMcpContainment(req, path, origin, service) {
  if (path === '/api/mcp-containment')
    return req.method === 'GET'
      ? service.state()
      : { status: 405, body: { error: 'method-not-allowed' } };
  if (path === '/api/mcp-containment/preview' || path === '/api/mcp-containment/apply')
    return jsonAction(
      req,
      origin,
      (input) => service[path.endsWith('/preview') ? 'preview' : 'apply'](input),
      4096,
      parseMcpRequestJson,
    );
  return { status: 404, body: { error: 'not-found' } };
}

export async function routeMcpToolContracts(req, path, origin, service) {
  if (req.url.includes('?') || req.url.includes('#')) {
    req.resume();
    return { status: 400, body: { error: 'invalid-request' } };
  }
  if (path === '/api/mcp-tool-contracts') {
    if (req.method !== 'GET') return { status: 405, body: { error: 'method-not-allowed' } };
    if (
      (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0') ||
      req.headers['transfer-encoding'] !== undefined
    ) {
      req.resume();
      return { status: 400, body: { error: 'invalid-request' } };
    }
    return service.state();
  }
  if (path === '/api/mcp-tool-contracts/preview' || path === '/api/mcp-tool-contracts/apply')
    return jsonAction(
      req,
      origin,
      (input) => service[path.endsWith('/preview') ? 'preview' : 'apply'](input),
      4096,
      parseMcpRequestJson,
    );
  return { status: 404, body: { error: 'not-found' } };
}

export async function routeMcpCallControls(req, path, origin, service) {
  if (req.url.includes('?') || req.url.includes('#')) {
    req.resume();
    return { status: 400, body: { error: 'invalid-request' } };
  }
  if (path === '/api/mcp-call-controls') {
    if (req.method !== 'GET') return { status: 405, body: { error: 'method-not-allowed' } };
    if (
      (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0') ||
      req.headers['transfer-encoding'] !== undefined
    ) {
      req.resume();
      return { status: 400, body: { error: 'invalid-request' } };
    }
    return service.state();
  }
  const action = path.slice('/api/mcp-call-controls/'.length);
  if (
    path === '/api/mcp-call-controls/' + action &&
    ['inspect', 'preview', 'apply', 'recheck'].includes(action)
  )
    return jsonAction(req, origin, (input) => service[action](input), 4096, parseFixedControlJson);
  return { status: 404, body: { error: 'not-found' } };
}
