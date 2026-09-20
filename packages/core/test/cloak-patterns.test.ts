import { describe, expect, it } from 'vitest';
import { CLOAK_PATTERNS, detectPatterns, luhn } from '../src/cloak/patterns.js';

/**
 * Every assertion here is about SPANS, not about "did it match": a detector that
 * reports the right kind at the wrong offset corrupts the text it is meant to protect,
 * and that is the failure mode this whole feature has to rule out. So each case checks
 * `text.slice(start, end)` against the value the span claims.
 */
const slices = (text: string) =>
  detectPatterns(text).map((s) => ({ kind: s.kind, at: text.slice(s.start, s.end) }));

describe('cloak pattern detector', () => {
  it('finds an email at its real offset in the original text', () => {
    const text = 'Contact peter.parker@dailybugle.example about invoice 7781.';
    const spans = detectPatterns(text);
    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    expect(span.kind).toBe('email');
    expect(text.slice(span.start, span.end)).toBe('peter.parker@dailybugle.example');
    expect(span.value).toBe('peter.parker@dailybugle.example');
  });

  it('finds several distinct kinds in one string, ordered by position', () => {
    const text = 'a@b.example then +1 (415) 555-0132 then GB33BUKB20201555555555';
    expect(slices(text)).toEqual([
      { kind: 'email', at: 'a@b.example' },
      { kind: 'phone', at: '+1 (415) 555-0132' },
      { kind: 'iban', at: 'GB33BUKB20201555555555' },
    ]);
  });

  it('accepts a card number that passes Luhn and rejects one that does not', () => {
    expect(luhn('4242424242424242')).toBe(true);
    expect(luhn('4242424242424243')).toBe(false);
    expect(slices('card 4242 4242 4242 4242 ok')).toEqual([
      { kind: 'card', at: '4242 4242 4242 4242' },
    ]);
    expect(detectPatterns('card 4242 4242 4242 4243 ok')).toEqual([]);
  });

  it('finds a US SSN but not an ordinary dotted version number', () => {
    expect(slices('ssn 123-45-6789 done')).toEqual([{ kind: 'ssn', at: '123-45-6789' }]);
    expect(detectPatterns('version 1.23.456 done')).toEqual([]);
  });

  it('does not report a bare number that only looks like a phone inside a longer digit run', () => {
    // A 16-digit run is a card candidate, never two phone numbers spliced together.
    expect(detectPatterns('id 12345678901234567890').filter((s) => s.kind === 'phone')).toEqual([]);
  });

  it('never returns overlapping spans', () => {
    const text = 'mail to 4242424242424242@bank.example now';
    const spans = detectPatterns(text);
    for (let i = 1; i < spans.length; i += 1) {
      expect(spans[i]!.start).toBeGreaterThanOrEqual(spans[i - 1]!.end);
    }
  });

  it('reports every occurrence of a repeated value separately', () => {
    const text = 'a@b.example and again a@b.example';
    expect(detectPatterns(text)).toHaveLength(2);
  });

  it('leaves text with nothing structured in it alone', () => {
    expect(detectPatterns('The quick brown fox jumps over the lazy dog.')).toEqual([]);
  });

  it('exposes a stable, non-empty pattern table whose kinds are all distinct', () => {
    const kinds = CLOAK_PATTERNS.map((p) => p.kind);
    expect(kinds.length).toBeGreaterThan(0);
    expect(new Set(kinds).size).toBe(kinds.length);
  });
});
