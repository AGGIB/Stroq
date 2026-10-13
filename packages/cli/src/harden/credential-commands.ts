import { opaque, trimmed } from './credential-values.js';

/**
 * Single-dash password flags and arguments for common CLI commands:
 * - `mysql`, `mariadb`, `mysqldump` with glued `-p<pass>` (e.g. `-pSecret`, `-p=Secret`)
 * - `docker login`, `podman login` with `-p`
 * - `sshpass` with `-p`
 * - `redis-cli` with `-a`
 *
 * For these commands, `-p` / `-a` is never a port (mysql's port flag is `-P`, redis-cli's is `-p`,
 * and `-a` is its password), so all-digit passwords are recognized as secrets.
 * Bare `-p` (interactive prompt without value) stays null.
 */

const USER_PASSWORD_MIN = 4;

const MYSQL_COMMANDS: ReadonlySet<string> = new Set(['mysql', 'mariadb', 'mysqldump']);
const WRAPPER_COMMANDS: ReadonlySet<string> = new Set([
  'sudo',
  'env',
  'exec',
  'xargs',
  'nohup',
  'time',
  'chroot',
]);

/** Normalises a command token, removing wrappers, paths and trailing extensions. */
function commandNameOf(raw: string): string {
  let s = trimmed(raw);
  const lower = s.toLowerCase();
  if (lower.startsWith('bash(')) {
    s = s.slice(5);
  }
  let start = 0;
  while (
    start < s.length &&
    (s[start] === '`' ||
      s[start] === '(' ||
      s[start] === '{' ||
      (s[start] === '$' && s[start + 1] === '('))
  ) {
    if (s[start] === '$') start += 2;
    else start += 1;
  }
  if (start > 0) s = s.slice(start);

  const slash = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  if (slash !== -1) s = s.slice(slash + 1);

  if (s.endsWith(':*)')) s = s.slice(0, -3);
  else if (s.endsWith(':*')) s = s.slice(0, -2);

  s = s.replace(/\.(?:exe|cmd|bat)$/i, '');
  return trimmed(s).toLowerCase();
}

/** Cleans a password argument value, stripping trailing wrappers or rule colons. */
function cleanPasswordValue(raw: string): string {
  let s = raw;
  if (s.endsWith(':*)')) s = s.slice(0, -3);
  else if (s.endsWith(':*')) s = s.slice(0, -2);
  return trimmed(s);
}

/** Whether a password value is opaque and meets minimum length. */
function isPasswordValue(val: string): boolean {
  return opaque(val, USER_PASSWORD_MIN);
}

/** Extracts the password value for a flag like `-p` or `-a`. */
function extractFlagValue(
  flag: string,
  word: string,
  nextWord: string | undefined,
): { readonly found: boolean; readonly value: string } {
  if (word === flag) {
    if (nextWord !== undefined) {
      return { found: true, value: cleanPasswordValue(nextWord) };
    }
    return { found: false, value: '' };
  }
  if (word.startsWith(`${flag}=`)) {
    return { found: true, value: cleanPasswordValue(word.slice(flag.length + 1)) };
  }
  if (word.startsWith(flag) && word.length > flag.length && word.charCodeAt(flag.length) !== 0x2d) {
    const raw = word.startsWith(`${flag}=`) ? word.slice(flag.length + 1) : word.slice(flag.length);
    return { found: true, value: cleanPasswordValue(raw) };
  }
  return { found: false, value: '' };
}

/**
 * Whether `words` contains single-dash password flags (`mysql -p...`, `docker login -p...`,
 * `sshpass -p...`, `redis-cli -a...`).
 *
 * Runs strictly in linear time O(N) over words with zero nested slicing.
 */
export function singleDashPasswordInWords(words: readonly string[]): boolean {
  let currentCmd: string | null = null;
  let dockerIsLogin = false;

  for (let i = 0; i < words.length; i += 1) {
    const raw = words[i] ?? '';
    if (raw === '') continue;

    const isChainOp = raw === '&&' || raw === '||' || raw === '|' || raw === '&' || raw === ';';
    const endsWithSep = raw.endsWith(';') || raw.endsWith('&');
    let word = endsWithSep ? raw.replace(/[;&]+$/, '') : raw;

    if (isChainOp) {
      currentCmd = null;
      dockerIsLogin = false;
      continue;
    }

    if (word.startsWith('#')) {
      word = word.replace(/^#+/, '');
      if (word === '') continue;
    }

    if (currentCmd === null) {
      if (word.startsWith('-') || word.includes('=')) {
        continue;
      }
      const name = commandNameOf(word);
      if (WRAPPER_COMMANDS.has(name)) {
        continue;
      }
      currentCmd = name;
      dockerIsLogin = false;
      if (endsWithSep) {
        currentCmd = null;
      }
      continue;
    }

    const name = commandNameOf(word);
    if (MYSQL_COMMANDS.has(name) || name === 'sshpass' || name === 'redis-cli') {
      currentCmd = name;
      dockerIsLogin = false;
      if (endsWithSep) {
        currentCmd = null;
      }
      continue;
    }

    if (MYSQL_COMMANDS.has(currentCmd)) {
      if (word.startsWith('-p') && word.length > 2 && word.charCodeAt(2) !== 0x2d) {
        const rawVal = word.startsWith('-p=') ? word.slice(3) : word.slice(2);
        const val = cleanPasswordValue(rawVal);
        if (isPasswordValue(val)) return true;
      }
    } else if (currentCmd === 'docker' || currentCmd === 'podman') {
      if (!dockerIsLogin) {
        if (!word.startsWith('-')) {
          if (name === 'login') {
            dockerIsLogin = true;
          } else {
            currentCmd = 'other';
          }
        }
      } else {
        const { found, value } = extractFlagValue('-p', word, words[i + 1]);
        if (found && isPasswordValue(value)) return true;
      }
    } else if (currentCmd === 'sshpass') {
      const { found, value } = extractFlagValue('-p', word, words[i + 1]);
      if (found && isPasswordValue(value)) return true;
    } else if (currentCmd === 'redis-cli') {
      const { found, value } = extractFlagValue('-a', word, words[i + 1]);
      if (found && isPasswordValue(value)) return true;
    }

    if (endsWithSep) {
      currentCmd = null;
      dockerIsLogin = false;
    }
  }

  return false;
}
