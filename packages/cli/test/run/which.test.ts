import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { binOnPath } from '../../src/run/which.js';

const CANNOT_CHMOD = process.platform === 'win32';

function dirWith(...names: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'stroq-which-'));
  for (const name of names) {
    writeFileSync(join(dir, name), '#!/bin/sh\n');
    if (!CANNOT_CHMOD) chmodSync(join(dir, name), 0o755);
  }
  return dir;
}

describe('binOnPath', () => {
  it('returns the first entry on PATH that holds the program', () => {
    const empty = dirWith();
    const dir = dirWith('srt');
    expect(binOnPath('srt', { PATH: [empty, dir].join(delimiter) }, 'linux')).toBe(
      join(dir, 'srt'),
    );
  });

  it('answers null when nothing on PATH holds it, and when there is no PATH at all', () => {
    expect(binOnPath('srt', { PATH: dirWith() }, 'linux')).toBeNull();
    expect(binOnPath('srt', {}, 'linux')).toBeNull();
    expect(binOnPath('srt', { PATH: `${delimiter}${delimiter}` }, 'linux')).toBeNull();
  });

  it('skips a file that is there but not executable', () => {
    if (CANNOT_CHMOD) return;
    const dir = mkdtempSync(join(tmpdir(), 'stroq-which-noexec-'));
    writeFileSync(join(dir, 'srt'), 'not executable\n');
    chmodSync(join(dir, 'srt'), 0o644);
    expect(binOnPath('srt', { PATH: dir }, 'linux')).toBeNull();
  });

  // On Windows the program is `srt.cmd`; asking for `srt` has to find it, or every
  // npm-installed CLI reads as absent there.
  it('tries the PATHEXT suffixes on Windows', () => {
    const dir = dirWith('srt.cmd');
    expect(binOnPath('srt', { PATH: dir, PATHEXT: '.COM;.EXE;.CMD' }, 'win32')).toBe(
      join(dir, 'srt.cmd'),
    );
  });

  it('has a PATHEXT default on Windows, because a stripped environment has none', () => {
    const dir = dirWith('srt.cmd');
    expect(binOnPath('srt', { PATH: dir }, 'win32')).toBe(join(dir, 'srt.cmd'));
  });
});
