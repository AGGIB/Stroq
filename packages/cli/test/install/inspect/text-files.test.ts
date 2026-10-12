import { describe, expect, it } from 'vitest';
import { READ_CAP_BYTES } from '../../../src/install/inspect/blind-spots.js';
import { Findings } from '../../../src/install/inspect/findings.js';
import { LineIndex, loadTexts } from '../../../src/install/inspect/text-files.js';
import { buildTree } from '../../../src/install/tree.js';
import { fileEntry, gitlinkEntry, symlinkEntry } from '../../helpers/install-tree.js';
import { cpuNow } from '../../helpers/cpu-time.js';

const load = (entries: Parameters<typeof buildTree>[0]) => {
  const findings = new Findings();
  const files = loadTexts(buildTree(entries, { complete: true }), findings);
  return { files, blindSpots: findings.result().blindSpots };
};

describe('loadTexts', () => {
  it('decodes a text file and keeps its path, its size and whether it is executable', () => {
    const { files } = load([fileEntry('bin/run.sh', '#!/bin/sh\necho hé\n', true)]);

    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      path: 'bin/run.sh',
      text: '#!/bin/sh\necho hé\n',
      exec: true,
      truncated: false,
    });
    expect(files[0]?.size).toBe(Buffer.byteLength('#!/bin/sh\necho hé\n'));
  });

  it('takes the byte order mark off the front', () => {
    const { files } = load([fileEntry('a.md', '﻿# title')]);

    expect(files[0]?.text).toBe('# title');
  });

  it('reads an empty file as empty text', () => {
    const { files } = load([fileEntry('empty.txt', '')]);

    expect(files[0]?.text).toBe('');
  });

  it('skips a file with a NUL in it as binary, and counts it', () => {
    const { files, blindSpots } = load([
      fileEntry('logo.png', Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1])),
      fileEntry('ok.md', 'ok'),
    ]);

    expect(files.map((file) => file.path)).toEqual(['ok.md']);
    expect(blindSpots.some((spot) => spot.startsWith('1 file looked binary'))).toBe(true);
  });

  it('skips a file that is not valid UTF-8, and counts it', () => {
    const { files, blindSpots } = load([
      fileEntry('latin1.txt', Uint8Array.from([0x63, 0x61, 0x66, 0xe9])),
      fileEntry('overlong.txt', Uint8Array.from([0xc0, 0xaf])),
    ]);

    expect(files).toEqual([]);
    expect(blindSpots.some((spot) => spot.startsWith('2 files looked binary'))).toBe(true);
  });

  it('does not take a lone surrogate encoded in UTF-8 for text', () => {
    const { files } = load([fileEntry('s.txt', Uint8Array.from([0xed, 0xa0, 0x80]))]);

    expect(files).toEqual([]);
  });

  it('does not load a link or a nested repository', () => {
    const { files } = load([
      fileEntry('a.md', 'a'),
      symlinkEntry('l', 'a.md'),
      gitlinkEntry('vendor/sub'),
    ]);

    expect(files.map((file) => file.path)).toEqual(['a.md']);
  });

  it('reads only the first mebibyte of a longer file, and says it was not read in full', () => {
    const { files, blindSpots } = load([fileEntry('big.txt', 'a'.repeat(READ_CAP_BYTES + 10))]);

    expect(files[0]?.truncated).toBe(true);
    expect(files[0]?.text).toHaveLength(READ_CAP_BYTES);
    expect(files[0]?.size).toBe(READ_CAP_BYTES + 10);
    expect(blindSpots.some((spot) => spot.startsWith('1 file was not read in full'))).toBe(true);
  });

  it('does not take a cut through the middle of a character for bad text', () => {
    const text = `${'a'.repeat(READ_CAP_BYTES - 1)}étail`;
    const { files, blindSpots } = load([fileEntry('cut.txt', text)]);

    expect(files).toHaveLength(1);
    expect(files[0]?.truncated).toBe(true);
    expect(blindSpots.some((spot) => spot.includes('looked binary'))).toBe(false);
  });

  it('keeps a file of exactly the cap whole', () => {
    const { files } = load([fileEntry('exact.txt', 'a'.repeat(READ_CAP_BYTES))]);

    expect(files[0]?.truncated).toBe(false);
  });

  it('decodes a thousand small files without noticing', () => {
    const entries = Array.from({ length: 1000 }, (_, i) => fileEntry(`f${i}.txt`, `file ${i}\n`));
    const started = cpuNow();

    const { files } = load(entries);

    expect(files).toHaveLength(1000);
    expect(cpuNow() - started).toBeLessThan(2000);
  });
});

describe('LineIndex', () => {
  it('numbers lines from one', () => {
    const lines = new LineIndex('a\nbb\nccc');

    expect([0, 1, 2, 3, 4, 5, 7].map((at) => lines.lineAt(at))).toEqual([1, 1, 2, 2, 2, 3, 3]);
  });

  it('counts a carriage return and a newline as the end of one line', () => {
    const lines = new LineIndex('a\r\nb\r\nc');

    expect(lines.lineAt(3)).toBe(2);
    expect(lines.lineAt(6)).toBe(3);
  });

  it('answers the last line for a place past the end and the first for one before it', () => {
    const lines = new LineIndex('a\nb');

    expect(lines.lineAt(100)).toBe(2);
    expect(lines.lineAt(-5)).toBe(1);
  });

  it('answers 1 for an empty text', () => {
    expect(new LineIndex('').lineAt(0)).toBe(1);
  });

  it('is quick on a megabyte of text with a line in every other character', () => {
    const lines = new LineIndex('a\n'.repeat(512 * 1024));
    const started = cpuNow();

    const answers = Array.from({ length: 1000 }, (_, i) => lines.lineAt(i * 1000));

    expect(answers[999]).toBe(499501);
    expect(cpuNow() - started).toBeLessThan(500);
  });
});
