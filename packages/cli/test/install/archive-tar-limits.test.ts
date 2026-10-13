import { describe, expect, it } from 'vitest';
import { ArchiveError } from '../../src/install/archive-error.js';
import { readTarArchive, type ArchiveOptions } from '../../src/install/archive-tar.js';
import { LIMITS } from '../../src/install/types.js';
import { cpuNow } from '../helpers/cpu-time.js';
import {
  concat,
  dataBlocks,
  gzip,
  headerBlock,
  paxBlocks,
  tarOf,
  type TarEntry,
} from '../helpers/tar-writer.js';

const MiB = 1024 * 1024;

function refusal(bytes: Uint8Array, options?: ArchiveOptions): ArchiveError {
  try {
    readTarArchive(bytes, options);
  } catch (error) {
    if (error instanceof ArchiveError) return error;
    throw error;
  }
  throw new Error('expected an ArchiveError, and nothing was thrown');
}

const empties = (count: number, folder = 'pkg'): TarEntry[] =>
  Array.from({ length: count }, (_, i) => ({ name: `${folder}/f${i}.txt` }));

describe('the size of one file', () => {
  it('refuses a header that claims more than a file may be, in an archive that is a few kilobytes', () => {
    const bytes = concat([
      headerBlock({ name: 'pkg/big.bin', size: LIMITS.maxFileBytes + 1 }),
      new Uint8Array(2048),
    ]);

    const error = refusal(bytes);

    expect(error.code).toBe('limit');
    expect(error.message).toBe(`a file in the archive is over the ${LIMITS.maxFileBytes} bytes a file may be`);
  });

  it('refuses a header that claims 8 GiB in an archive of 1 MiB, and allocates nothing for it', () => {
    const size = new Uint8Array(12);
    size[0] = 0x80;
    new DataView(size.buffer).setBigUint64(4, 8n * 1024n * 1024n * 1024n);
    const bytes = concat([headerBlock({ name: 'pkg/huge.bin', size }), new Uint8Array(MiB)]);
    const before = process.memoryUsage().arrayBuffers;

    const error = refusal(bytes);

    expect(error.code).toBe('limit');
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(2 * MiB);
  });

  it('refuses the largest size the octal field holds, and a pax size of 8 GiB, the same way', () => {
    const octalMax = concat([headerBlock({ name: 'a', size: '77777777777\0' }), new Uint8Array(1024)]);
    const viaPax = tarOf([
      { name: 'a', pax: { size: String(8 * 1024 * 1024 * 1024) }, header: { size: 0 } },
    ]);

    expect(refusal(octalMax).code).toBe('limit');
    expect(refusal(viaPax).code).toBe('limit');
  });

  it('refuses a size in the GNU form that is more than any number can hold exactly', () => {
    const size = new Uint8Array(12).fill(0xff);
    size[0] = 0x80;

    expect(refusal(concat([headerBlock({ name: 'a', size }), new Uint8Array(1024)])).code).toBe(
      'limit',
    );
  });

  it('reads a file of exactly the largest size, and refuses one byte more', () => {
    const exactly = tarOf([{ name: 'pkg/max.bin', data: new Uint8Array(LIMITS.maxFileBytes) }]);
    // The archive is a little over the size of the file: it has to be read, so the limit that stops it is the file's.
    const read = readTarArchive(exactly);

    expect(read.tree.entries[0]?.size).toBe(LIMITS.maxFileBytes);
    expect(refusal(tarOf([{ name: 'pkg/max.bin', data: new Uint8Array(LIMITS.maxFileBytes + 1) }])).code).toBe('limit');
  });

  it('can be asked for less than the contract allows, and never for more', () => {
    const files = tarOf([{ name: 'a', data: 'x'.repeat(1000) }]);
    const big = tarOf([{ name: 'a', data: new Uint8Array(LIMITS.maxFileBytes + 1) }]);

    expect(readTarArchive(files, { limits: { maxFileBytes: 1000 } }).tree.entries).toHaveLength(1);
    expect(refusal(files, { limits: { maxFileBytes: 999 } }).code).toBe('limit');
    expect(refusal(big, { limits: { maxFileBytes: 1e12, maxExpanded: 1e12 } }).code).toBe('limit');
  });
});

