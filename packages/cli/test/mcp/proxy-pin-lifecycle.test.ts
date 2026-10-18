import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { createEngine } from '../../src/engine-factory.js';
import { runMcpProxy } from '../../src/mcp/proxy.js';

const { cleanup, preparePin } = vi.hoisted(() => ({ cleanup: vi.fn(), preparePin: vi.fn() }));
vi.mock('../../src/mcp/pin.js', () => ({ preparePin }));
afterEach(() => {
  vi.resetAllMocks();
});

function options() {
  const stderr = new PassThrough();
  let diagnostics = '';
  stderr.on('data', (chunk) => {
    diagnostics += String(chunk);
  });
  return {
    engine: createEngine(),
    server: 'demo',
    sessionId: 'pin-cleanup',
    cwd: process.cwd(),
    command: 'node',
    args: [],
    pin: `sha256:${'a'.repeat(64)}`,
    passEnv: [],
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr,
    diagnostics: () => diagnostics,
  };
}

it('keeps the child exit code when cleanup fails and reports one bounded diagnostic', async () => {
  const config = options();
  cleanup.mockRejectedValue(new Error('EPERM unsafe\npath'));
  preparePin.mockResolvedValue({
    command: process.execPath,
    args: ['-e', 'process.exit(7)'],
    cwd: process.cwd(),
    cleanup,
  });
  expect(await runMcpProxy(config)).toBe(7);
  expect(cleanup).toHaveBeenCalledOnce();
  expect(config.diagnostics()).toBe(
    'stroq mcp: could not remove the private server copy; remove it after the server stops\n',
  );
});

it('relays SIGHUP, cleans the private copy, and unregisters its handler', async () => {
  const config = options();
  const listeners = process.listenerCount('SIGHUP');
  cleanup.mockResolvedValue(undefined);
  preparePin.mockResolvedValue({
    command: process.execPath,
    args: ['-e', 'console.log("ready");setTimeout(()=>{},3000)'],
    cwd: process.cwd(),
    cleanup,
  });
  const ready = new Promise<void>((resolve) => {
    config.stdout.once('data', () => resolve());
  });
  const done = runMcpProxy(config);
  await ready;
  process.emit('SIGHUP');
  expect(await done).toBe(1);
  expect(cleanup).toHaveBeenCalledOnce();
  expect(process.listenerCount('SIGHUP')).toBe(listeners);
});

it.each([
  [
    'the local MCP confirmation lock is missing or invalid',
    'the local MCP confirmation lock is missing or invalid',
  ],
  [
    'the pinned server files changed (digest mismatch)',
    'the pinned server files changed (digest mismatch)',
  ],
  ['cannot verify a linked store folder', 'cannot verify a linked store folder'],
  ['unsafe\nfilesystem path', 'pinned server cannot be verified'],
])('reports a fixed refusal reason for %s', async (reason, expected) => {
  const config = options();
  preparePin.mockRejectedValue(new Error(reason));
  expect(await runMcpProxy(config)).toBe(1);
  expect(config.diagnostics()).toBe(`stroq mcp: ${expected}; refusing to start\n`);
});
