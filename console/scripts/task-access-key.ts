import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { keyIdOf } from '@stroq/core';
import { fail, filePin, same, type FilePin, type Location } from './task-lock-files.js';

/** Existing key only. No text projection, initialization, repair, chmod or parent-process copy. */
export async function existingSigningKey(
  root: Location,
  expected: FilePin,
  publicKey: KeyObject,
  keyId: string,
): Promise<KeyObject> {
  let handle, bytes: Buffer | undefined;
  try {
    const path = join(root.home, 'keys', 'permit.key'),
      before = await lstat(path, { bigint: true });
    if (
      !same(filePin(before), expected) ||
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size <= 0n ||
      before.size > 4096n ||
      (before.mode & 0o777n) !== 0o600n ||
      (typeof process.getuid === 'function' && before.uid !== BigInt(process.getuid()))
    )
      fail('signing-key-unavailable');
    handle = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    const first = await handle.stat({ bigint: true });
    if (!same(filePin(first), expected)) fail('signing-key-unavailable');
    bytes = Buffer.alloc(Number(first.size) + 1);
    let filled = 0;
    while (filled < bytes.length) {
      const read = await handle.read(bytes, filled, bytes.length - filled, filled);
      if (read.bytesRead === 0) break;
      filled += read.bytesRead;
    }
    if (
      filled !== Number(first.size) ||
      !same(filePin(await handle.stat({ bigint: true })), expected) ||
      !same(filePin(await lstat(path, { bigint: true })), expected)
    )
      fail('signing-key-unavailable');
    let key: KeyObject;
    try {
      key = createPrivateKey({ key: bytes.subarray(0, filled), format: 'pem' });
    } catch {
      fail('signing-key-unavailable');
    }
    if (key.asymmetricKeyType !== 'ed25519') fail('signing-key-unavailable');
    const derived = createPublicKey(key);
    if (
      keyIdOf(derived) !== keyId ||
      !derived
        .export({ type: 'spki', format: 'der' })
        .equals(publicKey.export({ type: 'spki', format: 'der' }))
    )
      fail('signing-key-mismatch');
    return key;
  } catch (error) {
    if (
      error instanceof Error &&
      ['signing-key-unavailable', 'signing-key-mismatch'].includes(error.message)
    )
      throw error;
    return fail('signing-key-unavailable');
  } finally {
    bytes?.fill(0);
    await handle?.close();
  }
}
