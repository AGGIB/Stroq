import type { IncomingMessage } from 'node:http';

type Response = { status: number; body: unknown };
type Posture = { audit(): Promise<Response> };

/** Authentication and exact Host/Origin checks also run in the outer local server. */
export async function routePosture(
  req: IncomingMessage,
  path: string,
  _origin: string,
  service: Posture,
): Promise<Response> {
  if (typeof req.url !== 'string' || req.url.includes('?') || req.url.includes('#')) {
    req.resume();
    return { status: 400, body: { error: 'invalid-request' } };
  }
  if (path !== '/api/posture') return { status: 404, body: { error: 'not-found' } };
  if (req.method !== 'GET') return { status: 405, body: { error: 'method-not-allowed' } };
  if (
    req.headers['transfer-encoding'] !== undefined ||
    (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0')
  ) {
    req.resume();
    return { status: 400, body: { error: 'invalid-request' } };
  }
  return service.audit();
}
