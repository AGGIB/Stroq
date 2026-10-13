import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { ArchiveError, type ArchiveErrorCode } from '../../src/install/archive-error.js';
import { foreignFormat, gunzipOnce, isGzip } from '../../src/install/archive-gzip.js';
import { concat } from '../helpers/tar-writer.js';

const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const gz = (data: Uint8Array): Uint8Array => new Uint8Array(gzipSync(data));
const MiB = 1024 * 1024;

/** The ArchiveError a call throws; any other outcome fails the test. */
function refusal(run: () => unknown): ArchiveError {
  try {
    run();
  } catch (error) {
    if (error instanceof ArchiveError) return error;
    throw error;
  }
  throw new Error('expected an ArchiveError, and nothing was thrown');
}

const codeOf = (run: () => unknown): ArchiveErrorCode => refusal(run).code;

/** The CRC-32 of gzip, bit by bit: the reader has a table, and this shares nothing with it. */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * A gzip member with fields in its header that `gzip` the program writes (the name of the file) and
 * that other writers do (extra data, a comment, a header checksum), built from the output of Node's own
 * gzip so that the deflate stream and the trailer are real. `headerCrc: true` is the right CRC-16 of the
 * header, and `'wrong'` is the next number after it.
 */
function member(
  data: Uint8Array,
  extras: {
    name?: string;
    extra?: Uint8Array;
    comment?: string;
    headerCrc?: boolean | 'wrong';
  } = {},
): Uint8Array {
  const whole = gz(data);
  const body = whole.subarray(10, whole.length - 8);
  const trailer = whole.subarray(whole.length - 8);
  let flags = 0;
  const optional: Uint8Array[] = [];
  if (extras.extra !== undefined) {
    flags |= 4;
    optional.push(
      new Uint8Array([extras.extra.length & 255, extras.extra.length >> 8]),
      extras.extra,
    );
  }
  if (extras.name !== undefined) {
    flags |= 8;
    optional.push(text(extras.name), new Uint8Array(1));
  }
  if (extras.comment !== undefined) {
    flags |= 16;
    optional.push(text(extras.comment), new Uint8Array(1));
  }
  if (extras.headerCrc !== undefined && extras.headerCrc !== false) {
    flags |= 2;
  }
  const header = new Uint8Array([0x1f, 0x8b, 8, flags, 0, 0, 0, 0, 0, 3]);
  const before = concat([header, ...optional]);
  if ((flags & 2) !== 0) {
    const crc = (crc32(before) + (extras.headerCrc === 'wrong' ? 1 : 0)) & 0xffff;
    return concat([before, new Uint8Array([crc & 255, crc >> 8]), body, trailer]);
  }
  return concat([before, body, trailer]);
}

describe('isGzip', () => {
  it('goes by the two magic bytes and not by a file name', () => {
    expect(isGzip(gz(text('x')))).toBe(true);
    expect(isGzip(new Uint8Array([0x1f, 0x8b]))).toBe(true);
    expect(isGzip(text('PK\u0003\u0004'))).toBe(false);
    expect(isGzip(new Uint8Array([0x1f]))).toBe(false);
    expect(isGzip(new Uint8Array(0))).toBe(false);
    expect(isGzip(new Uint8Array(512))).toBe(false);
  });
});

describe('foreignFormat', () => {
  it.each([
    ['a zip file', new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0])],
    ['an empty zip file', new Uint8Array([0x50, 0x4b, 0x05, 0x06, 0, 0])],
    ['an xz file', new Uint8Array([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])],
    ['a bzip2 file', text('BZh91AY&SY')],
    ['a zstd file', new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0, 0])],
  ])('names %s as one that is not read', (_label, bytes) => {
    const phrase = foreignFormat(bytes);

    expect(phrase).toMatch(/not read/);
    expect(phrase).toMatch(/\.tar|\.tgz|gzip/);
  });

  it('says nothing of a tar archive, a gzip file or anything it does not know', () => {
    expect(foreignFormat(new Uint8Array(512))).toBeNull();
    expect(foreignFormat(gz(text('x')))).toBeNull();
    expect(foreignFormat(text('hello'))).toBeNull();
    expect(foreignFormat(new Uint8Array(0))).toBeNull();
  });
});

