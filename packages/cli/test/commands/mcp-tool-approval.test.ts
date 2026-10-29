import { describe, expect, it } from 'vitest';
import { parseMcpArgv } from '../../src/commands/mcp.js';

const parse = (...flags: string[]) => parseMcpArgv(['--server', 'demo', ...flags, '--', 'server']);

describe('explicit MCP tool-contract approval mode', () => {
  it('requires strict and does not add a default-mode field', () => {
    const ordinary = parse('--strict');
    expect(ordinary.ok && Object.keys(ordinary.invocation)).not.toContain('toolApproval');
    expect(parse('--tool-approval')).toEqual({
      ok: false,
      error: '--tool-approval needs --strict',
    });
  });

  it('accepts the boolean flag only before the server separator', () => {
    const enabled = parse('--strict', '--tool-approval', '--pass-env', '');
    expect(enabled.ok && enabled.invocation).toMatchObject({ strict: true, toolApproval: true });
    const serverFlag = parseMcpArgv(['--server', 'demo', '--', 'server', '--tool-approval']);
    expect(serverFlag.ok && serverFlag.invocation).toMatchObject({ args: ['--tool-approval'] });
    expect(serverFlag.ok && Object.keys(serverFlag.invocation)).not.toContain('toolApproval');
  });

  it('refuses incompatible cloak and legacy environment wrappers before spawning', () => {
    const cloak = parse('--strict', '--tool-approval', '--cloak');
    expect(cloak.ok).toBe(false);
    expect(parse('--strict', '--tool-approval')).toEqual({
      ok: false,
      error: '--tool-approval needs explicit --pass-env',
    });
    expect(!cloak.ok && cloak.error).toBe('--tool-approval cannot be combined with --cloak');
  });
});
