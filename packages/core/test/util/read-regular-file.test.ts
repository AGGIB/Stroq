import { execFileSync } from 'node:child_process';
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readRegularFile } from '../../src/util/read-regular-file.js';

const dir = (): string => mkdtempSync(join(tmpdir(), 'stroq-read-regular-'));

describe('readRegularFile', () => {
  it('reads a regular file within the bound', () => {
    const file = join(dir(), 'package.json');
    writeFileSync(file, '{"name":"é"}');
    expect(readRegularFile(file, 1024)).toEqual({ kind: 'text', text: '{"name":"é"}', size: 13 });
  });

  it('reads a regular file through a symlink, as a manifest linked from elsewhere is', () => {
    const base = dir();
    writeFileSync(join(base, 'real.md'), '# real');
    symlinkSync(join(base, 'real.md'), join(base, 'CLAUDE.md'));
    expect(readRegularFile(join(base, 'CLAUDE.md'), 1024)).toEqual({
      kind: 'text',
      text: '# real',
      size: 6,
    });
  });

  it('reports a file over the bound with its size, and does not read it', () => {
    const file = join(dir(), 'huge.json');
    writeFileSync(file, 'x'.repeat(2048));
    expect(readRegularFile(file, 1024)).toEqual({ kind: 'too-large', size: 2048 });
  });

  it('refuses a directory', () => {
    expect(readRegularFile(dir(), 1024)).toEqual({ kind: 'not-regular' });
  });

  // `/dev/zero` never reaches end-of-file, so reading it is a loop that ends when memory
  // does. It is a POSIX device; Windows has no equivalent path to link to.
  it.skipIf(process.platform === 'win32')('refuses a device a symlink leads to', () => {
    const link = join(dir(), 'package.json');
    symlinkSync('/dev/zero', link);
    expect(readRegularFile(link, 1024)).toEqual({ kind: 'not-regular' });
  });

  // Opening a FIFO for reading waits for a writer. Nothing writes to this one, so a
  // plain open would never return and this test would never finish.
  it.skipIf(process.platform === 'win32')('refuses a FIFO without waiting for a writer', () => {
    const fifo = join(dir(), 'package.json');
    execFileSync('mkfifo', [fifo]);
    expect(readRegularFile(fifo, 1024)).toEqual({ kind: 'not-regular' });
  });

  it('throws for a path that does not exist, like the fs call it replaces', () => {
    expect(() => readRegularFile(join(dir(), 'missing.json'), 1024)).toThrow(/ENOENT/);
  });
});