describe('gunzipOnce', () => {
  it('gives back the bytes of one gzip member', () => {
    const data = text('hello archive '.repeat(100));

    expect(gunzipOnce(gz(data), 1 * MiB)).toEqual(data);
  });

  it('reads a member whose header carries a name, extra data, a comment and a header checksum', () => {
    const data = text('what gzip the program writes');
    const bytes = member(data, {
      name: 'skill.tar',
      extra: new Uint8Array([1, 2, 3, 4, 5]),
      comment: 'made by hand',
      headerCrc: true,
    });

    expect(gunzipOnce(bytes, 1 * MiB)).toEqual(data);
  });

  it('reads a member with a header checksum and nothing else in the header', () => {
    const data = text('only the checksum');

    expect(gunzipOnce(member(data, { headerCrc: true }), 1 * MiB)).toEqual(data);
  });

  it('reads a member of no data', () => {
    expect(gunzipOnce(gz(new Uint8Array(0)), 1 * MiB)).toEqual(new Uint8Array(0));
  });

  it('reads data of exactly the limit and refuses one byte more', () => {
    expect(gunzipOnce(gz(new Uint8Array(4096)), 4096).length).toBe(4096);
    expect(codeOf(() => gunzipOnce(gz(new Uint8Array(4097)), 4096))).toBe('limit');
  });

  describe('refuses', () => {
    it('a header checksum that is not the checksum of the header, which zlib (and so npm) refuses too', () => {
      for (const extras of [
        { headerCrc: 'wrong' as const },
        { headerCrc: 'wrong' as const, name: 'skill.tar', comment: 'by hand' },
      ]) {
        const error = refusal(() => gunzipOnce(member(text('some data'), extras), MiB));

        expect(error.code).toBe('bad-gzip');
        expect(error.message).toMatch(/header checksum/);
      }
    });

    it('a header checksum of zero, which is what a writer that does not work it out leaves there', () => {
      const bytes = member(text('some data'), { headerCrc: true });
      const zeroed = Uint8Array.from(bytes);
      zeroed.fill(0, 10, 12);

      expect(codeOf(() => gunzipOnce(zeroed, MiB))).toBe('bad-gzip');
    });

    it('data after the member, and says it is after the stream', () => {
      const error = refusal(() =>
        gunzipOnce(concat([gz(text('abc')), text('trailing garbage')]), MiB),
      );

      expect(error.code).toBe('bad-gzip');
      expect(error.message).toMatch(/after the gzip data/);
    });

    it('a second member, and says so, though gzip the program would read both as one', () => {
      const error = refusal(() => gunzipOnce(concat([gz(text('abc')), gz(text('def'))]), MiB));

      expect(error.code).toBe('bad-gzip');
      expect(error.message).toMatch(/more than one gzip member/);
    });

    it('an empty member put in front of a real one, which would pass a check of the last trailer alone', () => {
      const error = refusal(() =>
        gunzipOnce(concat([gz(new Uint8Array(0)), gz(text('abc'))]), MiB),
      );

      expect(error.message).toMatch(/more than one gzip member/);
    });

    it('a member that is cut short, in the data and in the trailer', () => {
      const whole = gz(text('a longer text so that there is a stream to cut '.repeat(20)));

      expect(codeOf(() => gunzipOnce(whole.subarray(0, whole.length - 20), MiB))).toBe('bad-gzip');
      expect(codeOf(() => gunzipOnce(whole.subarray(0, whole.length - 3), MiB))).toBe('bad-gzip');
      expect(codeOf(() => gunzipOnce(whole.subarray(0, 5), MiB))).toBe('bad-gzip');
    });

    it('a trailer with the wrong checksum or the wrong length', () => {
      const whole = gz(text('checked by its trailer'));
      const badCrc = whole.slice();
      badCrc[badCrc.length - 8] = (badCrc[badCrc.length - 8] ?? 0) ^ 0xff;
      const badLength = whole.slice();
      badLength[badLength.length - 1] = (badLength[badLength.length - 1] ?? 0) ^ 0x01;

      expect(refusal(() => gunzipOnce(badCrc, MiB)).message).toMatch(/checksum/);
      expect(refusal(() => gunzipOnce(badLength, MiB)).message).toMatch(/length/);
    });

    it('a stream of deflate data that is damaged', () => {
      const damaged = gz(text('abcdefghij'.repeat(50)));
      damaged[12] = 0xff;
      damaged[13] = 0xff;

      expect(codeOf(() => gunzipOnce(damaged, MiB))).toBe('bad-gzip');
    });

    it('a method other than deflate and flag bits that are reserved', () => {
      const method = gz(text('x'));
      method[2] = 7;
      const reserved = gz(text('x'));
      reserved[3] = 0x20;

      expect(codeOf(() => gunzipOnce(method, MiB))).toBe('bad-gzip');
      expect(codeOf(() => gunzipOnce(reserved, MiB))).toBe('bad-gzip');
    });

    it('a header whose name or extra field runs off the end of the data', () => {
      const header = new Uint8Array([0x1f, 0x8b, 8, 8, 0, 0, 0, 0, 0, 3]);
      const endless = concat([header, text('a name that never ends')]);
      const longExtra = new Uint8Array([0x1f, 0x8b, 8, 4, 0, 0, 0, 0, 0, 3, 0xff, 0xff, 1]);

      expect(codeOf(() => gunzipOnce(endless, MiB))).toBe('bad-gzip');
      expect(codeOf(() => gunzipOnce(longExtra, MiB))).toBe('bad-gzip');
    });
  });

  describe('a gzip bomb', () => {
    it('is a few tens of kilobytes that expand past the limit, and is refused as over it', () => {
      const bomb = gz(new Uint8Array(40 * MiB));

      expect(bomb.length).toBeLessThan(200 * 1024);
      const error = refusal(() => gunzipOnce(bomb, 32 * MiB));
      expect(error.code).toBe('limit');
      expect(error.message).toMatch(/expands to more than 33554432 bytes/);
    });

    it('is stopped near the limit, and does not get to hold what it expands to', () => {
      const bomb = gz(new Uint8Array(128 * MiB));
      const before = process.memoryUsage().arrayBuffers;

      expect(codeOf(() => gunzipOnce(bomb, 8 * MiB))).toBe('limit');

      // Far under the 128 MiB it would have been, with room for what the allocator keeps.
      expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(32 * MiB);
    });
  });
});
