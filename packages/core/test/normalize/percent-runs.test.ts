import { describe, expect, it } from 'vitest';
import { decodePercentRuns } from '../../src/normalize/percent-runs.js';

describe('decodePercentRuns', () => {
  it('decodes each run of valid escapes on its own', () => {
    expect(decodePercentRuns('a%20b%2Fc')).toBe('a b/c');
    expect(decodePercentRuns('%2Eclaude/%73ettings.json')).toBe('.claude/settings.json');
  });

  it('decodes multi-byte sequences', () => {
    expect(decodePercentRuns('%D0%9F%D0%B0%D1%80%D0%BE%D0%BB%D1%8C')).toBe('Пароль');
  });

  it('leaves text with no escapes as it was', () => {
    expect(decodePercentRuns('plain 50% text')).toBe('plain 50% text');
  });

  it('does not throw on an invalid sequence, and decodes the rest', () => {
    expect(() => decodePercentRuns('%E0%A4%A')).not.toThrow();
    expect(decodePercentRuns('50%zz %41')).toBe('50%zz A');
  });

  // Decoding threw a URIError per undecodable run, at about 8 microseconds each.
  it('takes no longer on two million characters of undecodable runs than on any others', () => {
    const t = performance.now();
    decodePercentRuns('%E0'.repeat(700_000));
    expect(performance.now() - t).toBeLessThan(1500);
  });
});
