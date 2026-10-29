import type { IncomingMessage } from 'node:http';
import { jsonAction } from './control-http.mjs';
import { parseWorkspaceMonitorJson } from './workspace-monitor-http.mjs';
type Result = { status: number; body: unknown };
type Service = {
  getState(): Promise<Result>;
  preview(input: unknown): Promise<Result>;
  apply(input: unknown): Promise<Result>;
  recheck(input: unknown): Promise<Result>;
};
/** Outer server owns authentication, exact Host and Fetch-Site checks. */
export async function routeIncidentAssessments(
  req: IncomingMessage,
  path: string,
  origin: string,
  service: Service,
): Promise<Result> {
  if (typeof req.url !== 'string' || req.url.includes('?') || req.url.includes('#')) {
    req.resume();
    return { status: 400, body: { error: 'invalid-request' } };
  }
  if (path === '/api/incident-assessments') {
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
  for (const method of ['preview', 'apply', 'recheck'] as const)
    if (path === `/api/incident-assessments/${method}`)
      return jsonAction(
        req,
        origin,
        (input: unknown) => service[method](input),
        4096,
        parseWorkspaceMonitorJson,
      );
  return { status: 404, body: { error: 'not-found' } };
}
