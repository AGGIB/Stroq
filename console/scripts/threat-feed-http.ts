import type { IncomingMessage } from 'node:http';
import { jsonAction } from './control-http.mjs';
import { parseWorkspaceMonitorJson } from './workspace-monitor-http.mjs';

type Response = { status: number; body: unknown };
type ThreatFeed = { read(input: unknown): Promise<Response> };

/** Authentication and exact Host/Origin checks also run in the outer local server. */
export async function routeThreatFeed(
  req: IncomingMessage,
  path: string,
  origin: string,
  service: ThreatFeed,
): Promise<Response> {
  if (typeof req.url !== 'string' || req.url.includes('?') || req.url.includes('#')) {
    req.resume();
    return { status: 400, body: { error: 'invalid-request' } };
  }
  if (path !== '/api/threats') return { status: 404, body: { error: 'not-found' } };
  // A POST that names the source, from the page itself: a plain load or a link never downloads.
  return jsonAction(
    req,
    origin,
    (input: unknown) => service.read(input),
    1024,
    parseWorkspaceMonitorJson,
  );
}
