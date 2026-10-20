import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { firstLine, headLines, headRecords } from '../../src/sent/head.js';

/** The first lines of a session file, read a piece at a time. Every file here is made up. */

const dir = mkdtempSync(join(tmpdir(), 'stroq-sent-head-'));
const file = (name: string, text: string): string => {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
};

describe('headLines', () => {
  it('hands over a line far longer than one read, whole', async () => {
    const long = 'x'.repeat(300_000);
    const lines: string[] = [];
    await headLines(file('long', `${long}\nsecond\n`), (line) => {
      lines.push(line);
      return false;
    });
    expect(lines.map((l) => l.length)).toEqual([300_000, 6]);
  });

  it('keeps a character whose bytes are split between two reads', async () => {
    // 65,535 one-byte characters put the two bytes of "é" on both sides of the first read.
    const text = `${'a'.repeat(65_535)}é\n`;
    const lines: string[] = [];
    await headLines(file('split', text), (line) => {
      lines.push(line);
      return false;
    });
    expect(lines[0]?.endsWith('é')).toBe(true);
  });

  it('stops when told, and at the limit', async () => {
    const path = file('many', 'a\nb\nc\n');
    const seen: string[] = [];
    await headLines(path, (line) => {
      seen.push(line);
      return line === 'b';
    });
    expect(seen).toEqual(['a', 'b']);
    const cut: string[] = [];
    await headLines(file('cut', `${'z'.repeat(100)}\nnext\n`), (line) => cut.push(line) > 0, 50);
    expect(cut).toEqual([]);
  });

  it('hands over a last line with no line break, and says when a file cannot be read', async () => {
    expect(await firstLine(file('open', 'only'))).toBe('only');
    expect(await firstLine(join(dir, 'missing'))).toBeNull();
  });
});

describe('headRecords', () => {
  it('passes over a line that is not a JSON object', async () => {
    const records: unknown[] = [];
    await headRecords(file('mixed', 'not json\n[1]\n{"cwd":"/w"}\n'), (r) => {
      records.push(r);
      return true;
    });
    expect(records).toEqual([{ cwd: '/w' }]);
  });
});
