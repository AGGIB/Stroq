import { describe, expect, it } from 'vitest';
import { createServer, type RequestListener } from 'node:http';
import { taskHook } from '../../src/task/broker.js';

async function withServer(handler: RequestListener, run: (url: string) => Promise<void>) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing test port');
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('task hook transport', () => {
  it('uses the sandbox HTTP proxy without exposing credentials in the request target', async () => {
    const target = 'http://127.0.0.1:1234/task-token';
    await withServer(
      (req, res) => {
        expect(req.url).toBe(target);
        expect(req.headers.host).toBe('127.0.0.1:1234');
        expect(req.headers['proxy-authorization']).toBe(
          `Basic ${Buffer.from('user:p@ss').toString('base64')}`,
        );
        res.end(JSON.stringify({ stdout: '', exitCode: 0 }));
      },
      async (url) => {
        const proxy = new URL(url);
        proxy.username = 'user';
        proxy.password = 'p@ss';
        expect(await taskHook('{}', { STROQ_TASK_BROKER: target, HTTP_PROXY: proxy.href })).toEqual(
          { stdout: '', exitCode: 0 },
        );
      },
    );
  });
  it.each(['{broken', JSON.stringify({ stdout: '', exitCode: 2 }), 'x'.repeat(1_048_577)])(
    'refuses malformed, unsafe or oversized controller replies (%#)',
    async (reply) => {
      await withServer(
        (_req, res) => res.end(reply),
        async (url) => {
          expect((await taskHook('{}', { STROQ_TASK_BROKER: `${url}/token` })).stdout).toContain(
            'deny',
          );
        },
      );
    },
  );
});
