import type { IncomingMessage } from 'node:http';
import { jsonAction } from './control-http.mjs';
import { parseWorkspaceMonitorJson } from './workspace-monitor-http.mjs';

type Response = { status: number; body: unknown };
type Service = {
  getState(): Promise<Response>;
  preview(input: unknown): Promise<Response>;
  apply(input: unknown): Promise<Response>;
  restorePreview(input: unknown): Promise<Response>;
  restore(input: unknown): Promise<Response>;
  recheck(input: unknown): Promise<Response>;
};
/** The outer local server also enforces authentication, exact Host and Origin. */
export async function routeWorkspaceTasks(
  req: IncomingMessage,
  path: string,
  origin: string,
  service: Service,
): Promise<Response> {
  if (typeof req.url !== 'string' || req.url.includes('?') || req.url.includes('#')) {
    req.resume();
    return { status: 400, body: { error: 'invalid-request' } };
  }
  if (path === '/api/workspace-task-controls') {
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
  const actions = {
    preview: 'preview',
    apply: 'apply',
    'restore-preview': 'restorePreview',
    restore: 'restore',
    recheck: 'recheck',
  } as const;
  for (const [suffix, method] of Object.entries(actions))
    if (path === `/api/workspace-task-controls/${suffix}`)
      return jsonAction(
        req,
        origin,
        (input: unknown) => service[method](input),
        4096,
        parseWorkspaceMonitorJson,
      );
  return { status: 404, body: { error: 'not-found' } };
}
