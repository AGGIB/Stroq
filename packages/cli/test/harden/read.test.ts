import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_TARGET_BYTES,
  decodeUtf8Strict,
  readTargetBytes,
  readTargetStrict,
  readTargetText,
  sameBytes,
} from '../../src/harden/read.js';
import { HardenError } from '../../src/harden/types.js';
import { removeTempDirs, tempDir } from './helpers.js';

afterEach(removeTempDirs);

const thrownBy = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
};

/** Bytes that are not UTF-8: C3 wants a continuation byte after it, and 28 is `(`. */
const NOT_UTF8 = Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]);

describe('readTargetBytes', () => {
  it('gives the bytes of a file exactly, whatever they are', () => {
    const dir = tempDir();
    const bytes = Buffer.from([0xef, 0xbb, 0xbf, 0xff, 0xfe, 0x00, 0x0d, 0x0a, 0xc3, 0x28]);
    writeFileSync(join(dir, 'blob'), bytes);

    expect([...(readTargetBytes(join(dir, 'blob')) ?? [])]).toEqual([...bytes]);
  });

  it('is empty, not null, for a file with nothing in it, and null for a file that is not there', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'empty'), '');

    expect(readTargetBytes(join(dir, 'empty'))).toHaveLength(0);
    expect(readTargetBytes(join(dir, 'nope'))).toBeNull();
    expect(readTargetBytes(join(dir, 'empty', 'deeper'))).toBeNull();
  });

  it.skipIf(process.platform === 'win32')('refuses a directory with a typed error', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'd'));

    expect(thrownBy(() => readTargetBytes(join(dir, 'd')))).toMatchObject({
      code: 'not-regular-file',
    });
  });

  it('refuses a file larger than any agent config is', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'huge'), Buffer.alloc(MAX_TARGET_BYTES + 1, 0x20));

    expect(thrownBy(() => readTargetBytes(join(dir, 'huge')))).toMatchObject({
      code: 'target-too-large',
    });
  });
});

describe('readTargetText', () => {
  it('still reads loosely, as the planners always have: bytes that are not UTF-8 become U+FFFD', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'bad'), NOT_UTF8);

    expect(readTargetText(join(dir, 'bad'))).toContain('\u{FFFD}');
  });
});

describe('decodeUtf8Strict and readTargetStrict', () => {
  it('gives the text of valid UTF-8, a byte order mark and a literal U+FFFD included', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'ok.json'), '\u{FEFF}{"é":"\u{1f600}\u{FFFD}"}\r\n');

    expect(readTargetStrict(join(dir, 'ok.json'))).toBe('\u{FEFF}{"é":"\u{1f600}\u{FFFD}"}\r\n');
  });

  it('is null for a file that is not there', () => {
    expect(readTargetStrict(join(tempDir(), 'nope'))).toBeNull();
  });

  it.each([
    ['a lead byte with no continuation (C3 28)', NOT_UTF8],
    ['a lone continuation byte', Buffer.from([0x61, 0x80, 0x62])],
    ['a sequence cut off at the end of the file', Buffer.from([0x61, 0xe2, 0x82])],
    ['an overlong encoding of a slash', Buffer.from([0xc0, 0xaf])],
    ['an encoded surrogate', Buffer.from([0xed, 0xa0, 0x80])],
    ['a byte that is never UTF-8', Buffer.from([0xff, 0xfe])],
  ])('refuses %s with a typed error and no part of the file in it', (_name, bytes) => {
    const dir = tempDir();
    writeFileSync(join(dir, 'bad'), bytes);

    const error = thrownBy(() => readTargetStrict(join(dir, 'bad')));

    expect(error).toBeInstanceOf(HardenError);
    expect(error).toMatchObject({ code: 'not-utf8' });
    expect((error as Error).message).toContain(join(dir, 'bad'));
  });

  it('decodes bytes it is given, the same way', () => {
    expect(decodeUtf8Strict(Buffer.from('é'), '/x')).toBe('é');
    expect(thrownBy(() => decodeUtf8Strict(NOT_UTF8, '/x'))).toMatchObject({ code: 'not-utf8' });
  });
});

describe('sameBytes', () => {
  it('compares contents, and treats a missing file as different from an empty one', () => {
    expect(sameBytes(Buffer.from('ab'), Buffer.from('ab'))).toBe(true);
    expect(sameBytes(Buffer.from('ab'), Buffer.from('ac'))).toBe(false);
    expect(sameBytes(Buffer.from('ab'), Buffer.from('abc'))).toBe(false);
    expect(sameBytes(null, null)).toBe(true);
    expect(sameBytes(null, Buffer.alloc(0))).toBe(false);
    expect(sameBytes(Buffer.alloc(0), null)).toBe(false);
    expect(sameBytes(Buffer.alloc(0), Buffer.alloc(0))).toBe(true);
  });
});
