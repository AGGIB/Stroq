import { describe, expect, it } from 'vitest';
import { readStrictResult } from '../../src/mcp/strict-result.js';

/** The unit-level half of `proxy-strict-hidden-resource.test.ts`: the strings are in the scan text. */

const textOf = (read: ReturnType<typeof readStrictResult>): string => {
  if (!read.ok) throw new Error(`expected a readable result, got ${read.reason}`);
  return read.text;
};

describe('an embedded resource behind a non-empty outer text', () => {
  it('is read in a tools/call item', () => {
    const all = textOf(
      readStrictResult('tools/call', {
        content: [
          { type: 'resource', text: 'ok', resource: { uri: 'file:///a', text: 'marker-hidden' } },
        ],
      }),
    );
    expect(all).toContain('marker-hidden');
  });

  it('is read in a prompts/get message, with every key of the resource', () => {
    const all = textOf(
      readStrictResult('prompts/get', {
        messages: [
          {
            role: 'user',
            content: {
              type: 'resource',
              text: 'ok',
              resource: { uri: 'u', text: 'marker-hidden', 'marker-key': 1 },
            },
          },
        ],
      }),
    );
    expect(all).toContain('marker-hidden');
    expect(all).toContain('marker-key');
  });

  it('is read beside a resource_link whose name and description are text too', () => {
    const all = textOf(
      readStrictResult('tools/call', {
        content: [
          {
            type: 'resource_link',
            uri: 'u',
            name: 'marker-name',
            description: 'marker-desc',
            text: 'ok',
          },
        ],
      }),
    );
    expect(all).toContain('marker-name');
    expect(all).toContain('marker-desc');
  });
});
