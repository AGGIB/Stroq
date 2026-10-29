import { describe, expect, it, vi } from 'vitest';
import { runConsole, consoleLauncherUrl } from '../src/commands/console.js';

describe('local platform CLI', () => {
  it('resolves the shipped platform beside the split CLI, never from cwd', () => {
    expect(consoleLauncherUrl('file:///installed/dist/console-ABC.js').href).toBe(
      'file:///installed/platform/scripts/launch.mjs',
    );
    expect(consoleLauncherUrl('file:///source/src/commands/console.ts').href).toBe(
      'file:///source/platform/scripts/launch.mjs',
    );
  });
  it('loads the platform only on demand and binds cleanup for a running server', async () => {
    const close = vi.fn(async () => undefined);
    const launch = vi.fn(async (_args: readonly string[], _options: unknown) => ({ close }));
    const bindClose = vi.fn();
    const load = vi.fn(async () => ({ launch }));
    expect(await runConsole(['--workspace', '/selected', '--port', '0'], { load, bindClose })).toBe(
      0,
    );
    expect(load).toHaveBeenCalledOnce();
    expect(launch.mock.calls[0]?.[0]).toEqual(['--workspace', '/selected', '--port', '0']);
    expect(bindClose).toHaveBeenCalledWith(close);
  });
  it('does not bind cleanup for help and does not disclose a failed import path or token', async () => {
    const bindClose = vi.fn();
    expect(
      await runConsole(['--help'], { load: async () => ({ launch: async () => null }), bindClose }),
    ).toBe(0);
    expect(bindClose).not.toHaveBeenCalled();
    const error = vi.fn();
    expect(
      await runConsole([], {
        load: async () => {
          throw new Error('/private/secret#token=x');
        },
        error,
      }),
    ).toBe(1);
    expect(error.mock.calls[0]?.[0]).not.toMatch(/\/private|#token/);
    expect(error.mock.calls[0]?.[0]).toContain('Could not start');
  });
});
