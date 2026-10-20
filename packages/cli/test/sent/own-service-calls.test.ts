import { describe, expect, it } from 'vitest';
import type { Key } from '../../src/sent/keys.js';
import type { McpServers } from '../../src/sent/mcp-config.js';
import { describePlace } from '../../src/sent/phrases.js';
import { placeOfArgument, type WhereContext } from '../../src/sent/where.js';

/**
 * A WebFetch and an MCP call are the key's own use only by the strict proof, as any other call:
 * the key only in the query parameter its service documents, at an exact host of the service. An
 * MCP server's address comes from today's settings, which may not be where it pointed when the
 * session ran: a key handed to it is maybe sent. Every value is made up.
 */

const GITHUB: Key = {
  name: 'GITHUB_TOKEN',
  source: 'env',
  value: 'ghp_FAKEownCalls0123456789abcdefABCD',
};
const GOOGLE: Key = {
  name: 'GOOGLE_MAPS_API_KEY',
  source: '.env',
  value: 'AIzaFAKEownCalls0123456789abcdefghijk',
};

const servers: McpServers = {
  known: new Map(),
  lookup: (tool) => {
    if (!tool.startsWith('mcp__')) return null;
    const name = tool.split('__')[1] ?? '';
    if (name === 'gh')
      return { name, server: { remote: true, host: 'api.github.com' }, connector: false };
    if (name === 'far')
      return { name, server: { remote: true, host: 'mcp.collect.example' }, connector: false };
    if (name.startsWith('claude_ai_'))
      return { name: name.slice(10), server: { remote: true, host: null }, connector: true };
    return { name, server: null, connector: false };
  },
};
const ctx: WhereContext = { mcp: servers, cwd: '/w', gitRemote: () => null };

describe('a WebFetch', () => {
  it('a key in a URL of its own service, not in the parameter it documents: another company', () => {
    expect(
      placeOfArgument(
        'WebFetch',
        { url: `https://github.com/search?q=${GITHUB.value}`, prompt: 'x' },
        GITHUB,
        ctx,
      ),
    ).toMatchObject({ tier: 'third_party', host: 'github.com' });
  });

  it('the key in the documented parameter at an exact host of its service: its own use', () => {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=x&key=${GOOGLE.value}`;
    expect(placeOfArgument('WebFetch', { url, prompt: 'x' }, GOOGLE, ctx)).toMatchObject({
      tier: 'own_service',
      host: 'maps.googleapis.com',
    });
  });

  it('the key in the path of its own service: another company', () => {
    const url = `https://maps.googleapis.com/maps/${GOOGLE.value}/json`;
    expect(placeOfArgument('WebFetch', { url, prompt: 'x' }, GOOGLE, ctx).tier).toBe('third_party');
  });

  it('to this machine: maybe', () => {
    expect(
      placeOfArgument('WebFetch', { url: `http://localhost:3000/?k=${GITHUB.value}` }, GITHUB, ctx),
    ).toMatchObject({ tier: 'maybe', local: true });
  });
});

describe('an MCP server whose address comes from today’s settings', () => {
  it('at the key’s own service: maybe, never its own use', () => {
    const place = placeOfArgument(
      'mcp__gh__create_issue',
      { body: `token ${GITHUB.value}` },
      GITHUB,
      ctx,
    );
    expect(place).toMatchObject({ tier: 'maybe', route: 'mcp', host: 'api.github.com' });
    expect(describePlace(place)).toBe(
      'MCP server "gh", whose settings now name api.github.com; where it pointed during the session is not recorded',
    );
  });

  it('at another host: maybe as well', () => {
    expect(placeOfArgument('mcp__far__save', { text: GITHUB.value }, GITHUB, ctx)).toMatchObject({
      tier: 'maybe',
      host: 'mcp.collect.example',
    });
  });

  it('a claude.ai connector is named by the session itself: another company', () => {
    expect(
      placeOfArgument('mcp__claude_ai_Notes__save', { text: GITHUB.value }, GITHUB, ctx).tier,
    ).toBe('third_party');
  });

  it('an address handed to it with the key is still a call to that host', () => {
    expect(
      placeOfArgument(
        'mcp__gh__fetch',
        { url: 'https://collect.example/x', token: GITHUB.value },
        GITHUB,
        ctx,
      ),
    ).toMatchObject({ tier: 'third_party', host: 'collect.example' });
  });
});
