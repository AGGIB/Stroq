import { describe, expect, it } from 'vitest';
import { parseMcpArgv } from '../../src/commands/mcp.js';

describe('parseMcpArgv --strict', () => {
  const strictOf = (argv: readonly string[]) => {
    const result = parseMcpArgv(argv);
    return result.ok
      ? { strict: result.invocation.strict, max: result.invocation.strictMaxWithheld }
      : result.error;
  };

  it('is absent from the invocation unless the flag is present', () => {
    // Absent, not `false`: an invocation without the flag keeps exactly the shape it had.
    const parsed = parseMcpArgv(['--server', 'a', '--', 'srv']);
    expect(parsed.ok && Object.keys(parsed.invocation)).not.toContain('strict');
    expect(strictOf(['--server', 'a', '--', 'srv'])).toEqual({ strict: undefined, max: undefined });
  });

  it('is on when the flag is present, and takes no value of its own', () => {
    expect(strictOf(['--server', 'a', '--strict', '--', 'srv'])).toEqual({
      strict: true,
      max: undefined,
    });
    const parsed = parseMcpArgv(['--strict', '--server', 'a', '--cloak', '--', 'srv']);
    expect(parsed.ok && parsed.invocation.server).toBe('a');
    expect(parsed.ok && parsed.invocation.cloak).toBe(true);
    expect(parsed.ok && parsed.invocation.strict).toBe(true);
  });

  it('reads the limit of withheld messages', () => {
    expect(
      strictOf(['--server', 'a', '--strict', '--strict-max-withheld', '5', '--', 'srv']),
    ).toEqual({ strict: true, max: 5 });
  });

  it.each(['0', '-1', '1.5', 'many', '1001', '05'])('refuses a limit of "%s"', (value) => {
    const result = parseMcpArgv([
      '--server',
      'a',
      '--strict',
      '--strict-max-withheld',
      value,
      '--',
      'srv',
    ]);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/--strict-max-withheld/);
  });

  it('refuses a limit without --strict, which it would silently not apply to', () => {
    expect(strictOf(['--server', 'a', '--strict-max-withheld', '5', '--', 'srv'])).toBe(
      '--strict-max-withheld needs --strict',
    );
  });

  it('is not read from after the separator: it belongs to the server there', () => {
    const parsed = parseMcpArgv(['--server', 'a', '--', 'srv', '--strict']);
    expect(parsed.ok && parsed.invocation.strict).toBeUndefined();
    expect(parsed.ok && parsed.invocation.args).toEqual(['--strict']);
  });
});
