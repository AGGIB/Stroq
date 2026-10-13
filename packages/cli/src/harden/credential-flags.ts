import { singleDashPasswordInWords } from './credential-commands.js';
import { isPlainName, secretUnderPair } from './credential-pairs.js';
import { isNumeric, isQuote, opaque, trimmed, USER_PASSWORD_MIN } from './credential-values.js';

/**
 * Secrets given on a command line: the value after a flag that says it is one (`--password
 * hunter2`, `--token=abc`), curl's `-u user:password`, and a header given with `-H`. The words of
 * the line are read one by one; every pattern is anchored and every test is bounded.
 */

const FLAG_VALUE_MIN = 6;
/** More than any flag in the lists below is long; a longer word is not looked up in them. */
const MAX_FLAG_CHARS = 32;

/** The flags whose value is a secret, spelled the way `--api_key` and `--API-KEY` are normalised. */
const SECRET_FLAGS: ReadonlySet<string> = new Set([
  'password',
  'passwd',
  'pass',
  'pwd',
  'token',
  'api-key',
  'apikey',
  'secret',
  'client-secret',
  'access-token',
  'auth-token',
  'bearer-token',
  'secret-key',
  'access-key',
  'private-key',
]);

/** curl's `-u user:password`. (`docker run -u 1000:1000` is a user and a group: see below.) */
const USER_FLAGS: ReadonlySet<string> = new Set(['-u', '--user', '--proxy-user']);
const HEADER_FLAGS: ReadonlySet<string> = new Set(['-H', '--header']);

/** `--API_Key` as `api-key`: the name of a flag, which is not the name of a variable. */
function flagName(token: string): string {
  return token.replace(/^-+/, '').replace(/_/g, '-').toLowerCase();
}

/** Whether `flag` (a whole argument, as written) is one whose value is a secret. */
export function isSecretFlag(flag: string): boolean {
  return flag.length <= MAX_FLAG_CHARS && flag.startsWith('--') && SECRET_FLAGS.has(flagName(flag));
}

/** Whether `flag` is one that takes `user:password`. */
export const isUserFlag = (flag: string): boolean =>
  flag.length <= MAX_FLAG_CHARS && USER_FLAGS.has(flag);

const isHeaderFlag = (flag: string): boolean =>
  flag.length <= MAX_FLAG_CHARS && HEADER_FLAGS.has(flag);

/** Whether `value`, found right after a secret flag, is a secret and not a stand-in. */
export const flagValueIsSecret = (value: string): boolean => opaque(value, FLAG_VALUE_MIN);

/**
 * Whether `value`, found right after a user flag, is `user:password` with a password. A user
 * name alone is not one, and neither is a group (`1000:1000`).
 */
export function userPasswordValue(value: string): boolean {
  const colon = value.indexOf(':');
  if (colon === -1) return false;
  const password = value.slice(colon + 1);
  return !isNumeric(password) && opaque(password, USER_PASSWORD_MIN);
}

/**
 * Whether a header given with `-H` or `--header` has a secret for a value. `first` is the word
 * after the flag as it was written, with its quote (`'X-Api-Key:`, or `'X-Api-Key:abcd'`) and
 * `second` the word after that, which is the value when the colon ends `first`.
 */
export function headerSecret(first: string, second: string): boolean {
  const head = trimmed(first);
  const colon = head.indexOf(':');
  if (colon <= 0) return false;
  const name = head.slice(0, colon);
  const inline = head.slice(colon + 1);
  // `'X-Api-Key:'`: the quote closes right after the colon, so the header has no value.
  const closed = first.length > 1 && isQuote(first.charCodeAt(0)) && first.endsWith(first[0] ?? '');
  const value = inline !== '' ? inline : closed ? '' : trimmed(second);
  return value !== '' && isPlainName(name) && secretUnderPair(name, value, false);
}

/**
 * Whether the words of a line hold a secret given on a command line: a secret flag with a secret
 * value after it, as separate words (`--password hunter2`) or joined (`--token=abc123`), a user
 * flag with a password, a single-dash password flag (`mysql -p...`, `redis-cli -a...`, `sshpass -p...`,
 * `docker/podman login -p...`), or a header with a secret in it.
 */
export function flagSecretInText(words: readonly string[]): boolean {
  if (singleDashPasswordInWords(words)) return true;
  for (let k = 0; k < words.length; k += 1) {
    const raw = words[k] ?? '';
    const word = trimmed(raw);
    if (!word.startsWith('-')) continue;
    const equals = word.indexOf('=');
    const flag = equals === -1 ? word : word.slice(0, equals);
    if (isHeaderFlag(flag)) {
      const joined = equals === -1 ? null : raw.slice(raw.indexOf('=') + 1);
      const hasSecret =
        joined === null
          ? headerSecret(words[k + 1] ?? '', words[k + 2] ?? '')
          : headerSecret(joined, words[k + 1] ?? '');
      if (hasSecret) return true;
      continue;
    }
    const secret = isSecretFlag(flag);
    if (!secret && !isUserFlag(flag)) continue;
    const value = equals === -1 ? trimmed(words[k + 1] ?? '') : trimmed(word.slice(equals + 1));
    if (secret ? flagValueIsSecret(value) : userPasswordValue(value)) return true;
  }
  return false;
}
