import { expect } from 'vitest';
import { ArchiveError } from '../../src/install/archive-error.js';
import { readTarArchive } from '../../src/install/archive-tar.js';
import { concat, dataBlocks, headerBlock, type TarEntry } from './tar-writer.js';
import { RAW_UNSAFE } from './vet-world.js';

/** The ArchiveError that reading the bytes throws; any other outcome fails the test. */
export function refusal(bytes: Uint8Array): ArchiveError {
  try {
    readTarArchive(bytes);
  } catch (error) {
    if (error instanceof ArchiveError) {
      // Whatever is refused, what is said can be printed: no raw control or invisible character.
      expect(error.message).not.toMatch(RAW_UNSAFE);
      return error;
    }
    throw error;
  }
  throw new Error('expected an ArchiveError, and nothing was thrown');
}

export const GOOD: TarEntry = { name: 'pkg/ok.txt', data: 'fine' };
export const text = (value: string): Uint8Array => new TextEncoder().encode(value);
/** An entry whose name is these bytes, as they are, in the header. */
export const rawNamed = (name: Uint8Array, data = ''): Uint8Array =>
  concat([headerBlock({ name, size: data.length }), ...(data === '' ? [] : [dataBlocks(data)])]);
