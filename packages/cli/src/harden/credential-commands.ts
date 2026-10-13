import { opaque, trimmed, USER_PASSWORD_MIN } from './credential-values.js';

/**
 * Single-dash password flags and arguments for common CLI commands:
 * - `mysql`, `mariadb`, `mysqldump`, `mysqladmin`, etc. with glued `-p<pass>` (e.g. `-pSecret`, `-p=Secret`)
 * - `docker login`, `podman login` with `-p`
 * - `sshpass` with `-p`
 * - `redis-cli` with `-a`
 *
 * For these commands, `-p` / `-a` is never a port (mysql's port flag is `-P`, redis-cli's is `-p`,
 * and `-a` is its password), so all-digit passwords are recognized as secrets.
 * Bare `-p` (interactive prompt without value) stays null.
 */

const MYSQL_COMMANDS: ReadonlySet<string> = new Set([
  'mysql',
  'mariadb',
  'mysqldump',
  'mysqladmin',
  'mariadb-dump',
  'mariadb-admin',
  'mysqlcheck',
  'mysqlimport',
]);

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

/** Whether a value matches a container port mapping like 3306:3306 or 8080:80. */
function isPortMapping(val: string): boolean {
  return /^(?:(?:\d{1,3}\.){3}\d{1,3}:)?\d+(?:-\d+)?:(?:\d+(?:-\d+)?)(?:\/(?:tcp|udp))?$/i.test(
    val,
  );
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
    const raw = word.slice(flag.length);
    return { found: true, value: cleanPasswordValue(raw) };
  }
  return { found: false, value: '' };
}

function checkMysql(word: string): boolean {
  if (word.startsWith('-p') && word.length > 2 && word.charCodeAt(2) !== 0x2d) {
    const rawVal = word.startsWith('-p=') ? word.slice(3) : word.slice(2);
    const val = cleanPasswordValue(rawVal);
    if (!isPortMapping(val) && isPasswordValue(val)) return true;
  }
  return false;
}

function checkDockerLogin(word: string, nextWord: string | undefined): boolean {
  const { found, value } = extractFlagValue('-p', word, nextWord);
  return found && isPasswordValue(value);
}

function checkRedisCli(word: string, nextWord: string | undefined): boolean {
  const { found, value } = extractFlagValue('-a', word, nextWord);
  return found && isPasswordValue(value);
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
  let sshpassExpectArg = false;

  for (let i = 0; i < words.length; i += 1) {
    const raw = words[i] ?? '';
    if (raw === '') continue;

    const isChainOp = raw === '&&' || raw === '||' || raw === '|' || raw === '&' || raw === ';';
    let end = raw.length;
    while (end > 0 && (raw.charCodeAt(end - 1) === 0x3b || raw.charCodeAt(end - 1) === 0x26)) {
      end -= 1;
    }
    const endsWithSep = end < raw.length;
    let word = endsWithSep ? raw.slice(0, end) : raw;

    if (isChainOp) {
      currentCmd = null;
      dockerIsLogin = false;
      sshpassExpectArg = false;
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
      sshpassExpectArg = false;
      if (endsWithSep) {
        currentCmd = null;
      }
      continue;
    }

    const name = commandNameOf(word);

    // Only allow switching to mysql/redis-cli if not inside docker run or sshpass or other
    if (
      currentCmd !== 'docker-run' &&
      currentCmd !== 'other' &&
      currentCmd !== 'sshpass' &&
      (MYSQL_COMMANDS.has(name) || name === 'sshpass' || name === 'redis-cli')
    ) {
      currentCmd = name;
      dockerIsLogin = false;
      sshpassExpectArg = false;
      if (endsWithSep) {
        currentCmd = null;
      }
      continue;
    }

    if (MYSQL_COMMANDS.has(currentCmd)) {
      if (checkMysql(word)) return true;
    } else if (currentCmd === 'docker' || currentCmd === 'podman') {
      if (!dockerIsLogin) {
        if (!word.startsWith('-')) {
          if (name === 'login') {
            dockerIsLogin = true;
          } else if (name === 'run') {
            currentCmd = 'docker-run';
          } else if (name === 'exec') {
            currentCmd = 'exec';
          } else {
            currentCmd = 'other';
          }
        }
      } else {
        if (checkDockerLogin(word, words[i + 1])) return true;
      }
    } else if (currentCmd === 'sshpass') {
      if (sshpassExpectArg) {
        sshpassExpectArg = false;
      } else if (word === '-p') {
        sshpassExpectArg = true;
        const next = words[i + 1];
        if (next !== undefined && isPasswordValue(cleanPasswordValue(next))) return true;
      } else if (word.startsWith('-p') && word.charCodeAt(2) !== 0x2d) {
        const raw = word.startsWith('-p=') ? word.slice(3) : word.slice(2);
        if (isPasswordValue(cleanPasswordValue(raw))) return true;
      } else if (word === '-f' || word === '-d' || word === '-P') {
        sshpassExpectArg = true;
      } else if (word.startsWith('-')) {
        // Other option flag (e.g. -e, -v, glued -f..., -d..., -P...)
      } else {
        // Reached the command (ssh, scp, etc.)
        currentCmd = 'other';
      }
    } else if (currentCmd === 'redis-cli') {
      if (checkRedisCli(word, words[i + 1])) return true;
    }

    if (endsWithSep) {
      currentCmd = null;
      dockerIsLogin = false;
      sshpassExpectArg = false;
    }
  }

  return false;
}
