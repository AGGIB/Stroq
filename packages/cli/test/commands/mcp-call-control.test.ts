import { describe, expect, it } from 'vitest';
import { parseMcpArgv } from '../../src/commands/mcp.js';

const control = '11111111-2222-4333-8444-55555555555a';
const parse = (...args: string[]) =>
  parseMcpArgv(['--server', 'fixture', '--pass-env', '', ...args, '--', 'inert-server']);
describe('explicit MCP call-control identity', () => {
  it.each(
    [
      [],
      ['--strict'],
      ['--cloak'],
      ['--strict', '--cloak'],
      ['--pin', `sha256:${'a'.repeat(64)}`],
      ['--strict', '--tool-approval'],
    ].map((mode) => [mode]),
  )('accepts the stable UUID independently of legal mode flags %j', (mode) => {
    const result = parse(...mode, '--call-control', control);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.invocation.callControlId).toBe(control);
  });
  it('preserves legacy invocations and does not read upstream flags', () => {
    expect(parse()).toMatchObject({ ok: true, invocation: { command: 'inert-server' } });
    const ordinary = parse();
    expect(ordinary.ok && Object.hasOwn(ordinary.invocation, 'callControlId')).toBe(false);
    const upstream = parseMcpArgv([
      '--server',
      'fixture',
      '--',
      'inert-server',
      '--call-control',
      control,
    ]);
    expect(upstream.ok && upstream.invocation).toMatchObject({ args: ['--call-control', control] });
    expect(upstream.ok && Object.hasOwn(upstream.invocation, 'callControlId')).toBe(false);
  });
  it('refuses missing, ambiguous or malformed identity and unknown inherited environment', () => {
    for (const value of ['bad', control.toUpperCase(), '../outside', 'a'.repeat(36)])
      expect(parse('--call-control', value).ok).toBe(false);
    expect(parse('--call-control', control, '--call-control', control).ok).toBe(false);
    expect(parse('--call-control').ok).toBe(false);
    const inherited = parseMcpArgv([
      '--server',
      'fixture',
      '--call-control',
      control,
      '--',
      'inert-server',
    ]);
    expect(inherited).toEqual({ ok: false, error: '--call-control needs explicit --pass-env' });
  });
});
