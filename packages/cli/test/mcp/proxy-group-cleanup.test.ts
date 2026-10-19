import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { createEngine } from '../../src/engine-factory.js';
import { runMcpProxy } from '../../src/mcp/proxy.js';

const calls = vi.hoisted(() => [] as { exited: boolean; signal: string }[]);
vi.mock('../../src/mcp/kill-child.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/mcp/kill-child.js')>();
  return {
    ...original,
    killChildTree: (...args: Parameters<typeof original.killChildTree>) => {
      calls.push({
        exited: args[0].exitCode != null || args[0].signalCode != null,
        signal: args[1],
      });
      original.killChildTree(...args);
    },
  };
});

it.skipIf(process.platform === 'win32')(
  'cleans the detached group even when the leader closes its pipes first',
  async () => {
    const stdin = new PassThrough();
    const running = runMcpProxy({
      engine: createEngine(),
      sessionId: 'group-cleanup',
      server: 'test',
      command: process.execPath,
      args: [join(import.meta.dirname, 'fake-server.mjs')],
      cwd: process.cwd(),
      passEnv: [],
      stdin,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      shutdownGraceMs: 30_000,
    });
    stdin.end();
    await running;
    expect(calls).toContainEqual({ exited: true, signal: 'SIGKILL' });
  },
);
