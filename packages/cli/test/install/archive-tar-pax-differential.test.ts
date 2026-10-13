import { describe, expect, it } from 'vitest';
import { refusal } from '../helpers/archive-refusal.js';
import { bytesOfText, pathsOf } from '../helpers/tar-differential.js';
import { concat, paxBlocks, paxRecord, tarOf } from '../helpers/tar-writer.js';

/**
 * Pax records that npm's extractor reads another way. node-tar does not cut a pax header into records
 * by their lengths, as the standard says and this reader does: it splits the text at every newline,
 * keeps a line only if its number is the length of the line, and cuts the key off by the number
 * written again without its leading zeros. So a record with a newline inside it is several lines to
 * npm, one of which can be a `path` this reader never saw, and a record whose length has a leading
 * zero is one npm does not understand at all. Both are refused.
 */

/** A record whose length is written with this many zeros in front, and counts them. */
function recordWithZeros(key: string, value: string, zeros: number): Uint8Array {
  const body = ` ${key}=${value}\n`;
  const width = (length: number): number => String(length).length + zeros;
  let length = body.length + 1;
  while (width(length) + body.length !== length) length = width(length) + body.length;
  return bytesOfText(`${String(length).padStart(width(length), '0')}${body}`);
}

const entryAfter = (records: Uint8Array) =>
  tarOf([concat(paxBlocks(records)), { name: 'package/orig.txt', data: 'x' }]);

describe('a pax record that npm splits at the newlines', () => {
  it('reads a path record as the path of the next entry, to start with', () => {
    expect(pathsOf(entryAfter(paxRecord('path', 'package/renamed.txt')))).toEqual(['renamed.txt']);
  });

  it.each([
    [
      'a path of a second record in the value of a comment',
      paxRecord('comment', 'x\n29 path=package/injected.txt\n'),
    ],
    ['a newline in the middle of a path', paxRecord('path', 'package/a\nb.txt')],
    ['a newline in a key', paxRecord('com\nment', 'x')],
    ['a newline at the start of a value', paxRecord('comment', '\nx')],
  ])('refuses %s', (_what, records) => {
    const error = refusal(entryAfter(records));

    expect(error.code).toBe('corrupt');
    expect(error.message).toMatch(/extended header/);
  });

  it('refuses a global header with a size in the value of a comment, which npm applies to every entry', () => {
    const records = paxRecord('comment', 'x\n13 size=5\n');
    const error = refusal(
      tarOf([concat(paxBlocks(records, 'g')), { name: 'package/a.txt', data: 'x' }]),
    );

    expect(error.code).toBe('corrupt');
    expect(error.message).toMatch(/extended header/);
  });
});

describe('a pax record whose length has a zero in front', () => {
  it.each([1, 2])(
    'refuses a path record with %i zeros, which npm reads as a record of another key',
    (zeros) => {
      const error = refusal(entryAfter(recordWithZeros('path', 'package/renamed.txt', zeros)));

      expect(error.code).toBe('corrupt');
      expect(error.message).toMatch(/extended header/);
    },
  );

  it('refuses it for a key that is not read, too, because the record is the same one to npm', () => {
    expect(refusal(entryAfter(recordWithZeros('comment', 'c', 1))).code).toBe('corrupt');
  });
});
