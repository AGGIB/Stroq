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
});
