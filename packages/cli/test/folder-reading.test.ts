import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readFolder } from '../src/folder-reading.js';

// Fixtures are read and never run.
const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function folder(files: Readonly<Record<string, string>>): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'stroq-folder-reading-')));
  made.push(dir);
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  return dir;
}

const FETCHED = 'fetch(u).then((t) => eval(t));\n';

describe('the reading of a folder', () => {
  it('gives one id for each place, long enough that an author cannot make two the same', () => {
    const { ids, labels } = readFolder(folder({ 'a.js': FETCHED, 'b.js': FETCHED }));
    expect(labels).toEqual(['a.js:1', 'b.js:1']);
    expect(ids).toHaveLength(2);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('another payload in a place is another id', () => {
    const dir = folder({ 'a.js': FETCHED });
    const before = readFolder(dir).ids;
    writeFileSync(join(dir, 'a.js'), `// other\n${FETCHED}`);
    expect(readFolder(dir).ids).not.toEqual(before);
  });

  it('holds thousands of the same thing to one place, and says what it cut', () => {
    const lines = Array.from({ length: 4000 }, (_, i) => `[filter "f${i}"]\n\tclean = x\n`).join(
      '',
    );
    const reading = readFolder(
      folder({
        '.git/HEAD': 'ref: refs/heads/main\n',
        '.git/objects/x': '',
        '.git/refs/x': '',
        '.git/config': lines,
      }),
    );
    expect(reading.ids.length).toBeLessThanOrEqual(300);
    expect(reading.notRead.join(' ')).toContain('past the first 300');
  });
});
