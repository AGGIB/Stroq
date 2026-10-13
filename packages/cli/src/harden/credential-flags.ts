import { isPlainName, secretUnderPair } from './credential-pairs.js';
import { isNumeric, isQuote, opaque, trimmed } from './credential-values.js';

/**
 * Secrets given on a command line: the value after a flag that says it is one (`--password
 * hunter2`, `--token=abc`), curl's `-u user:password`, and a header given with `-H`. The words of
 * the line are read one by one; every pattern is anchored and every test is bounded.
 */

const FLAG_VALUE_MIN = 6;
/** As for the password in the front of a URL. */
const USER_PASSWORD_MIN = 4;
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

const LAUNCHERS: ReadonlySet<string> = new Set([
  'sudo',
  'env',
  'exec',
  'nohup',
  'time',
  'builtin',
  'command',
  'eval',
]);

const MYSQL_COMMANDS: ReadonlySet<string> = new Set(['mysql', 'mariadb', 'mysqldump']);

/** Normalises a command token, removing wrappers such as `Bash(`, `$(`, paths and trailing syntax. */
function cleanCommand(raw: string): string {
  let s = trimmed(raw);
  const lower = s.toLowerCase();
  if (lower.startsWith('bash(')) {
    s = s.slice(5);
  } else if (lower.startsWith('mcp(')) {
    s = s.slice(4);
  }
  while (s.startsWith('$(')) {
    s = s.slice(2);
  }
  while (s.startsWith('`') || s.startsWith('(') || s.startsWith('{')) {
    s = s.slice(1);
  }
  if (s.includes('/')) {
    s = s.slice(s.lastIndexOf('/') + 1);
  }
  while (s.endsWith(':*)')) {
    s = s.slice(0, -3);
  }
  while (s.endsWith(':*')) {
    s = s.slice(0, -2);
  }
  while (s.endsWith(')') || s.endsWith('}') || s.endsWith('`') || s.endsWith(';')) {
    s = s.slice(0, -1);
  }
  return trimmed(s).toLowerCase();
}

/** Cleans a password argument value, stripping trailing wrappers, quotes and semicolons. */
function cleanPasswordValue(raw: string): string {
  let s = trimmed(raw);
  while (s.endsWith(':*)')) {
    s = s.slice(0, -3);
  }
  while (s.endsWith(':*')) {
    s = s.slice(0, -2);
  }
  while (s.endsWith(')') || s.endsWith('}') || s.endsWith(';') || s.endsWith(',')) {
    s = s.slice(0, -1);
  }
  return trimmed(s);
}

function isPasswordValue(val: string): boolean {
  if (val === '' || isNumeric(val)) return false;
  return opaque(val, USER_PASSWORD_MIN);
}

function flagValueInWords(words: readonly string[], flag: string): boolean {
  for (let j = 0; j < words.length; j += 1) {
    const w = words[j] ?? '';
    if (w === flag) {
      const val = cleanPasswordValue(words[j + 1] ?? '');
      if (isPasswordValue(val)) return true;
    } else if (w.startsWith(`${flag}=`)) {
      const val = cleanPasswordValue(w.slice(flag.length + 1));
      if (isPasswordValue(val)) return true;
    } else if (w.startsWith(flag) && w.length > flag.length && w.charCodeAt(flag.length) !== 0x2d) {
      const val = cleanPasswordValue(w.slice(flag.length));
      if (isPasswordValue(val)) return true;
    }
  }
  return false;
}

function commandSegments(words: readonly string[]): string[][] {
  const segments: string[][] = [];
  let current: string[] = [];
  for (const word of words) {
    if (word === '' || word === '#') break;
    if (word === '&&' || word === '||' || word === '|' || word === '&' || word === ';') {
      if (current.length > 0) segments.push(current);
      current = [];
    } else if (word.endsWith(';') || word.endsWith('&')) {
      current.push(word.slice(0, -1));
      if (current.length > 0) segments.push(current);
      current = [];
    } else {
      current.push(word);
    }
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

function singleDashPasswordInWords(words: readonly string[]): boolean {
  const segments = commandSegments(words);
  for (const seg of segments) {
    let cmd = '';
    let cmdIndex = -1;
    for (let i = 0; i < seg.length; i += 1) {
      const raw = seg[i] ?? '';
      if (raw.startsWith('-')) continue;
      const eq = raw.indexOf('=');
      if (eq > 0 && !raw.startsWith('Bash(') && !raw.startsWith('MCP(') && !raw.startsWith('$(')) {
        continue;
      }
      const cleaned = cleanCommand(raw);
      if (cleaned === '' || LAUNCHERS.has(cleaned)) continue;
      cmd = cleaned;
      cmdIndex = i;
      break;
    }
    if (cmd === '' || cmdIndex === -1) continue;

    const rest = seg.slice(cmdIndex + 1);

    if (MYSQL_COMMANDS.has(cmd)) {
      for (const w of rest) {
        if (w.startsWith('-p') && w.length > 2 && w.charCodeAt(2) !== 0x2d) {
          const rawVal = w.startsWith('-p=') ? w.slice(3) : w.slice(2);
          const val = cleanPasswordValue(rawVal);
          if (isPasswordValue(val)) return true;
        }
      }
      continue;
    }

    if (cmd === 'docker' || cmd === 'podman') {
      const hasLogin = rest.some((w) => cleanCommand(w) === 'login');
      if (hasLogin && flagValueInWords(rest, '-p')) return true;
      continue;
    }

    if (cmd === 'sshpass') {
      if (flagValueInWords(rest, '-p')) return true;
      continue;
    }

    if (cmd === 'redis-cli') {
      if (flagValueInWords(rest, '-a')) return true;
      continue;
    }
  }
  return false;
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
