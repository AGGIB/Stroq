import { jsonAction } from './control-http.mjs';

/** Fixed string/null/boolean scalars only, with duplicate decoded keys refused. */
export function parseWorkspaceMonitorJson(text) {
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('invalid-request');
  let at = 0;
  const space = () => {
    while (at < text.length && /[ \t\r\n]/.test(text[at])) at++;
  };
  const string = () => {
    if (text[at] !== '"') throw Error('invalid-request');
    const start = at++;
    while (at < text.length) {
      if (text[at] === '\\') at += 2;
      else if (text[at++] === '"') {
        const s = JSON.parse(text.slice(start, at));
        if (!s.isWellFormed()) throw Error('invalid-request');
        return s;
      }
    }
    throw Error('invalid-request');
  };
  space();
  if (text[at++] !== '{') throw Error('invalid-request');
  space();
  const keys = new Set();
  while (text[at] !== '}') {
    const key = string();
    if (keys.has(key)) throw Error('invalid-request');
    keys.add(key);
    space();
    if (text[at++] !== ':') throw Error('invalid-request');
    space();
    if (text[at] === '"') string();
    else if (text.startsWith('null', at)) at += 4;
    else if (text.startsWith('true', at)) at += 4;
    else if (text.startsWith('false', at)) at += 5;
    else throw Error('invalid-request');
    space();
    if (text[at] !== ',') break;
    at++;
    space();
  }
  if (text[at++] !== '}') throw Error('invalid-request');
  space();
  if (at !== text.length) throw Error('invalid-request');
  return value;
}
/** Outer server authenticates bearer, exact Host/Origin and Fetch-Site before dispatch. */
export async function routeWorkspaceMonitor(req, path, origin, service) {
  if (req.url.includes('?') || req.url.includes('#')) {
    req.resume();
    return { status: 400, body: { error: 'invalid-request' } };
  }
  if (path === '/api/workspace-monitor') {
    if (req.method !== 'GET') return { status: 405, body: { error: 'method-not-allowed' } };
    if (
      req.headers['transfer-encoding'] !== undefined ||
      (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0')
    ) {
      req.resume();
      return { status: 400, body: { error: 'invalid-request' } };
    }
    return service.state();
  }
  if (['/api/workspace-monitor/preview', '/api/workspace-monitor/apply'].includes(path))
    return jsonAction(
      req,
      origin,
      (input) => service[path.endsWith('/preview') ? 'preview' : 'apply'](input),
      4096,
      parseWorkspaceMonitorJson,
    );
  return { status: 404, body: { error: 'not-found' } };
}
