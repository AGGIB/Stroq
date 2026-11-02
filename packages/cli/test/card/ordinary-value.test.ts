import { describe, expect, it } from 'vitest';
import { isOrdinaryValue, namesGuard } from '../../src/card/ordinary-value.js';
import { scrubber } from '../../src/card/scrub.js';
import { keyFinder, type Key } from '../../src/sent/keys.js';
import { printableId } from '../../src/sent/run.js';

/**
 * A key value that is one ordinary word, such as a user or an environment name, is cut out of a name
 * instead of hiding the whole name: `/work/administrator-site` stays readable around the cut. Anything
 * longer, or of more than one word, keeps guarding names by its pieces. Every key, ordinary or not, is
 * still taken out of everything the card keeps and shows. All values here are made up.
 */

const LONG = 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3fG5hJ7k';
const PASSPHRASE = 'correct-horse-battery-staple';
const SLUG_TOKEN = 'a1b2c3d4-e5f6g7h8i9';
const key = (name: string, value: string): Key => ({ name, source: '.env', value });

describe('an ordinary value', () => {
  it.each([
    'admin',
    'root',
    'password',
    'postgres',
    'localhost',
    'production',
    'development',
    'administrator',
    'Production',
    'PRODUCTION',
    'staging',
  ])('%s is one ordinary word or name', (value) => {
    expect(isOrdinaryValue(value)).toBe(true);
  });

  it.each([
    // More than one word, or a word with more in it: a passphrase, a slug, a name.
    PASSPHRASE,
    SLUG_TOKEN,
    'correct-horse',
    'admin-site',
    'my_project_db',
    'webapp-prod-2',
    'my.app.db',
    'administrator-db',
    // One word, not one of the ordinary ones: it may be a password.
    'qwertyuiopas',
    'aDmIn',
    'administrators',
    // Short is not ordinary by itself: these hold digits or signs.
    'hunter2',
    'aB3$eF9',
    '1234567',
    'abc123',
    'p@ss',
    // Secret-shaped.
    LONG,
    'sk_live_' + '51Hx0aB3dE5gH7jK9',
    'AKIAIOSFODNN7EXAMPLE',
    '3f2b8c1e-9a4d-4e7b-8c3a-1d2e3f4a5b6c',
    'ghp_0123456789abcdefABCDEF0123456789abcd',
    'hunter2hunter2',
    'Welcome2024!',
    'abc123def456ghi',
    'aBcDeFgHiJkLmNoPqRsT',
    '12345678',
    '',
  ])('%s is not', (value) => {
    expect(isOrdinaryValue(value)).toBe(false);
  });
});

describe('the keys that guard a name', () => {
  it('leaves an ordinary value out and keeps every other', () => {
    const keys = [
      key('DB_USER', 'admin'),
      key('PW', 'hunter2'),
      key('PHRASE', PASSPHRASE),
      key('API_KEY', LONG),
    ];
    expect(keys.filter(namesGuard).map((k) => k.name)).toEqual(['PW', 'PHRASE', 'API_KEY']);
  });

  it('a finder with it cuts a word out of a name and hides a name that holds a secret', () => {
    const finder = keyFinder([key('DB_USER', 'administrator'), key('API_KEY', LONG)], namesGuard);
    expect(finder.shown('/work/administrator-site')).toBe('/work/[key]-site');
    expect(finder.shown('/work/ADMINISTRATOR-site/x')).toBe('/work/[key]-site/x');
    // A piece of a word is no key.
    expect(finder.shown('/work/administ-site')).toBe('/work/administ-site');
    // A secret hides the whole name, as before.
    expect(finder.shown(`/work/${LONG}`)).toBeNull();
    expect(finder.shown(`/work/${LONG.slice(5, 20)}-site`)).toBeNull();
    // The word is still a key: it is looked for, and found, in a session.
    expect(finder.find('DB_USER=administrator').map((f) => f.key.name)).toEqual(['DB_USER']);
  });

  it('a passphrase and a long slug-like token keep guarding names by their pieces', () => {
    const finder = keyFinder([key('PHRASE', PASSPHRASE), key('TOKEN', SLUG_TOKEN)], namesGuard);
    expect(finder.shown('/work/horse-battery-site')).toBeNull();
    expect(finder.shown('/work/battery')).toBeNull();
    expect(finder.shown('/work/e5f6g7h8-site')).toBeNull();
    expect(finder.shown('/work/ordinary-site')).toBe('/work/ordinary-site');
  });

  it('a short secret-shaped value still hides a name by its pieces', () => {
    const finder = keyFinder([key('PW', 'hunter2')], namesGuard);
    expect(finder.shown('/work/hunter2-site')).toBeNull();
    expect(finder.shown('/work/hunter-site')).toBeNull();
  });

  it('a name that holds a piece of a real key is hidden whole, next to an ordinary value', () => {
    const keys = [key('DB_USER', 'administrator'), key('API_KEY', LONG)];
    const finder = keyFinder(keys, namesGuard);
    expect(finder.shown(`/work/administrator/${LONG.slice(8, 16)}`)).toBeNull();
    // The cut is not made first: it would split the piece.
    expect(finder.shown(`/work/${LONG.slice(0, 7)}administrator${LONG.slice(7, 14)}`)).toBeNull();
  });

  it('an ordinary value inside a real key does not let a piece of that key through', () => {
    const inside = 'xqz9administratorW7pL2';
    const finder = keyFinder([key('DB_USER', 'administrator'), key('API_KEY', inside)], namesGuard);
    expect(finder.shown('/work/administrator-site')).toBeNull();
    expect(finder.shown('/work/qz9admin-site')).toBeNull();
  });

  it('a finder without it hides every name that holds a piece, as `stroq sent` does', () => {
    const finder = keyFinder([key('DB_USER', 'administrator')]);
    expect(finder.shown('/work/administrator-site')).toBeNull();
  });

  it('an id with a cut in it is not printed', () => {
    const finder = keyFinder([key('DB_USER', 'administrator')], namesGuard);
    expect(printableId('session-administrator-1', finder)).toBe('[an id that cannot be printed]');
    expect(printableId('session-1', finder)).toBe('session-1');
  });
});

describe('the scrubber takes out every key', () => {
  // The finder looks for values of twelve characters or more, as key files give them.
  const keys: Key[] = [
    key('DB_NAME', 'administrator'),
    key('DB_ADMIN', 'administrator-db'),
    key('DB_PASSWORD', 'hunter2hunter2'),
    key('PHRASE', PASSPHRASE),
    key('API_KEY', LONG),
  ];
  const scrub = scrubber(keyFinder(keys, namesGuard));

  it('takes the longer of two values out whole when one begins the other', () => {
    expect(scrub('cd /work/administrator-db/app')).toBe('cd /work/[key]/app');
  });

  it.each(['administrator', 'hunter2hunter2', PASSPHRASE, LONG])(
    '%s, in a path and in a command',
    (v) => {
      expect(scrub(`cd /work/${v}/app`)).toBe('cd /work/[key]/app');
      expect(scrub(`curl -u root:${v} https://x.invalid`)).toBe(
        'curl -u root:[key] https://x.invalid',
      );
    },
  );

  it('still takes out the shapes of well-known tokens', () => {
    expect(scrub('export T=ghp_0123456789abcdefABCDEF0123456789abcd')).toBe('export T=[key]');
  });
});
