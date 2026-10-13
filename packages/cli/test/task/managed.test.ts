import { afterEach, describe, expect, it, vi } from 'vitest';
import { hasManagedTaskPolicy } from '../../src/task/managed.js';

const { stat, probe } = vi.hoisted(() => ({ stat: vi.fn(), probe: vi.fn() }));
vi.mock('node:fs', () => ({ lstatSync: stat }));
vi.mock('node:child_process', () => ({ spawnSync: probe }));
afterEach(() => vi.resetAllMocks());

describe('managed task hosts', () => {
  it('checks the per-user macOS managed preferences from os.userInfo', () => {
    expect(
      hasManagedTaskPolicy({
        platform: 'darwin',
        username: () => 'managed-user',
        exists: (path) =>
          path === '/Library/Managed Preferences/managed-user/com.anthropic.claudecode.plist',
      }),
    ).toBe(true);
    expect(
      hasManagedTaskPolicy({
        platform: 'darwin',
        username: () => {
          throw new Error('unavailable user');
        },
        exists: () => false,
      }),
    ).toBe(true);
  });
  it('conservatively refuses WSL until Windows policy precedence is validated', () => {
    expect(hasManagedTaskPolicy({ platform: 'linux', wsl: () => true, exists: () => false })).toBe(
      true,
    );
    expect(hasManagedTaskPolicy({ platform: 'linux', wsl: () => false, exists: () => false })).toBe(
      false,
    );
  });
  it('treats unreadable managed files as present while ignoring absent ones', () => {
    stat.mockImplementation(() => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    });
    expect(hasManagedTaskPolicy({ platform: 'linux' })).toBe(false);
    stat.mockImplementation(() => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    });
    expect(hasManagedTaskPolicy({ platform: 'linux' })).toBe(true);
    stat.mockReturnValue({});
    expect(hasManagedTaskPolicy()).toBe(true);
  });
  it('bounds the registry probe and refuses policy presence or probe failure', () => {
    const host = { platform: 'win32' as const, exists: () => false };
    probe.mockReturnValue({ status: 0 });
    expect(hasManagedTaskPolicy(host)).toBe(false);
    const [exe, args, options] = probe.mock.calls[0] as [string, string[], object];
    expect(exe.replaceAll('\\', '/')).toMatch(
      /\/System32\/WindowsPowerShell\/v1\.0\/powershell\.exe$/,
    );
    expect(args).toContain('-NoProfile');
    expect(args.at(-1)).toContain('Registry]::LocalMachine');
    expect(args.at(-1)).toContain('Registry]::CurrentUser');
    expect(options).toEqual({ stdio: 'ignore', windowsHide: true, timeout: 5000 });
    for (const status of [1, 2, null]) {
      probe.mockReturnValue({ status });
      expect(hasManagedTaskPolicy(host)).toBe(true);
    }
  });
  it('checks the standard Linux and macOS policy sources', () => {
    expect(
      hasManagedTaskPolicy({
        platform: 'linux',
        exists: (path) => path === '/etc/claude-code/managed-settings.d',
        registry: () => false,
      }),
    ).toBe(true);
    expect(
      hasManagedTaskPolicy({
        platform: 'darwin',
        exists: (path) => path === '/Library/Managed Preferences/com.anthropic.claudecode.plist',
        registry: () => false,
      }),
    ).toBe(true);
    expect(
      hasManagedTaskPolicy({ platform: 'linux', exists: () => false, registry: () => false }),
    ).toBe(false);
  });
  it('refuses a Windows registry policy and a failed registry probe', () => {
    expect(
      hasManagedTaskPolicy({ platform: 'win32', exists: () => false, registry: () => true }),
    ).toBe(true);
    expect(
      hasManagedTaskPolicy({
        platform: 'win32',
        exists: () => false,
        registry: () => {
          throw new Error('access denied');
        },
      }),
    ).toBe(true);
    expect(
      hasManagedTaskPolicy({ platform: 'win32', exists: () => false, registry: () => false }),
    ).toBe(false);
  });
});
