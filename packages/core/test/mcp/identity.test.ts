import { describe, expect, it } from 'vitest';
import {
  MCP_IDENTITY_CHANNELS,
  isMcpIdentity,
  mcpIdentityFromEncodedTool,
  mcpIdentityFromServer,
} from '../../src/mcp/identity.js';

describe('producer-owned MCP server identity', () => {
  it('keeps exact separate server names distinct from their lossy tool-name aliases', () => {
    for (const channel of MCP_IDENTITY_CHANNELS) {
      expect(mcpIdentityFromServer(channel, 'git hub')).toEqual({
        kind: 'server',
        channel,
        name: 'git hub',
      });
      expect(mcpIdentityFromServer(channel, 'git_hub')).toEqual({
        kind: 'server',
        channel,
        name: 'git_hub',
      });
    }
    expect(mcpIdentityFromServer('cursor', 'GitHub')).not.toEqual(
      mcpIdentityFromServer('cursor', 'github'),
    );
    expect(mcpIdentityFromServer('cursor', '__raw.server!')).toEqual({
      kind: 'server',
      channel: 'cursor',
      name: '__raw.server!',
    });
  });

  it('bounds bytes, rejects hidden/control characters, and never carries unavailable raw input', () => {
    for (const value of [
      null,
      7,
      {},
      ' padded',
      'padded ',
      'x\u0000y',
      'x\u009fy',
      'x\u202ey',
      '\uD800',
    ]) {
      const witness = mcpIdentityFromServer('windsurf', value);
      expect(witness).toEqual({ kind: 'unavailable', channel: 'windsurf', reason: 'invalid' });
      expect(isMcpIdentity(witness)).toBe(true);
    }
    for (const value of [undefined, ''])
      expect(mcpIdentityFromServer('cursor', value)).toEqual({
        kind: 'unavailable',
        channel: 'cursor',
        reason: 'missing',
      });
    expect(mcpIdentityFromServer('mcp-proxy', 'a'.repeat(256)).kind).toBe('server');
    expect(mcpIdentityFromServer('mcp-proxy', 'a'.repeat(257))).toEqual({
      kind: 'unavailable',
      channel: 'mcp-proxy',
      reason: 'overlong',
    });
    expect(mcpIdentityFromServer('cursor', '\u00e9'.repeat(128)).kind).toBe('server');
    expect(mcpIdentityFromServer('cursor', '\u00e9'.repeat(129)).kind).toBe('unavailable');
    expect(() => mcpIdentityFromServer('synthetic' as 'cursor', 'github')).toThrow(
      'invalid-mcp-identity-channel',
    );
  });

  it('parses only the original unambiguous Claude/Codex envelope', () => {
    for (const channel of ['claude-code', 'codex'] as const) {
      expect(mcpIdentityFromEncodedTool(channel, 'mcp__git_hub__get_issue')).toEqual({
        kind: 'server',
        channel,
        name: 'git_hub',
      });
      expect(mcpIdentityFromEncodedTool(channel, 'mcp__git hub__get_issue')).toEqual({
        kind: 'server',
        channel,
        name: 'git hub',
      });
      for (const raw of [
        'mcp__srv__send__data',
        'mcp__srv___send',
        'mcp___srv__send',
        'mcp__srv__send_',
      ])
        expect(mcpIdentityFromEncodedTool(channel, raw)).toEqual({
          kind: 'unavailable',
          channel,
          reason: 'ambiguous',
        });
      for (const raw of ['mcp__', 'mcp____send', 'mcp__srv__', 'mcp__srv__x\n'])
        expect(mcpIdentityFromEncodedTool(channel, raw)?.kind).toBe('unavailable');
      expect(mcpIdentityFromEncodedTool(channel, 'mcp__srv__' + 'x'.repeat(1024))).toEqual({
        kind: 'unavailable',
        channel,
        reason: 'overlong',
      });
      for (const raw of ['Bash', 'update_plan', '', null, undefined])
        expect(mcpIdentityFromEncodedTool(channel, raw)).toBeUndefined();
    }
  });

  it('accepts only the closed witness union without evaluating accessors', () => {
    const server = mcpIdentityFromServer('codex', 'github');
    expect(isMcpIdentity(server)).toBe(true);
    expect(Object.isFrozen(server)).toBe(true);
    for (const value of [
      null,
      [],
      {},
      { ...server, extra: true },
      { ...server, channel: 'copilot' },
      { ...server, kind: 'known' },
      { ...server, name: '' },
      { kind: 'unavailable', channel: 'cursor', reason: 'guessed' },
      { kind: 'unavailable', channel: 'cursor', reason: 'missing', name: 'github' },
      Object.assign(Object.create({ trusted: true }), server),
      { ...server, [Symbol('extra')]: true },
      new Proxy(
        {},
        {
          ownKeys() {
            throw Error('untrusted-proxy');
          },
        },
      ),
    ])
      expect(isMcpIdentity(value)).toBe(false);
    const getter = { ...server };
    Object.defineProperty(getter, 'name', {
      get() {
        throw Error('untrusted-getter');
      },
    });
    expect(isMcpIdentity(getter)).toBe(false);
    expect(isMcpIdentity(Object.assign(Object.create(null), server))).toBe(true);
  });
});
