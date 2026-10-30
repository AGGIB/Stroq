import type { IncomingMessage } from 'node:http';
import { jsonAction } from './control-http.mjs';
import { parseWorkspaceMonitorJson } from './workspace-monitor-http.mjs';

type Response = { status: number; body: unknown };
type JournalView = {
  tail(input: unknown): Promise<Response>;
  summary(): Promise<Response>;
  since(input: unknown): Promise<Response>;
};

/** Authentication and exact Host/Origin checks also run in the outer local server. */
export async function routeJournalView(
  req: IncomingMessage,
  path: string,
  origin: string,
  service: JournalView,
): Promise<Response> {
  if (typeof req.url !== 'string' || req.url.includes('?') || req.url.includes('#')) {
    req.resume();
    return { status: 400, body: { error: 'invalid-request' } };
  }
  if (path === '/api/journal/summary') {
    if (req.method !== 'GET') return { status: 405, body: { error: 'method-not-allowed' } };
    if (
      req.headers['transfer-encoding'] !== undefined ||
      (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0')
    ) {
      req.resume();
      return { status: 400, body: { error: 'invalid-request' } };
    }
    return service.summary();
  }
  // A read that takes a cursor in its body: a POST, like the other cursor reads, so nothing rides in a URL.
  if (path === '/api/journal/tail')
    return jsonAction(
      req,
      origin,
      (input: unknown) => service.tail(input),
      4096,
      parseWorkspaceMonitorJson,
    );
  // And one that takes a moment (the page's last visit), for the same reason.
  if (path === '/api/journal/since')
    return jsonAction(
      req,
      origin,
      (input: unknown) => service.since(input),
      4096,
      parseWorkspaceMonitorJson,
    );
  return { status: 404, body: { error: 'not-found' } };
}
