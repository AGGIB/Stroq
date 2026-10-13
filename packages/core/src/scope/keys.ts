import {
  type KeyObject,
  createHash,
  randomBytes,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
} from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { type RegularFileRead, readRegularFile } from '../util/read-regular-file.js';

/**
 * The signing key of the task lock: ed25519, from `node:crypto` and nothing else.
 *
 * The private key stays with the person (the launcher, `stroq permit`); a hook holds only the
 * public one, so a hook, and an agent that can read what a hook reads, cannot make a permit.
 * Where the agent can reach the private key file the permit is advice and not a limit, and the
 * mode of the run says so; nothing here pretends otherwise.
 */

export interface KeyPair {
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
}

export function generateKeyPair(): KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicKey };
}

/** The first 16 hex characters of the sha256 of the public key's DER: a name for a key, not a secret. */
export function keyIdOf(publicKey: KeyObject): string {
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex').slice(0, 16);
}

export type KeyFileProblem =
  'unreadable' | 'not-regular' | 'too-large' | 'not-a-key' | 'wrong-type';

export type PublicKeyRead =
  | { readonly kind: 'ok'; readonly key: KeyObject; readonly keyId: string }
  | { readonly kind: 'absent' }
  | { readonly kind: 'bad'; readonly reason: KeyFileProblem };

export type PrivateKeyRead =
  | { readonly kind: 'ok'; readonly key: KeyObject }
  | { readonly kind: 'absent' }
  | { readonly kind: 'bad'; readonly reason: KeyFileProblem };

export type KeyStoreErrorCode = KeyFileProblem | 'write-failed' | 'public-key-mismatch';

/**
 * A fixed message and a code. Never the text of a lower-level error and never any part of a
 * key: the messages of `crypto` and `fs` can carry paths and, for a PEM that failed to parse,
 * fragments of it, and this error ends up in a terminal and a log.
 */
export class KeyStoreError extends Error {
  readonly code: KeyStoreErrorCode;
  constructor(code: KeyStoreErrorCode, which: 'private key' | 'public key' | 'key directory') {
    super(`permit key store: ${which}: ${code}`);
    this.name = 'KeyStoreError';
    this.code = code;
  }
}

/** The few file operations the store needs, so that a test can supply its own. */
export interface KeyFs {
  /** Makes the directory and every missing parent, private to the user (0700). */
  mkdirPrivate(dir: string): void;
  /** Creates a new file with `mode` and writes `data`; throws `EEXIST` rather than replace one. */
  writeExclusive(path: string, data: string, mode: number): void;
  read(path: string, maxBytes: number): RegularFileRead;
  chmod(path: string, mode: number): void;
}

const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_KEY_MODE = 0o600;
const PUBLIC_KEY_MODE = 0o644;
const MAX_KEY_FILE_BYTES = 4096;

const CREATE_NEW =
  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);

export const nodeKeyFs: KeyFs = {
  mkdirPrivate(dir) {
    // `chmod` follows a link, and a link where the directory should be would have it change the
    // rights of whatever the link points at.
    let existing = null;
    try {
      existing = lstatSync(dir);
    } catch (err) {
      if (!isMissing(err)) throw err;
    }
    if (existing?.isSymbolicLink() === true)
      throw Object.assign(new Error('the key directory is a link'), { code: 'ELOOP' });
    mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
    // `mkdir` applies the umask, and the directory may have existed with wider rights.
    chmodSync(dir, PRIVATE_DIR_MODE);
  },
  // The file appears whole or not at all: it is written under another name and linked into place,
  // and `link` fails with EEXIST where a file is, as `O_EXCL` would. A crash in the middle leaves
  // a temporary file and no key file that is empty and so can never be read.
  writeExclusive(path, data, mode) {
    const temp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    const fd = openSync(temp, CREATE_NEW, mode);
    try {
      try {
        writeSync(fd, data);
      } finally {
        closeSync(fd);
      }
      linkSync(temp, path);
    } finally {
      try {
        unlinkSync(temp);
      } catch {
        // Nothing to clean up that matters: the name is unique and the file holds the same bytes.
      }
    }
  },
  read: (path, maxBytes) => readRegularFile(path, maxBytes, { noFollow: true }),
  chmod: (path, mode) => chmodSync(path, mode),
};

export interface FileKeyStoreOptions {
  /** The Stroq home: keys live in `<home>/keys`. Always given, so a test never touches the real one. */
  readonly home: string;
  readonly fs?: KeyFs;
}

