import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LARGE_SCAN_CAP, scanLargeFile } from '../../src/exposure/large-text.js';

/**
 * A file too large to read whole is read in pieces of a megabyte and scanned for characters nobody
 * reading it would see, all of it up to `LARGE_SCAN_CAP`. The pieces are cut in bytes, so one may
 * end inside a character, and a character that hides nothing by itself may hide something with the
 * one after it across a cut; the answer must be the one for the whole text.
 */
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stroq-large-text-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});
const write = (name: string, text: string | Buffer): string => {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
};
const MIB = 1024 * 1024;
const filler = (bytes: number): string =>
  'abcdefghij,\n'.repeat(Math.ceil(bytes / 12)).slice(0, bytes);

describe('scanLargeFile', () => {
  it('finds a file of 1.2 MB with nothing hidden clean', () => {
    const path = write('clean.json', filler(1_200_000));
    expect(scanLargeFile(path, 'a/clean.json')).toEqual({ kind: 'clean' });
  });

  it('finds a hidden character at a megabyte and a bit, with its line and the usual value', () => {
    const lines = filler(1_100_000).split('\n').length;
    const path = write('hidden.json', `${filler(1_100_000)}x​y${filler(100_000)}`);
    const found = scanLargeFile(path, 'a/hidden.json');
    expect(found?.kind).toBe('hidden');
    if (found?.kind !== 'hidden') return;
    expect(found.hit).toMatchObject({
      kind: 'instruction-hidden-text',
      file: 'a/hidden.json',
      name: 'hidden',
      line: lines,
    });
    expect(found.hit.value).toMatch(/^U\+200B x1 \(sha256:[0-9a-f]{16}\)$/);
  });

  it('sees a character that a cut falls in the middle of, wherever the cut is', () => {
    // A three-byte character (U+200B) over the end of the first piece, at each byte it can start on.
    for (let offset = MIB - 4; offset <= MIB + 1; offset += 1) {
      const bytes = Buffer.concat([
        Buffer.from(filler(offset)),
        Buffer.from('​'),
        Buffer.from(filler(MIB)),
      ]);
      const found = scanLargeFile(write(`cut-${offset}.json`, bytes), 'cut.json');
      expect(found?.kind, String(offset)).toBe('hidden');
    }
  });

  it('reads characters of several bytes that a cut splits as the characters they are', () => {
    // 字 is three bytes: a file of them, cut at every offset within one, has nothing hidden.
    for (let shift = 0; shift < 3; shift += 1) {
      const bytes = Buffer.concat([
        Buffer.from('a'.repeat(shift)),
        Buffer.from('字'.repeat(500_000)),
      ]);
      expect(scanLargeFile(write(`han-${shift}.json`, bytes), 'han.json'), String(shift)).toEqual({
        kind: 'clean',
      });
    }
    const emoji = Buffer.concat([Buffer.from('a'), Buffer.from('😀'.repeat(300_000))]);
    expect(scanLargeFile(write('emoji.json', emoji), 'emoji.json')).toEqual({ kind: 'clean' });
  });

  it('keeps a joiner between two pictographs that a cut separates from them clean, and a bare one not', () => {
    const family = '👨‍👩‍👧‍👦';
    for (let offset = MIB - 20; offset <= MIB + 4; offset += 1) {
      const text = Buffer.concat([
        Buffer.from(filler(offset)),
        Buffer.from(family),
        Buffer.from(filler(MIB)),
      ]);
      expect(scanLargeFile(write(`family-${offset}.json`, text), 'f.json'), String(offset)).toEqual(
        {
          kind: 'clean',
        },
      );
    }
    const bare = Buffer.concat([
      Buffer.from(filler(MIB - 2)),
      Buffer.from('a‍b'),
      Buffer.from(filler(MIB)),
    ]);
    expect(scanLargeFile(write('bare.json', bare), 'b.json')?.kind).toBe('hidden');
  });

  it('is not tricked by invalid bytes, which are replacement characters and hide nothing', () => {
    const bytes = Buffer.concat([
      Buffer.from(filler(MIB)),
      Buffer.from([0xff, 0xfe, 0xc3]),
      Buffer.from(filler(1000)),
    ]);
    expect(scanLargeFile(write('bytes.json', bytes), 'bytes.json')).toEqual({ kind: 'clean' });
  });

  it('does not scan a file past the cap, nor read it', () => {
    const path = write('huge.json', '{}');
    truncateSync(path, LARGE_SCAN_CAP + 1);
    expect(scanLargeFile(path, 'huge.json')).toBeUndefined();
    expect(scanLargeFile(write('big.json', filler(3 * MIB)), 'big.json', 2 * MIB)).toBeUndefined();
  });

  it('does not scan what is not a file, or is not there', () => {
    mkdirSync(join(dir, 'folder'));
    expect(scanLargeFile(join(dir, 'folder'), 'folder')).toBeUndefined();
    expect(scanLargeFile(join(dir, 'missing.json'), 'missing.json')).toBeUndefined();
  });

  it('stops at the first ten thousand hidden characters, so a file full of them is quick', () => {
    const path = write('full.json', `${filler(2000)}${'\u200b'.repeat(2_000_000)}`);
    const found = scanLargeFile(path, 'full.json');
    expect(found?.kind).toBe('hidden');
    if (found?.kind !== 'hidden') return;
    expect(found.hit.value).toMatch(/^U\+200B x10000 \(sha256:[0-9a-f]{16}\)$/);
    expect(scanLargeFile(path, 'full.json', LARGE_SCAN_CAP, 4096)).toEqual(found);
  });

  it('gives the same answer for the same bytes whatever the size of its pieces', () => {
    const text = `${filler(300_000)}​${filler(300_000)}⁠${filler(100_000)}`;
    const path = write('pieces.json', text);
    const want = scanLargeFile(path, 'p.json');
    expect(want?.kind).toBe('hidden');
    for (const piece of [4096, 65_536, 300_001])
      expect(scanLargeFile(path, 'p.json', LARGE_SCAN_CAP, piece), String(piece)).toEqual(want);
  });
});
