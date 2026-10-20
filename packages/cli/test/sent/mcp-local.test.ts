import { describe, expect, it } from 'vitest';
import type { Key } from '../../src/sent/keys.js';
import type { McpServers } from '../../src/sent/mcp-config.js';
import { placeOfArgument, type WhereContext } from '../../src/sent/where.js';

/**
 * An MCP server reached at a loopback address is often a gateway or a tunnel that forwards each
 * call on (a Docker MCP gateway, mcp-remote, ngrok). Like a server started as a local command, it
 * may send what it is given on: maybe. Any other server's address is read from today's settings,
 * which may not be where it pointed when the session ran: maybe too, with the host named. All
 * values are made up.
 */

const STRIPE: Key = {
  name: 'STRIPE_SECRET_KEY',
  source: '.env',
  value: 'sk_FAKEstripe0123456789abcdef',
};
const at = (host: string): McpServers => ({
  known: new Map(),
  lookup: (tool) =>
    tool.startsWith('mcp__gw__')
      ? { name: 'gw', server: { remote: true, host }, connector: false }
      : null,
});
const ctxFor = (host: string): WhereContext => ({
  mcp: at(host),
  cwd: '/w',
  gitRemote: () => null,
});

describe('a key in a call to an MCP server reached at this machine', () => {
  it.each(['localhost', '127.0.0.1'])('%s: maybe sent', (host) => {
    expect(
      placeOfArgument('mcp__gw__send', { data: STRIPE.value }, STRIPE, ctxFor(host)),
    ).toMatchObject({ tier: 'maybe', route: 'mcp', local: true });
  });

  it.each(['10.0.0.5', 'gateway.local'])(
    '%s, on the local network: maybe, its host named',
    (host) => {
      const place = placeOfArgument('mcp__gw__send', { data: STRIPE.value }, STRIPE, ctxFor(host));
      expect(place).toMatchObject({ tier: 'maybe', route: 'mcp', host });
      expect(place.local).toBeUndefined();
    },
  );

  it('even when it is handed a URL on this machine', () => {
    expect(
      placeOfArgument(
        'mcp__gw__fetch',
        { url: `http://localhost:3000/?k=${STRIPE.value}` },
        STRIPE,
        ctxFor('localhost'),
      ),
    ).toMatchObject({ tier: 'maybe' });
  });

  it('a server elsewhere: maybe, its host named', () => {
    expect(
      placeOfArgument(
        'mcp__gw__send',
        { data: STRIPE.value },
        STRIPE,
        ctxFor('mcp.collect.example'),
      ),
    ).toMatchObject({ tier: 'maybe', host: 'mcp.collect.example' });
  });
});
