import type { IncomingMessage } from 'node:http';
import { jsonAction } from './control-http.mjs';
import { parseWorkspaceMonitorJson } from './workspace-monitor-http.mjs';

type Response = { status: number; body: unknown };
type Monitor = {
  state(): Promise<Response>;
  preview(input: unknown): Promise<Response>;
  apply(input: unknown): Promise<Response>;
};
/** Authentication and exact Host/Origin checks also run in the outer local server. */
export async function routeInventoryMonitor(
  req: IncomingMessage,
  path: string,
  origin: string,
  service: Monitor,
): Promise<Response> {
  if (typeof req.url !== 'string' || req.url.includes('?') || req.url.includes('#')) {
    req.resume();
    return { status: 400, body: { error: 'invalid-request' } };
  }
  if (path === '/api/inventory-monitor') {
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
  if (['/api/inventory-monitor/preview', '/api/inventory-monitor/apply'].includes(path))
    return jsonAction(
      req,
      origin,
      (input: unknown) => service[path.endsWith('/preview') ? 'preview' : 'apply'](input),
      4096,
      parseWorkspaceMonitorJson,
    );
  return { status: 404, body: { error: 'not-found' } };
}
