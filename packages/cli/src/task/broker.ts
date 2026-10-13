import { createServer, request } from 'node:http';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import type { StroqEngine } from '@stroq/core';
import { denyOutput, handleClaudeHook, type HookOutput } from '../adapters/claude-code.js';
import { withDeadline } from '../commands/hook.js';

const MAX_BYTES = 1_048_576;
const FAILURE = 'Task Lock: the parent controller is unavailable; every tool is refused.';

/** The parent owns all trusted state. This endpoint evaluates hooks; it cannot issue permits. */
export async function startTaskBroker(
  engine: StroqEngine,
  token: string,
  context: { readonly cwd: string; readonly sessionId: string },
): Promise<{ readonly url: string; close(): Promise<void> }> {
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    try {
      if (req.method !== 'POST' || req.url !== `/${token}`) throw new Error('bad request');
      req.setEncoding('utf8');
      let text = '';
      let bytes = 0;
      for await (const chunk of req) {
        bytes += Buffer.byteLength(String(chunk));
        if (bytes > MAX_BYTES) throw new Error('oversize hook');
        text += String(chunk);
      }
      const input = JSON.parse(text) as Record<string, unknown>;
      if (
        typeof input['cwd'] !== 'string' ||
        !insideProject(input['cwd'], context.cwd) ||
        input['session_id'] !== context.sessionId
      )
        throw new Error('hook context differs from launch');
      const out = await withDeadline(handleClaudeHook(engine, input), 9_000, () =>
        denyOutput(FAILURE),
      );
      res.end(JSON.stringify(out));
    } catch {
      res.end(JSON.stringify(denyOutput(FAILURE)));
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 15_000;
  server.maxConnections = 16;
  server.maxRequestsPerSocket = 1;
  server.keepAliveTimeout = 1_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('task controller has no port');
  return {
    url: `http://127.0.0.1:${address.port}/${token}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections();
      }),
  };
}

/** srt's HTTP proxy is used explicitly: Node's HTTP client does not read HTTP_PROXY itself. */
export async function taskHook(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HookOutput> {
  try {
    if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('oversize hook');
    const target = new URL(env['STROQ_TASK_BROKER'] ?? '');
    if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1')
      throw new Error('invalid controller');
    const proxyText = env['HTTP_PROXY'] ?? env['http_proxy'];
    const proxy = proxyText ? new URL(proxyText) : null;
    const endpoint = proxy ?? target;
    return await new Promise<HookOutput>((resolve) => {
      const req = request(
        endpoint,
        {
          method: 'POST',
          path: proxy === null ? target.pathname : target.href,
          headers: {
            host: target.host,
            'content-type': 'application/json',
            ...(proxy?.username
              ? {
                  'proxy-authorization': `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}`,
                }
              : {}),
          },
        },
        (res) => {
          res.setEncoding('utf8');
          let data = '';
          let bytes = 0;
          res.on('data', (chunk) => {
            bytes += Buffer.byteLength(chunk);
            if (bytes > MAX_BYTES) {
              req.destroy(new Error('oversize reply'));
              return;
            }
            data += String(chunk);
          });
          res.on('end', () => {
            try {
              const out = JSON.parse(data) as HookOutput;
              resolve(
                typeof out.stdout === 'string' && out.exitCode === 0 ? out : denyOutput(FAILURE),
              );
            } catch {
              resolve(denyOutput(FAILURE));
            }
          });
          res.on('error', () => resolve(denyOutput(FAILURE)));
        },
      );
      req.setTimeout(12_000, () => req.destroy(new Error('controller timeout')));
      req.on('error', () => resolve(denyOutput(FAILURE)));
      req.end(text);
    });
  } catch {
    return denyOutput(FAILURE);
  }
}

/** A broken or unbounded stdin is a deny even for Read, before any host timeout. */
export async function runTaskHookCommand(
  stream: NodeJS.ReadableStream = process.stdin,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HookOutput> {
  try {
    stream.setEncoding('utf8');
    let text = '';
    let bytes = 0;
    for await (const chunk of stream) {
      bytes += Buffer.byteLength(String(chunk));
      if (bytes > MAX_BYTES) return denyOutput(FAILURE);
      text += String(chunk);
    }
    return await taskHook(text, env);
  } catch {
    return denyOutput(FAILURE);
  }
}

function insideProject(cwd: string, root: string): boolean {
  if (!isAbsolute(cwd)) return false;
  const path = realpathSync(cwd);
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}
