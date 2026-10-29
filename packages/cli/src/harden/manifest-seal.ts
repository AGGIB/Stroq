import { timingSafeEqual } from 'node:crypto';
import { stableStringify } from '@stroq/core';
import {
  StateMacKeyError,
  ensureStateMacKeySync,
  readStateMacKeySync,
  stateMac,
  stateMacKeyFileIn,
} from '../state-mac.js';
import { HardenError } from './types.js';

/**
 * Signing the manifest. It tells `undo` what to put back and where, so a manifest that anything but
 * this Stroq home wrote must not be used: a writer to `<home>/harden` and `<home>/backups` could
 * otherwise point an undo at a copy of its own. The manifest carries a `mac`, an HMAC under the home's
 * state key (`state-mac.ts`) over its version and files. The tag covers what the manifest says (the
 * files as they parse back), not how it is laid out, so the text can be indented again without
 * losing it, and the copies it names are checked against the sha256 it records (`backup.ts`).
 *
 * Tamper-evident, not a boundary: a process of the same user that can read `<home>/keys`, or write a
 * key of its own there, can still sign,
 * and one that kept an older manifest that this home signed can put it back, which verifies. Undo
 * still restores a copy only when the file is exactly as the recorded apply left it.
 */

export const MANIFEST_VERSION = 2;
const DOMAIN = 'harden-manifest';

const tagOf = (key: Buffer, files: unknown): string =>
  stateMac(key, DOMAIN, stableStringify({ version: MANIFEST_VERSION, files }));

/** What `writeManifest` writes for `files`, already in path order: the text with its tag. */
export function signedManifestText(files: Readonly<Record<string, unknown>>, key: Buffer): string {
  const doc = { version: MANIFEST_VERSION, files, mac: tagOf(key, files) };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

function keyOrRefusal<T>(home: string, file: string, read: () => T): T {
  try {
    return read();
  } catch (err) {
    if (!(err instanceof StateMacKeyError)) throw err;
    throw new HardenError(
      'manifest-unverified',
      `the key that signs ${file} (${stateMacKeyFileIn(home)}) is not a private file of yours (a regular 32-byte file of mode 0600, owned by you, not a link), so Stroq does not use the manifest and changed nothing`,
      { cause: err },
    );
  }
}

/** The key a signed manifest is checked with: refused when it is missing or not private. */
export function verifyingKey(home: string, file: string): Buffer {
  const key = keyOrRefusal(home, file, () => readStateMacKeySync(home));
  if (key !== null) return key;
  throw new HardenError(
    'manifest-unverified',
    `${file} is signed, but the key that checks it (${stateMacKeyFileIn(home)}) is missing, so Stroq does not use it and changed nothing. Put the key back, or move ${file} aside and run \`stroq harden apply\` again`,
  );
}

/** The key a manifest is signed with, made on first use. */
export const signingKey = (home: string, file: string): Buffer =>
  keyOrRefusal(home, file, () => ensureStateMacKeySync(home));

/** Refuses a manifest whose tag is not the one `key` makes of its files as they were read. */
export function assertSigned(file: string, key: Buffer, files: unknown, mac: string): void {
  const expected = Buffer.from(tagOf(key, files), 'hex');
  const found = Buffer.from(mac, 'hex');
  if (found.length === expected.length && timingSafeEqual(found, expected)) return;
  throw new HardenError(
    'manifest-unverified',
    `${file} does not match its signature: something other than Stroq changed it after Stroq wrote it, so Stroq does not use it and changed nothing. Look at what changed, then move it aside and run \`stroq harden apply\` again`,
  );
}

/** A version 1 manifest: written before manifests were signed, so nothing in it is trusted. */
export const unsignedManifest = (file: string): HardenError =>
  new HardenError(
    'manifest-unsigned',
    `${file} was written by an earlier Stroq and is not signed, so Stroq no longer trusts it to say what to restore or remove, and changed nothing. Move it aside and run \`stroq harden apply\` again. What the earlier applies added stays in your files and \`stroq harden undo\` will not take it out; the old file lists it, if you want to remove it by hand`,
  );
