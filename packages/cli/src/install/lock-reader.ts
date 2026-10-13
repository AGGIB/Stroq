import { readRegularFile } from '@stroq/core';
import { lstatSync } from 'node:fs';
import { PassportLockSchema, MAX_PASSPORT_LOCK_BYTES } from './passports-schema.js';

export { PassportLockSchema, McpPinSchema, MAX_PASSPORT_LOCK_BYTES } from './passports-schema.js';

/** Shared bounded reader for the local install lock. Never follows a symlink. */
export function readPassportLock(file: string) {
  if (lstatSync(file).isSymbolicLink()) throw new Error('cannot verify a linked confirmation lock');
  const read = readRegularFile(file, MAX_PASSPORT_LOCK_BYTES, { noFollow: true });
  if (read.kind === 'too-large')
    throw new Error('the local confirmation lock exceeds the size limit');
  if (read.kind !== 'text') throw new Error('cannot verify a bounded regular confirmation lock');
  return PassportLockSchema.parse(JSON.parse(read.text) as unknown);
}
