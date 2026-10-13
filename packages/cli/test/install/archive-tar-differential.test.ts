import { describe, expect, it } from 'vitest';
import { refusal } from '../helpers/archive-refusal.js';
import { bytesOfText, field, hiding, pathsOf } from '../helpers/tar-differential.js';
import { concat, dataBlocks, headerBlock, tarOf, type Format } from '../helpers/tar-writer.js';

/**
 * Headers that are valid to a lax reader and that npm's extractor (node-tar) reads another way: the
 * link name of a file, the version of ustar, bytes after the end of a name, the bytes at 345 of a
 * header that has no prefix, and a pax size that is not the size in the header. Each is refused, and
 * the same header with the field as a real writer leaves it is read. See `helpers/tar-differential.ts`
 * for the shape of the archives.
 */

const LINK_BYTES = [157, 200, 256] as const;

/** A copy of the bytes with one of them set. */
const withByte = (bytes: Uint8Array, at: number, value: number): Uint8Array => {
  const copy = Uint8Array.from(bytes);
  copy[at] = value;
  return copy;
};

// ---------------------------------------------------------------------------------------------
// The link name
// ---------------------------------------------------------------------------------------------

describe('the link name of a header that is not a link', () => {
  const expectLinkRefused = (bytes: Uint8Array): void => {
    const error = refusal(bytes);

    expect(error.code).toBe('corrupt');
    expect(error.message).toMatch(/link name/);
  };

  it.each(LINK_BYTES)('refuses a file whose link name has a byte at %i', (offset) => {
    expect(pathsOf(hiding())).toHaveLength(2);

    expectLinkRefused(hiding({ patches: { [offset]: 'x' } }));
  });

  it('refuses a file with a link name that is a name', () => {
    expectLinkRefused(hiding({ linkname: 'package/package.json' }));
  });

  it.each(LINK_BYTES)('refuses an old-style file, of type NUL, with a byte at %i', (offset) => {
    const oldStyle = (patches: Record<number, string>) =>
      tarOf([{ name: 'package/a.txt', data: 'x', typeflag: '\0', header: { patches } }]);

    expect(pathsOf(oldStyle({}))).toEqual(['a.txt']);
    expectLinkRefused(oldStyle({ [offset]: 'x' }));
  });

  it.each(LINK_BYTES)('refuses a folder with a byte at %i', (offset) => {
    const folder = (patches: Record<number, string>) =>
      tarOf([
        { name: 'package/', typeflag: '5', header: { patches } },
        { name: 'package/a.txt', data: 'x' },
      ]);

    expect(pathsOf(folder({}))).toEqual(['a.txt']);
    expectLinkRefused(folder({ [offset]: 'x' }));
  });

  it.each(LINK_BYTES)('refuses a GNU long name header with a byte at %i', (offset) => {
    const long = concat([bytesOfText('package/long-name.txt'), new Uint8Array(1)]);
    const withLongName = (patches: Record<number, string>) =>
      tarOf([
        concat([
          headerBlock({
            name: '././@LongLink',
            typeflag: 'L',
            size: long.length,
            format: 'gnu',
            patches,
          }),
          dataBlocks(long),
          headerBlock({ name: 'placeholder', size: 1, format: 'gnu' }),
          dataBlocks('x'),
        ]),
      ]);

    expect(pathsOf(withLongName({}))).toHaveLength(1);
    expectLinkRefused(withLongName({ [offset]: 'x' }));
  });
});

// ---------------------------------------------------------------------------------------------
// The version of ustar
// ---------------------------------------------------------------------------------------------

describe('the version of a ustar header', () => {
  const withVersion = (version: string | Uint8Array, prefix = 'package/lib') =>
    tarOf([{ name: 'b.js', data: 'x', header: { prefix, patches: { 263: version } } }]);

  it('reads version 00, and carries the prefix', () => {
    expect(pathsOf(withVersion('00'))).toEqual(['lib/b.js']);
  });

  it.each([
    ['two spaces', '  '],
    ['xx', 'xx'],
    ['two NULs', '\0\0'],
    ['01', '01'],
    ['a zero and a space', '0 '],
    ['a space and a NUL', ' \0'],
  ])('refuses a version of %s, which npm reads as a header with no prefix', (_what, version) => {
    for (const prefix of ['package/lib', '']) {
      const error = refusal(withVersion(version, prefix));

      expect(error.code, prefix).toBe('corrupt');
      expect(error.message, prefix).toMatch(/version/);
    }
  });

  it('does not ask a GNU header for the version of ustar, which is not a number there', () => {
    const bytes = tarOf([{ name: 'package/a.txt', data: 'x', header: { format: 'gnu' } }]);

    expect(pathsOf(bytes)).toEqual(['a.txt']);
  });
});

// ---------------------------------------------------------------------------------------------
// Bytes after the end of a name
// ---------------------------------------------------------------------------------------------

