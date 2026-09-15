import { describe, expect, it } from 'vitest';
import { normalizeText } from '../../src/normalize/normalizer.js';

describe('the confusables fold', () => {
  it('folds Greek lookalikes mixed into a Latin word', () => {
    // "sentry" with Greek epsilon and omicron
    expect(normalizeText('sεntry-tοoling')).toBe('sentry-tooling');
  });

  it('still folds the Cyrillic lookalikes it always did', () => {
    expect(normalizeText('pаypal')).toBe('paypal'); // Cyrillic а
  });

  it('leaves a wholly Greek word alone', () => {
    // A real Greek word is not a disguise; folding it would corrupt real text.
    expect(normalizeText('ασφάλεια')).toBe('ασφάλεια');
  });

  it('leaves a wholly Cyrillic word alone', () => {
    expect(normalizeText('безопасность')).toBe('безопасность');
  });

  it('leaves ordinary Latin text untouched', () => {
    const text = 'Run npm install and set DATABASE_URL before starting.';
    expect(normalizeText(text)).toBe(text);
  });

  it('folds a mixed token without disturbing its neighbours', () => {
    expect(normalizeText('please run sεntry now')).toBe('please run sentry now');
  });

  it('does not fold the micro sign into a Latin u, even though NFKC still rewrites it onto mu', () => {
    // U+00B5 MICRO SIGN is the character a keyboard produces in "240µs" or
    // "10µF" -- it is correct text, not a disguise. NFKC canonicalises it to
    // U+03BC GREEK SMALL LETTER MU regardless of the fold table below; that
    // rewrite happens before folding and is expected. What matters is that
    // the result stays μ (U+03BC) rather than becoming a Latin 'u'.
    expect(normalizeText('latency=240µs')).toBe('latency=240μs');
  });

  it('leaves a token with an unmapped Greek-or-Coptic character and Latin unchanged', () => {
    // Ͱ-Ͽ is Greek *and* Coptic, and HOMOGLYPHS maps only a subset
    // of it. An unmapped in-range character (Coptic shei, here) now enters
    // the fold loop -- the guard used to cover Cyrillic only -- but
    // `HOMOGLYPHS[ch] ?? ch` reconstructs it identically, so the token comes
    // back untouched.
    expect(normalizeText('ϣϣϣtest')).toBe('ϣϣϣtest');
  });

  it('folds only the mapped character when an unmapped one shares a token with a mapped one and Latin', () => {
    // β has no HOMOGLYPHS entry; ο does. Mixing both into one Latin-bearing
    // token folds only ο -> o and leaves β exactly as it was.
    expect(normalizeText('βοtest')).toBe('βotest');
  });
});
