import { describe, expect, it } from 'vitest';
import { judgeValue } from '../../src/sent/key-quality.js';

/**
 * A value in a key file is traced only if it looks like a secret. An example or a placeholder
 * (`super-secret-jwt-token…`, `changeme`, `your-api-key-here`, a value the vendors print in their docs)
 * is in many sessions and in many files, and tracing it reports a send of a key that is no key. Every
 * secret-shaped value here is made up from a seeded generator; the placeholders are the usual ones.
 */

/** A small seeded generator, so that every run draws the same values. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const UPPER_ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const BASE64 = `${ALNUM}+/`;
const URLSAFE = `${ALNUM}-_`;
const HEX = '0123456789abcdef';
const draw = (rand: () => number, alphabet: string, n: number): string =>
  Array.from({ length: n }, () => alphabet[Math.floor(rand() * alphabet.length)]).join('');

/** The shapes of the secrets people keep in key files, drawn at random. */
const SHAPES: readonly (readonly [string, (r: () => number) => string])[] = [
  ['an AWS secret access key', (r) => draw(r, BASE64, 40)],
  ['an AWS access key id', (r) => `AKIA${draw(r, UPPER_ALNUM, 16)}`],
  ['a GitHub token', (r) => `ghp_${draw(r, ALNUM, 36)}`],
  ['a GitHub fine-grained token', (r) => `github_pat_${draw(r, `${ALNUM}_`, 82)}`],
  ['a Stripe live key', (r) => `sk_live_${draw(r, ALNUM, 24)}`],
  ['an OpenAI project key', (r) => `sk-proj-${draw(r, URLSAFE, 48)}`],
  ['an Anthropic key', (r) => `sk-ant-api03-${draw(r, URLSAFE, 80)}`],
  [
    'a Supabase JWT',
    (r) => `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${draw(r, URLSAFE, 120)}.${draw(r, URLSAFE, 43)}`,
  ],
  ['a 32-hex secret', (r) => draw(r, HEX, 32)],
  ['a 64-hex secret', (r) => draw(r, HEX, 64)],
  ['a 40-character base64 secret', (r) => draw(r, BASE64, 40)],
  ['a base64url token', (r) => draw(r, URLSAFE, 43)],
  [
    'a UUID',
    (r) =>
      `${draw(r, HEX, 8)}-${draw(r, HEX, 4)}-4${draw(r, HEX, 3)}-a${draw(r, HEX, 3)}-${draw(r, HEX, 12)}`,
  ],
  ['an npm token', (r) => `npm_${draw(r, ALNUM, 36)}`],
  [
    'a Slack token',
    (r) => `xoxb-${draw(r, '0123456789', 12)}-${draw(r, '0123456789', 12)}-${draw(r, ALNUM, 24)}`,
  ],
  ['a Google API key', (r) => `AIza${draw(r, URLSAFE, 35)}`],
  ['a SendGrid key', (r) => `SG.${draw(r, URLSAFE, 22)}.${draw(r, URLSAFE, 43)}`],
  ['a database password', (r) => draw(r, ALNUM, 20)],
  ['a password with signs', (r) => draw(r, `${ALNUM}!@#%^*-_`, 16)],
  ['a 24-character alphanumeric secret', (r) => draw(r, ALNUM, 24)],
];

describe('a value that looks like a secret is traced', () => {
  it.each(SHAPES)('%s', (_name, make) => {
    const rand = random(7);
    for (let i = 0; i < 300; i += 1) {
      const value = make(rand);
      expect(judgeValue(value), value).toEqual({ traced: true });
    }
  });

  it.each([
    ['sk_FAKEstripe0123456789abcdef'],
    ['FAKEawsSecretValue0123456789abcdefABCDEF'],
    ['FAKEnpmTokenValue0123456789abcdefXYZ'],
    ['FAKEtoken1Value0123456789abcdefXYZ'],
    ['sk-FAKEoaiKey0123456789abcdefghijkl'],
    ['AIzaFAKEfbKeyValue0123456789abcdefghijk'],
  ])('and so is a made-up test key, %s', (value) => {
    expect(judgeValue(value)).toEqual({ traced: true });
  });
});

describe('a weak password a person chose is traced', () => {
  // A password a person picks is a real secret and low in entropy by nature. It is traced unless it is
  // nothing but common words, which an example is and a password rarely is.
  it.each([
    ['hunter2hunter2'],
    ['Welcome2024!'],
    ['Summer2024Pass!'],
    ['MyDogRex1985!'],
    ['Tr0ub4dor&3xyz'],
    ['qazwsxedc123'],
    ['Passw0rd!2024x'],
  ])('%s', (value) => {
    expect(judgeValue(value)).toEqual({ traced: true });
  });
});

describe('an example or a placeholder is not traced', () => {
  it.each([
    // The usual placeholders.
    ['your-jwt-secret-here', 'a placeholder'],
    ['your_api_key_here', 'a placeholder'],
    ['insert-your-token-here', 'a placeholder'],
    ['replace-with-your-api-key', 'a placeholder'],
    ['changeme-changeme', 'a placeholder'],
    ['change-me-in-production', 'a placeholder'],
    ['xxxxxxxxxxxxxxxxxxxxxxxx', 'a placeholder'],
    ['sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxx', 'a placeholder'],
    // Mostly common words, as development defaults are.
    ['super-secret-jwt-token-with-at-least-32-characters-long', 'words'],
    ['supersecretjwtkey', 'words'],
    ['my-super-secret-password', 'words'],
    ['development-secret-key', 'words'],
    ['local-dev-worker-token', 'words'],
    ['worker-token-dev-only', 'words'],
    ['this-is-a-test-token-for-local-use', 'words'],
    ['correct-horse-battery-staple', 'words'],
    ['mysecretpassword', 'words'],
    ['password123', 'words'],
    // Not random: one repeated character, a short run, one class of character.
    ['aaaaaaaaaaaaaaaa', 'not random'],
    ['abababababababab', 'not random'],
    ['123456789012', 'not random'],
    ['abcdefghijklmnop', 'not random'],
    ['ABCDEFGHIJKLMNOP', 'not random'],
    // What the vendors print in their documentation.
    ['AKIAIOSFODNN7EXAMPLE', 'an example'],
    ['wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'an example'],
    ['sk_test_' + '4eC39HqLyjWDarjtT1zdp7dc', 'an example'],
    ['pk_test_TYooMQauvdEDq54NiTphI7jx', 'an example'],
    ['ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', 'a placeholder'],
  ])('%s', (value) => {
    const got = judgeValue(value);
    expect(got.traced, value).toBe(false);
  });

  it('says why in a few fixed words', () => {
    expect(judgeValue('your-jwt-secret-here')).toEqual({ traced: false, why: 'placeholder' });
    expect(judgeValue('super-secret-jwt-token-with-at-least-32-characters-long')).toEqual({
      traced: false,
      why: 'words',
    });
    expect(judgeValue('aaaaaaaaaaaaaaaa')).toEqual({ traced: false, why: 'not-random' });
    expect(judgeValue('AKIAIOSFODNN7EXAMPLE')).toEqual({ traced: false, why: 'example' });
  });
});

describe('the cost of the rule is read once', () => {
  it('a long value is judged in about its length', () => {
    const rand = random(3);
    const long = draw(rand, ALNUM, 200_000);
    const started = Date.now();
    judgeValue(long);
    judgeValue('a-'.repeat(100_000));
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
