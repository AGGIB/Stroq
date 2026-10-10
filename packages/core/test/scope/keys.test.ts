import { createHash, createPublicKey, sign, verify } from 'node:crypto';
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FileKeyStore,
  KeyStoreError,
  generateKeyPair,
  keyIdOf,
  nodeKeyFs,
  type KeyFs,
} from '../../src/scope/keys.js';
import { tempDir } from './helpers.js';

const posixOnly = process.platform === 'win32';
const modeOf = (path: string): number => statSync(path).mode & 0o777;

describe('generateKeyPair and keyIdOf', () => {
  it('makes an ed25519 pair that signs and verifies', () => {
    const { privateKey, publicKey } = generateKeyPair();
    expect(privateKey.asymmetricKeyType).toBe('ed25519');
    expect(publicKey.asymmetricKeyType).toBe('ed25519');
    const message = Buffer.from('hello');
    expect(verify(null, message, publicKey, sign(null, message, privateKey))).toBe(true);
  });

  it('makes a different pair every time', () => {
    expect(keyIdOf(generateKeyPair().publicKey)).not.toBe(keyIdOf(generateKeyPair().publicKey));
  });

  it('takes the key id from the first 16 hex characters of the sha256 of the public key DER', () => {
    const { publicKey } = generateKeyPair();
    const der = publicKey.export({ type: 'spki', format: 'der' });
    const expected = createHash('sha256').update(der).digest('hex').slice(0, 16);
    expect(keyIdOf(publicKey)).toBe(expected);
    expect(keyIdOf(publicKey)).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('FileKeyStore on the real file system', () => {
  it('creates permit.key and permit.pub under keys/ and returns the pair', () => {
    const home = tempDir('keys');
    const pair = new FileKeyStore({ home }).loadOrCreate();
    expect(existsSync(join(home, 'keys', 'permit.key'))).toBe(true);
    expect(existsSync(join(home, 'keys', 'permit.pub'))).toBe(true);
    expect(keyIdOf(pair.publicKey)).toBe(keyIdOf(createPublicKey(pair.privateKey)));
  });

  it('writes the private key as PKCS8 PEM and the public key as SPKI PEM', () => {
    const home = tempDir('keys');
    new FileKeyStore({ home }).loadOrCreate();
    expect(readFileSync(join(home, 'keys', 'permit.key'), 'utf8')).toMatch(
      /^-----BEGIN PRIVATE KEY-----\n[A-Za-z0-9+/=\n]+-----END PRIVATE KEY-----\n$/,
    );
    expect(readFileSync(join(home, 'keys', 'permit.pub'), 'utf8')).toMatch(
      /^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\n]+-----END PUBLIC KEY-----\n$/,
    );
  });

  it.skipIf(posixOnly)(
    'keeps the directory private, the private key 0600 and the public key 0644',
    () => {
      const home = tempDir('keys');
      new FileKeyStore({ home }).loadOrCreate();
      expect(modeOf(join(home, 'keys'))).toBe(0o700);
      expect(modeOf(join(home, 'keys', 'permit.key'))).toBe(0o600);
      expect(modeOf(join(home, 'keys', 'permit.pub'))).toBe(0o644);
    },
  );

  it('returns the same pair on a second call and never overwrites an existing key', () => {
    const home = tempDir('keys');
    const store = new FileKeyStore({ home });
    const first = store.loadOrCreate();
    const before = readFileSync(join(home, 'keys', 'permit.key'), 'utf8');
    const second = new FileKeyStore({ home }).loadOrCreate();
    expect(keyIdOf(second.publicKey)).toBe(keyIdOf(first.publicKey));
    expect(readFileSync(join(home, 'keys', 'permit.key'), 'utf8')).toBe(before);
  });

  it('writes the public key again when only the private key survived', () => {
    const home = tempDir('keys');
    const pair = new FileKeyStore({ home }).loadOrCreate();
    unlinkSync(join(home, 'keys', 'permit.pub'));
    const again = new FileKeyStore({ home }).loadOrCreate();
    expect(keyIdOf(again.publicKey)).toBe(keyIdOf(pair.publicKey));
    expect(existsSync(join(home, 'keys', 'permit.pub'))).toBe(true);
  });

  it('refuses an empty public key file instead of guessing what it should hold', () => {
    const home = tempDir('keys');
    new FileKeyStore({ home }).loadOrCreate();
    writeFileSync(join(home, 'keys', 'permit.pub'), '');
    expect(() => new FileKeyStore({ home }).loadOrCreate()).toThrow(KeyStoreError);
  });

  it('refuses a public key file that is another key than the private one', () => {
    const home = tempDir('keys');
    new FileKeyStore({ home }).loadOrCreate();
    const other = generateKeyPair().publicKey.export({ type: 'spki', format: 'pem' });
    writeFileSync(join(home, 'keys', 'permit.pub'), other);
    expect(() => new FileKeyStore({ home }).loadOrCreate()).toThrow(
      expect.objectContaining({ code: 'public-key-mismatch' }),
    );
  });

  it('reads the public key alone, which is all a hook holds', () => {
    const home = tempDir('keys');
    const pair = new FileKeyStore({ home }).loadOrCreate();
    const read = new FileKeyStore({ home }).readPublicKey();
    expect(read.kind).toBe('ok');
    if (read.kind === 'ok') {
      expect(read.keyId).toBe(keyIdOf(pair.publicKey));
      expect(keyIdOf(read.key)).toBe(read.keyId);
    }
  });

  it('reports an absent public key as absent and a garbage one as bad, without throwing', () => {
    const home = tempDir('keys');
    expect(new FileKeyStore({ home }).readPublicKey()).toEqual({ kind: 'absent' });
    new FileKeyStore({ home }).loadOrCreate();
    writeFileSync(join(home, 'keys', 'permit.pub'), 'not a key');
    expect(new FileKeyStore({ home }).readPublicKey()).toEqual({
      kind: 'bad',
      reason: 'not-a-key',
    });
  });

  it('refuses a public key that is not ed25519', async () => {
    const home = tempDir('keys');
    const { generateKeyPairSync } = await import('node:crypto');
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    new FileKeyStore({ home }).loadOrCreate();
    writeFileSync(
      join(home, 'keys', 'permit.pub'),
      rsa.publicKey.export({ type: 'spki', format: 'pem' }),
    );
    expect(new FileKeyStore({ home }).readPublicKey()).toEqual({
      kind: 'bad',
      reason: 'wrong-type',
    });
  });

  it('reads the private key only when asked', () => {
    const home = tempDir('keys');
    expect(new FileKeyStore({ home }).readPrivateKey()).toEqual({ kind: 'absent' });
    const pair = new FileKeyStore({ home }).loadOrCreate();
    const read = new FileKeyStore({ home }).readPrivateKey();
    expect(read.kind).toBe('ok');
    if (read.kind === 'ok')
      expect(keyIdOf(createPublicKey(read.key))).toBe(keyIdOf(pair.publicKey));
  });
});

/** A file system in memory that records what was asked of it. */
function memoryFs(): KeyFs & {
  files: Map<string, { data: string; mode: number }>;
  dirs: Map<string, number>;
} {
  const files = new Map<string, { data: string; mode: number }>();
  const dirs = new Map<string, number>();
  return {
    files,
    dirs,
    mkdirPrivate: (dir) => void dirs.set(dir, 0o700),
    writeExclusive: (path, data, mode) => {
      if (files.has(path)) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
      files.set(path, { data, mode });
    },
    read: (path) => {
      const file = files.get(path);
      if (file === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { kind: 'text', text: file.data, size: file.data.length };
    },
    chmod: (path, mode) => {
      const file = files.get(path);
      if (file) files.set(path, { ...file, mode });
    },
  };
}

describe('FileKeyStore with an injected file system', () => {
  it('asks for a private directory, a 0600 private key and a 0644 public key', () => {
    const fs = memoryFs();
    new FileKeyStore({ home: '/h', fs }).loadOrCreate();
    expect(fs.dirs.get(join('/h', 'keys'))).toBe(0o700);
    expect(fs.files.get(join('/h', 'keys', 'permit.key'))?.mode).toBe(0o600);
    expect(fs.files.get(join('/h', 'keys', 'permit.pub'))?.mode).toBe(0o644);
  });

  it('uses the home it is given and no other path', () => {
    const fs = memoryFs();
    new FileKeyStore({ home: '/some/home', fs }).loadOrCreate();
    for (const path of fs.files.keys())
      expect(path.startsWith(join('/some/home', 'keys'))).toBe(true);
  });

  it('never puts key text in an error: a failing write reports a code, not the text', () => {
    const marker = 'TOPSECRETKEYTEXT';
    const fs = memoryFs();
    const failing: KeyFs = {
      ...fs,
      writeExclusive: (_path, data) => {
        throw new Error(`disk refused ${data} ${marker}`);
      },
    };
    let caught: unknown;
    try {
      new FileKeyStore({ home: '/h', fs: failing }).loadOrCreate();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(KeyStoreError);
    const text = `${String(caught)} ${(caught as Error).message} ${JSON.stringify(caught)}`;
    expect(text).not.toContain(marker);
    expect(text).not.toContain('PRIVATE KEY');
    expect(text).not.toContain('BEGIN');
  });

  it('never puts key text in a typed read result either', () => {
    const marker = 'TOPSECRETKEYTEXT';
    const fs = memoryFs();
    fs.files.set(join('/h', 'keys', 'permit.key'), {
      data: `-----BEGIN PRIVATE KEY-----\n${marker}\n`,
      mode: 0o600,
    });
    fs.files.set(join('/h', 'keys', 'permit.pub'), {
      data: `-----BEGIN PUBLIC KEY-----\n${marker}\n`,
      mode: 0o644,
    });
    const store = new FileKeyStore({ home: '/h', fs });
    expect(JSON.stringify(store.readPrivateKey())).not.toContain(marker);
    expect(JSON.stringify(store.readPublicKey())).not.toContain(marker);
    let caught: unknown;
    try {
      store.loadOrCreate();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(KeyStoreError);
    expect(`${String(caught)} ${JSON.stringify(caught)}`).not.toContain(marker);
  });

  it('reports a read that throws as a bad key, not as a crash', () => {
    const fs: KeyFs = {
      ...memoryFs(),
      read: () => {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      },
    };
    expect(new FileKeyStore({ home: '/h', fs }).readPublicKey()).toEqual({
      kind: 'bad',
      reason: 'unreadable',
    });
    expect(new FileKeyStore({ home: '/h', fs }).readPrivateKey()).toEqual({
      kind: 'bad',
      reason: 'unreadable',
    });
  });

  it('reports a key file that is not a regular file or is oversize as bad', () => {
    const fs: KeyFs = { ...memoryFs(), read: () => ({ kind: 'not-regular' }) };
    expect(new FileKeyStore({ home: '/h', fs }).readPublicKey()).toEqual({
      kind: 'bad',
      reason: 'not-regular',
    });
    const big: KeyFs = { ...memoryFs(), read: () => ({ kind: 'too-large', size: 99999 }) };
    expect(new FileKeyStore({ home: '/h', fs: big }).readPrivateKey()).toEqual({
      kind: 'bad',
      reason: 'too-large',
    });
  });
});

describe('nodeKeyFs', () => {
  it('refuses to write over a file that exists', () => {
    const dir = tempDir('keys');
    const path = join(dir, 'x');
    nodeKeyFs.writeExclusive(path, 'one', 0o600);
    expect(() => nodeKeyFs.writeExclusive(path, 'two', 0o600)).toThrow(/EEXIST/);
    expect(readFileSync(path, 'utf8')).toBe('one');
  });
});
