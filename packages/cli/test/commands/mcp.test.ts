import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseMcpArgv, resolveMcpCwd } from '../../src/commands/mcp.js';

describe('parseMcpArgv', () => {
  it('rejects a value that starts with -- as a missing value, not as the value itself', () => {
    // `--server --client x` is a config with a missing `--server` value, not a
    // server literally named `--client`; the old check (`value === '--'`) only
    // caught the bare separator and let this slip through as `server: '--client'`.
    expect(parseMcpArgv(['--server', '--client', '--', 'node', 'x'])).toEqual({
      ok: false,
      error: '--server needs a value',
    });
    expect(parseMcpArgv(['--server', 'demo', '--cwd', '--session', '--', 'node', 'x'])).toEqual({
      ok: false,
      error: '--cwd needs a value',
    });
  });

  it('still accepts an ordinary value and the ok shape is unaffected', () => {
    const result = parseMcpArgv(['--server', 'demo', '--', 'node', 'x']);
    expect(result).toEqual({
      ok: true,
      invocation: {
        server: 'demo',
        client: 'unknown',
        session: null,
        cwd: null,
        passEnv: null,
        command: 'node',
        args: ['x'],
      },
    });
  });
});

describe('parseMcpArgv --pass-env', () => {
  const passEnvOf = (argv: readonly string[]) => {
    const result = parseMcpArgv(argv);
    return result.ok ? result.invocation.passEnv : result.error;
  };

  it('reads the recorded names as a list', () => {
    expect(
      passEnvOf(['--server', 'a', '--pass-env', 'GITHUB_TOKEN,SLACK_TOKEN', '--', 'srv']),
    ).toEqual(['GITHUB_TOKEN', 'SLACK_TOKEN']);
  });

  it('tells an EMPTY recorded list apart from a wrapper that recorded none at all', () => {
    // The distinction the whole migration rests on. An empty value means "this
    // wrapper was written by a version that filters, and this server declared
    // nothing" — filter it down to infrastructure. The flag being absent means the
    // wrapper predates filtering and nothing is known about what the server needs.
    expect(passEnvOf(['--server', 'a', '--pass-env', '', '--', 'srv'])).toEqual([]);
    expect(passEnvOf(['--server', 'a', '--', 'srv'])).toBeNull();
  });

  it('ignores the blanks a hand-edited list leaves behind', () => {
    expect(passEnvOf(['--server', 'a', '--pass-env', ' A , ,B, ', '--', 'srv'])).toEqual([
      'A',
      'B',
    ]);
  });
});

describe('resolveMcpCwd', () => {
  it('resolves a relative value against the proxy’s own process.cwd()', () => {
    const originalCwd = process.cwd();
    process.chdir(mkdtempSync(join(tmpdir(), 'stroq-mcp-cwd-')));
    try {
      // Compared against `process.cwd()` itself, taken AFTER the chdir, rather than
      // against the directory string `mkdtempSync` returned: on macOS `os.tmpdir()`
      // sits under a symlink (`/var` -> `/private/var`), so `process.cwd()` reports
      // the resolved form while the pre-chdir string does not — a mismatch that has
      // nothing to do with what `resolveMcpCwd` itself is being tested for.
      const resolvedCwd = process.cwd();
      expect(resolveMcpCwd('.')).toBe(resolvedCwd);
      expect(resolveMcpCwd('sub/dir')).toBe(join(resolvedCwd, 'sub/dir'));
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('leaves an already-absolute value unchanged', () => {
    expect(resolveMcpCwd('/already/absolute')).toBe('/already/absolute');
  });

  it('falls back to process.cwd() when --cwd was omitted', () => {
    expect(resolveMcpCwd(null)).toBe(process.cwd());
  });
});
