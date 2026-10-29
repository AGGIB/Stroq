import { createHmac, randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { keysDirIn } from './paths.js';

/**
 * A per-home secret that authenticates Stroq's own state files: the MCP call-control history, the MCP
 * tool-contract records and the `harden` manifest, each under a domain label of its own.
 * A file that is rewritten by anything that does not hold the key no longer verifies, so a forged
 * "resume" or approval made by plain file writes is refused. It is tamper-evident against a process
 * that cannot write `<home>/keys`, not a boundary: a process of the same user that can read the key, or
 * write a new one there (no read needed) and sign again, gets through. Stroq's hooks deny an agent's
 * writes under `~/.stroq`, and `stroq run --sandbox` write-protects the keys folder. Nor does a
 * tag stop a rollback: an older file this home signed still verifies when it is put back. The MCP
 * readers refuse one older than what they have already accepted while they run (a sequence inside the
 * signed body); a process that starts after the old file was put back accepts it.
 */

const KEY_FILE = 'state-mac.key';
const KEY_BYTES = 32;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

export class StateMacKeyError extends Error {
  constructor(readonly code: 'state-mac-key-unsafe') {
    super(code);
  }
}

/** Where the key of `home` lives, for a message that tells a person what to put back or fix. */
export const stateMacKeyFileIn = (home: string): string => join(keysDirIn(home), KEY_FILE);
const keyPath = stateMacKeyFileIn;

function readKey(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    const owner = typeof process.getuid === 'function' ? process.getuid() : null;
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size !== KEY_BYTES ||
      (owner !== null && stat.uid !== owner) ||
      (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
    )
      throw new StateMacKeyError('state-mac-key-unsafe');
    const key = Buffer.alloc(KEY_BYTES);
    if (readSync(fd, key, 0, KEY_BYTES, 0) !== KEY_BYTES)
      throw new StateMacKeyError('state-mac-key-unsafe');
    return key;
  } finally {
    closeSync(fd);
  }
}

/** The key, or null when this home has none yet. A key that exists but is not private is an error. */
export function readStateMacKeySync(home: string): Buffer | null {
  const path = keyPath(home);
  try {
    if (lstatSync(path).isSymbolicLink()) throw new StateMacKeyError('state-mac-key-unsafe');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  return readKey(path);
}

/** The key, made on first use with mode 0600 inside a 0700 keys folder. Two writers racing get one key. */
export function ensureStateMacKeySync(home: string): Buffer {
  const existing = readStateMacKeySync(home);
  if (existing) return existing;
  mkdirSync(keysDirIn(home), { recursive: true, mode: 0o700 });
  const path = keyPath(home);
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
      0o600,
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return readKey(path);
    throw e;
  }
  try {
    const key = randomBytes(KEY_BYTES);
    writeSync(fd, key, 0, KEY_BYTES, 0);
    return key;
  } finally {
    closeSync(fd);
  }
}

/** HMAC-SHA256 over a domain label and the bytes, as hex. The label keeps one file's tag from fitting another. */
export function stateMac(key: Buffer, domain: string, bytes: string | Buffer): string {
  return createHmac('sha256', key)
    .update(`stroq-state-mac/1\n${domain}\n`)
    .update(bytes)
    .digest('hex');
}
