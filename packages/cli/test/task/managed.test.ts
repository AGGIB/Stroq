import { describe, expect, it } from 'vitest';
import { hasManagedTaskPolicy } from '../../src/task/managed.js';

describe('managed task hosts', () => {
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