describe('the size of everything', () => {
  it('refuses a plain archive over the size of an expanded one', () => {
    const files = tarOf([{ name: 'a', data: new Uint8Array(3000) }]);

    const error = refusal(files, { limits: { maxExpanded: 5000 } });

    expect(error.code).toBe('limit');
    expect(error.message).toMatch(/over 5000 bytes/);
  });

  it('stops a gzip that expands past the limit, whatever the files in it say', () => {
    const bytes = gzip(tarOf([{ name: 'a', data: new Uint8Array(100_000) }]));

    const error = refusal(bytes, { limits: { maxExpanded: 50_000 } });

    expect(error.code).toBe('limit');
    expect(error.message).toMatch(/expands to more than 50000 bytes/);
  });

  it('refuses a download that is bigger than a download may be', () => {
    const bytes = gzip(tarOf(empties(50)));

    const error = refusal(bytes, { limits: { maxCompressed: bytes.length - 1 } });

    expect(error.code).toBe('limit');
    expect(error.message).toMatch(/compressed/);
    expect(readTarArchive(bytes, { limits: { maxCompressed: bytes.length } }).tree.entries).toHaveLength(50);
  });

  it('reads files that add up to a good part of what is allowed, once, in the time that takes', () => {
    const files: TarEntry[] = Array.from({ length: 3 }, (_, i) => ({
      name: `pkg/blob${i}.bin`,
      data: new Uint8Array(8 * MiB - 1000).fill(i + 1),
    }));
    const bytes = gzip(tarOf(files));
    const started = cpuNow();

    const read = readTarArchive(bytes);

    expect(read.tree.entries).toHaveLength(3);
    expect(cpuNow() - started).toBeLessThan(5000);
  });
});

describe('the number of entries', () => {
  it('reads as many files as a tree may have, in a time that is no worry', () => {
    const bytes = tarOf(empties(LIMITS.maxEntries));
    const started = cpuNow();

    const read = readTarArchive(bytes);

    expect(read.tree.entries).toHaveLength(LIMITS.maxEntries);
    expect(cpuNow() - started).toBeLessThan(4000);
  });

  it('refuses one file more', () => {
    const error = refusal(tarOf(empties(LIMITS.maxEntries + 1)));

    expect(error.code).toBe('limit');
    expect(error.message).toBe(`the archive has more than ${LIMITS.maxEntries} files`);
  });

  it('can be asked for fewer', () => {
    expect(readTarArchive(tarOf(empties(3)), { limits: { maxEntries: 3 } }).tree.entries).toHaveLength(3);
    expect(refusal(tarOf(empties(3)), { limits: { maxEntries: 2 } }).code).toBe('limit');
  });

  it('counts folders and headers too, so that a million empty folders are not a tree either', () => {
    const folders: TarEntry[] = Array.from({ length: 4 * LIMITS.maxEntries + 1 }, (_, i) => ({
      name: `pkg/d${i}/`,
      typeflag: '5',
    }));
    const started = cpuNow();

    const error = refusal(tarOf([...folders, { name: 'pkg/a.txt', data: 'x' }]));

    expect(error.code).toBe('limit');
    expect(error.message).toMatch(/more than \d+ entries/);
    expect(cpuNow() - started).toBeLessThan(4000);
  });
});

describe('the extended headers', () => {
  it('refuses a pax header of more than 64 KiB, without reading it', () => {
    const error = refusal(tarOf([concat(paxBlocks(new Uint8Array(70_000))), { name: 'a', data: 'x' }]));

    expect(error.code).toBe('limit');
    expect(error.message).toMatch(/extended header/);
  });

  it('refuses a GNU long name block of any size over the longest name, whatever its content', () => {
    const blocks = concat([
      headerBlock({ name: '././@LongLink', typeflag: 'L', size: 100 * 1024, format: 'gnu' }),
      dataBlocks(new Uint8Array(100 * 1024)),
      headerBlock({ name: 'a', format: 'gnu' }),
    ]);

    expect(refusal(tarOf([blocks])).code).toBe('limit');
  });
});
