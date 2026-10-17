import { describe, expect, it } from 'vitest';
import { keyOf } from '../../src/mcp/framing.js';
import { appendBlocks, withWarningBlock } from '../../src/mcp/judge.js';

/**
 * Two small things the default pump and the strict handler now share, so the two cannot
 * drift: the order the warning and the cloak notice are appended to a result in, and the
 * key a request id is filed under.
 */

const result = { content: [{ type: 'text', text: 'body' }], isError: false };

describe('appendBlocks', () => {
  it('appends each block as a text item, in order, after the result’s own content', () => {
    const out = appendBlocks(result, ['warning', 'notice']);
    expect(out['content']).toEqual([
      { type: 'text', text: 'body' },
      { type: 'text', text: 'warning' },
      { type: 'text', text: 'notice' },
    ]);
    expect(out['isError']).toBe(false);
  });

  it('skips a block that is null, and returns the result itself when there is none', () => {
    expect(appendBlocks(result, [null, 'notice'])['content']).toEqual([
      { type: 'text', text: 'body' },
      { type: 'text', text: 'notice' },
    ]);
    expect(appendBlocks(result, [null, null])).toBe(result);
  });

  it('is exactly what chaining withWarningBlock does, which is what the default pump did', () => {
    const chained = withWarningBlock(withWarningBlock(result, 'warning'), 'notice');
    expect(appendBlocks(result, ['warning', 'notice'])).toEqual(chained);
  });

  it('does not change the result it is given', () => {
    const before = JSON.stringify(result);
    appendBlocks(result, ['a', 'b']);
    expect(JSON.stringify(result)).toBe(before);
  });
});

describe('keyOf', () => {
  it('files a string id and a number id apart', () => {
    expect(keyOf(3)).toBe('n:3');
    expect(keyOf('3')).toBe('s:3');
    expect(keyOf(3)).not.toBe(keyOf('3'));
  });
});
