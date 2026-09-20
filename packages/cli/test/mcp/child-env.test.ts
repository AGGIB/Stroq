import { describe, expect, it } from 'vitest';
import { INFRASTRUCTURE_ENV, childEnv } from '../../src/mcp/child-env.js';

/**
 * The allowlist itself, away from the spawn. Two properties matter and neither is
 * visible from a single platform: that a credential the user's shell exported is
 * gone unless the wrapper recorded it, and that the variables a process needs in
 * order to start AT ALL survive — including the Windows ones, which a macOS or
 * Linux run would never miss.
 */

describe('the environment a wrapped MCP server is started with', () => {
  it('keeps what any process needs and drops every credential standing next to it', () => {
    const env = {
      PATH: '/usr/bin',
      HOME: '/home/me',
      LANG: 'en_US.UTF-8',
      TMPDIR: '/tmp',
      AWS_SECRET_ACCESS_KEY: 'shh',
      OPENAI_API_KEY: 'sk-live-x',
      GITHUB_TOKEN: 'ghp_x',
      SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
    };
    expect(childEnv([], env, 'linux')).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/me',
      LANG: 'en_US.UTF-8',
      TMPDIR: '/tmp',
    });
  });

  it('passes exactly the names the wrapper recorded, and nothing that merely resembles them', () => {
    const env = {
      PATH: '/usr/bin',
      GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_declared',
      GITHUB_PERSONAL_ACCESS_TOKEN_OLD: 'ghp_rotated',
      AWS_SECRET_ACCESS_KEY: 'shh',
    };
    // A prefix of a recorded name is a different variable: `@…/server-github` was
    // configured with one token, not with every variable whose name starts the same.
    expect(childEnv(['GITHUB_PERSONAL_ACCESS_TOKEN'], env, 'linux')).toEqual({
      PATH: '/usr/bin',
      GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_declared',
    });
  });

  it('keeps the whole LC_ family without the list naming every member of it', () => {
    const env = { LC_ALL: 'C', LC_TIME: 'de_DE.UTF-8', LCD_BRIGHTNESS: '40' };
    // `LC_` is a prefix, `LCD_` only looks like one.
    expect(childEnv([], env, 'linux')).toEqual({ LC_ALL: 'C', LC_TIME: 'de_DE.UTF-8' });
  });

  it('matches case-insensitively on Windows, where Path and PATH are one variable', () => {
    const env = {
      Path: 'C:\\bin',
      SystemRoot: 'C:\\Windows',
      Github_Token: 'ghp_declared',
      AWS_SECRET_ACCESS_KEY: 'shh',
    };
    // The wrapper recorded the name in the casing the config file used; Windows
    // would hand the server the same variable whichever casing either side wrote.
    // Keys keep their original casing — only the comparison is folded.
    expect(childEnv(['GITHUB_TOKEN'], env, 'win32')).toEqual({
      Path: 'C:\\bin',
      SystemRoot: 'C:\\Windows',
      Github_Token: 'ghp_declared',
    });
  });

  it('is case-sensitive everywhere else, where a lower-cased name is a different variable', () => {
    expect(
      childEnv(['Token'], { path: '/attacker/bin', token: 'x', PATH: '/usr/bin' }, 'linux'),
    ).toEqual({ PATH: '/usr/bin' });
  });

  it('builds a new object rather than deleting from the environment it was given', () => {
    const env = { PATH: '/usr/bin', AWS_SECRET_ACCESS_KEY: 'shh' };
    const filtered = childEnv([], env, 'linux');
    expect(filtered).not.toBe(env);
    expect(env['AWS_SECRET_ACCESS_KEY']).toBe('shh');
  });

  it('carries the Windows variables that are load-bearing there', () => {
    // Omitting these does not degrade Windows, it breaks it: the Win32 loader reads
    // SystemRoot, `spawn` needs COMSPEC and PATHEXT to resolve an `npx.cmd` shim,
    // and everything a server caches per user lives under APPDATA/USERPROFILE.
    for (const name of ['SystemRoot', 'COMSPEC', 'PATHEXT', 'APPDATA', 'USERPROFILE'])
      expect(INFRASTRUCTURE_ENV).toContain(name);
  });

  it('carries nothing that is itself a credential or that redirects what the child loads', () => {
    for (const name of [
      'SSH_AUTH_SOCK',
      'AWS_SECRET_ACCESS_KEY',
      'GITHUB_TOKEN',
      'NODE_OPTIONS',
      'PYTHONPATH',
      'LD_PRELOAD',
      'DYLD_INSERT_LIBRARIES',
    ])
      expect(INFRASTRUCTURE_ENV).not.toContain(name);
  });
});