describe('a name or a prefix with bytes after its first NUL', () => {
  it.each([
    ['a byte after the NUL', bytesOfText('package/a\0b')],
    ['a newline after the NUL, which npm leaves in the name', bytesOfText('package/a\0\nb')],
    ['a byte in the last place of the field', withByte(field(100, 'package/a'), 99, 0x62)],
  ])('refuses a name with %s', (_what, name) => {
    const error = refusal(tarOf([{ name: 'placeholder', data: 'x', header: { name } }]));

    expect(error.code).toBe('corrupt');
    expect(error.message).toMatch(/name field/);
  });

  it('refuses the same in the hiding position', () => {
    expect(refusal(hiding({ name: bytesOfText('package/a\0b') })).code).toBe('corrupt');
  });

  it.each([
    ['a byte after the NUL', bytesOfText('package\0evil')],
    ['a newline after the NUL', bytesOfText('package\0\nevil')],
    ['a byte in the last place of the field', withByte(field(155, 'package'), 154, 0x62)],
  ])('refuses a prefix with %s', (_what, prefix) => {
    const error = refusal(tarOf([{ name: 'a.txt', data: 'x', header: { prefix } }]));

    expect(error.code).toBe('corrupt');
    expect(error.message).toMatch(/prefix field/);
  });

  it('refuses bytes after the NUL that ends a prefix of 130 bytes, where npm reads the times', () => {
    const prefix = new Uint8Array(155);
    prefix.fill(0x61, 0, 130);
    prefix[131] = 0x81; // the first byte of the access time that npm reads at 476

    const error = refusal(tarOf([{ name: 'a.txt', data: 'x', header: { prefix } }]));

    expect(error.code).toBe('corrupt');
  });

  it('reads a name and a prefix that are followed by NULs only, and a name that fills its field', () => {
    const full = `${'d'.repeat(49)}/${'f'.repeat(50)}`;
    const bytes = tarOf([
      { name: 'a.txt', data: 'x', header: { prefix: 'package/lib' } },
      { name: full, data: 'y' },
    ]);

    expect(pathsOf(bytes)).toEqual([full, 'package/lib/a.txt']);
  });
});

// ---------------------------------------------------------------------------------------------
// Bytes where a prefix would be, in a header that has none
// ---------------------------------------------------------------------------------------------

describe('the bytes at 345 of a header that is not ustar', () => {
  const formats: readonly Format[] = ['gnu', 'v7'];

  it.each(formats.flatMap((format) => [345, 400, 475, 499].map((at) => [format, at] as const)))(
    'refuses a %s header with a byte at %i, which this reader would not read and others do',
    (format, at) => {
      const bytes = (patches: Record<number, string>) =>
        tarOf([{ name: 'package/b.js', data: 'x', header: { format, patches } }]);

      expect(pathsOf(bytes({}))).toEqual(['b.js']);
      const error = refusal(bytes({ [at]: 'evil' }));

      expect(error.code).toBe('corrupt');
      expect(error.message).toMatch(/bytes at 345/);
    },
  );

  it('refuses a header whose magic is neither ustar nor GNU, whatever it is', () => {
    const odd = tarOf([
      { name: 'package/b.js', data: 'x', header: { patches: { 257: 'USTAR\0', 345: 'evil' } } },
    ]);

    expect(refusal(odd).code).toBe('corrupt');
  });

  it('does not look at the bytes after 499, which are padding', () => {
    const bytes = tarOf([
      { name: 'package/b.js', data: 'x', header: { format: 'gnu', patches: { 500: 'padding' } } },
    ]);

    expect(pathsOf(bytes)).toEqual(['b.js']);
  });
});

// ---------------------------------------------------------------------------------------------
// A pax size
// ---------------------------------------------------------------------------------------------

describe('a pax size that is not the size in the header', () => {
  it('reads a pax size that says what the header says', () => {
    const bytes = tarOf([
      { name: 'big.txt', data: 'hello', pax: { size: '5' } },
      { name: 'next.txt', data: 'after' },
    ]);

    expect(pathsOf(bytes)).toEqual(['big.txt', 'next.txt']);
  });

  it.each([
    ['larger than the header', '5', 0],
    ['smaller than the header', '3', 5],
    ['zero, with data in the header', '0', 5],
  ])('refuses a size that is %s', (_what, pax, headerSize) => {
    const bytes = tarOf([
      { name: 'big.txt', data: 'hello', pax: { size: pax }, header: { size: headerSize } },
      { name: 'next.txt', data: 'after' },
    ]);

    const error = refusal(bytes);

    expect(error.code).toBe('corrupt');
    expect(error.message).toMatch(/size/);
  });

  it('refuses it on a folder, too', () => {
    const error = refusal(tarOf([{ name: 'pkg/', typeflag: '5', pax: { size: '5' } }]));

    expect(error.code).toBe('corrupt');
    expect(error.message).toMatch(/size/);
  });

  it('says it is over the limit, not corrupt, for a size no file may have', () => {
    const huge = String(8 * 1024 * 1024 * 1024);
    const error = refusal(tarOf([{ name: 'a', pax: { size: huge }, header: { size: 0 } }]));

    expect(error.code).toBe('limit');
  });
});
