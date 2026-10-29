import type { IncomingMessage } from 'node:http';
import { jsonAction } from './control-http.mjs';
import { parseWorkspaceMonitorJson } from './workspace-monitor-http.mjs';

type Response = { status: number; body: unknown };
type Service = {
  getState(): Promise<Response>;
  inspect(input: unknown): Promise<Response>;
  preview(input: unknown): Promise<Response>;
  clear(input: unknown): Promise<Response>;
  recheck(input: unknown): Promise<Response>;
};
/** Authentication and exact Host checks run in the outer local server. */
export async function routeSessionTaint(
  req: IncomingMessage,
  path: string,
  origin: string,
  service: Service,
): Promise<Response> {
  if (typeof req.url !== 'string' || req.url.includes('?') || req.url.includes('#')) {
    req.resume();
    return { status: 400, body: { error: 'invalid-request' } };
  }
  if (path === '/api/session-taint') {
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
  for (const method of ['inspect', 'preview', 'clear', 'recheck'] as const)
    if (path === `/api/session-taint/${method}`)
      return jsonAction(
        req,
        origin,
        (input: unknown) => service[method](input),
        4096,
        parseWorkspaceMonitorJson,
      );
  return { status: 404, body: { error: 'not-found' } };
}