type KeyText = { readonly kind: 'text'; readonly text: string } | { readonly kind: 'absent' };

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

export class FileKeyStore {
  private readonly dir: string;
  private readonly privatePath: string;
  private readonly publicPath: string;
  private readonly fs: KeyFs;

  constructor(options: FileKeyStoreOptions) {
    this.dir = join(options.home, 'keys');
    this.privatePath = join(this.dir, 'permit.key');
    this.publicPath = join(this.dir, 'permit.pub');
    this.fs = options.fs ?? nodeKeyFs;
  }

  /** The text of a key file, `absent` if there is none, or the reason it cannot be used. */
  private readText(path: string): KeyText | KeyFileProblem {
    try {
      const read = this.fs.read(path, MAX_KEY_FILE_BYTES);
      return read.kind === 'text' ? read : read.kind === 'too-large' ? 'too-large' : 'not-regular';
    } catch (err) {
      return isMissing(err) ? { kind: 'absent' } : 'unreadable';
    }
  }

  readPublicKey(): PublicKeyRead {
    const text = this.readText(this.publicPath);
    if (typeof text === 'string') return { kind: 'bad', reason: text };
    if (text.kind === 'absent') return text;
    try {
      const key = createPublicKey(text.text);
      if (key.asymmetricKeyType !== 'ed25519') return { kind: 'bad', reason: 'wrong-type' };
      return { kind: 'ok', key, keyId: keyIdOf(key) };
    } catch {
      return { kind: 'bad', reason: 'not-a-key' };
    }
  }

  readPrivateKey(): PrivateKeyRead {
    const text = this.readText(this.privatePath);
    if (typeof text === 'string') return { kind: 'bad', reason: text };
    if (text.kind === 'absent') return text;
    try {
      const key = createPrivateKey(text.text);
      if (key.asymmetricKeyType !== 'ed25519') return { kind: 'bad', reason: 'wrong-type' };
      return { kind: 'ok', key };
    } catch {
      return { kind: 'bad', reason: 'not-a-key' };
    }
  }

  /**
   * The pair on disk, made first if there is none. An existing key is never replaced: a
   * second pair would void every permit signed with the first, and a replaced key file is a
   * thing to be told about, not to repair. A public key that is missing is written again from
   * the private one; one that is there and differs is an error.
   */
  loadOrCreate(): KeyPair {
    try {
      this.fs.mkdirPrivate(this.dir);
    } catch {
      throw new KeyStoreError('write-failed', 'key directory');
    }
    const privateKey = this.privateKeyOrNew();
    const publicKey = createPublicKey(privateKey);
    this.checkPublicKey(publicKey);
    return { privateKey, publicKey };
  }

  private privateKeyOrNew(): KeyObject {
    const existing = this.readPrivateKey();
    if (existing.kind === 'ok') return existing.key;
    if (existing.kind === 'bad') throw new KeyStoreError(existing.reason, 'private key');
    const fresh = generateKeyPair();
    const pem = fresh.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    try {
      this.fs.writeExclusive(this.privatePath, pem, PRIVATE_KEY_MODE);
      this.fs.chmod(this.privatePath, PRIVATE_KEY_MODE);
    } catch (err) {
      // Another process made the key between the read and the write: use its key, not ours.
      const raced = (err as NodeJS.ErrnoException | null)?.code === 'EEXIST';
      const theirs = raced ? this.readPrivateKey() : null;
      if (theirs?.kind === 'ok') return theirs.key;
      throw new KeyStoreError('write-failed', 'private key');
    }
    return fresh.privateKey;
  }

  private checkPublicKey(derived: KeyObject): void {
    const onDisk = this.readPublicKey();
    if (onDisk.kind === 'bad') throw new KeyStoreError(onDisk.reason, 'public key');
    if (onDisk.kind === 'ok') {
      if (onDisk.keyId !== keyIdOf(derived))
        throw new KeyStoreError('public-key-mismatch', 'public key');
      return;
    }
    try {
      const pem = derived.export({ type: 'spki', format: 'pem' }) as string;
      this.fs.writeExclusive(this.publicPath, pem, PUBLIC_KEY_MODE);
      this.fs.chmod(this.publicPath, PUBLIC_KEY_MODE);
    } catch {
      throw new KeyStoreError('write-failed', 'public key');
    }
  }
}
