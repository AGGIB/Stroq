import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The code that refuses invisible and direction-changing characters must not be able to hold one
 * unseen, as `safe-path.ts` says of itself: a character that shows nothing in a source file can reverse
 * what a reviewer reads. So the sources of the readers, and the tests that write such characters, spell
 * every one of them as an escape. Printable ASCII, the tab and the line ends are all a file holds.
 */
const here = fileURLToPath(new URL('.', import.meta.url));
const SOURCES = [fileURLToPath(new URL('../../../src/install/inspect/', import.meta.url)), here];
/** The helpers written for these readers; the other helpers of the suite are not looked at. */
const HELPERS = ['inspect.ts', 'inspect-fixtures.ts', 'install-dir.ts'].map((name) =>
  fileURLToPath(new URL(`../../helpers/${name}`, import.meta.url)),
);

function typescriptFiles(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => join(folder, entry.name));
}

const files = [
  ...SOURCES.flatMap(typescriptFiles),
  ...HELPERS,
  fileURLToPath(new URL('../../../src/install/read-dir.ts', import.meta.url)),
  ...typescriptFiles(fileURLToPath(new URL('..', import.meta.url))).filter((file) =>
    /read-dir[\w-]*\.test\.ts$|read-dir-child\.ts$/.test(file),
  ),
];

describe('the files of the readers are plain ASCII', () => {
  it('finds the files it is meant to look at', () => {
    expect(files.length).toBeGreaterThan(40);
  });

  it.each(files.map((file) => [basename(file), file]))('%s', (_name, file) => {
    const text = readFileSync(file as string, 'utf8');
    const offenders = [...text].filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return !(code === 0x09 || code === 0x0a || (code >= 0x20 && code <= 0x7e));
    });

    expect(offenders.map((char) => `U+${(char.codePointAt(0) ?? 0).toString(16)}`)).toEqual([]);
  });
});
