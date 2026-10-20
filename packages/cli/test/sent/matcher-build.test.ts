import { describe, expect, it } from 'vitest';
import { byteMatcher, textMatcher } from '../../src/sent/needles.js';

/**
 * Building the matchers over many keys spreads no list into one call: a call takes only so many
 * arguments, and a machine can hold that many spellings. Every value is made up.
 */

const many = Array.from({ length: 300_000 }, (_, i) => `FAKEvalue${i}x0123456789abcdef`);

describe('building the matchers over many keys', () => {
  it('the text matcher', () => {
    expect(() => textMatcher(many)).not.toThrow();
  });

  it('the byte matcher', () => {
    expect(() => byteMatcher(many, [])).not.toThrow();
  });
});
