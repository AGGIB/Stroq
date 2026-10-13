import { readFileSync } from 'node:fs';
import { join, parse, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { labelOf } from '../../src/commands/vet-flow.js';
import { SourceRefSchema } from '../../src/install/types.js';
import { RAW_UNSAFE } from '../helpers/vet-world.js';

/**
 * The label a passport gives the folder it was read from: the name of the folder and nothing of where it
 * is, so that a passport reads the same on every machine and carries no user name. The schema decides what
 * a label may be; this is the part that makes a real folder name fit it.
 */
const fits = (label: string): boolean => SourceRefSchema.safeParse({ type: 'dir', label }).success;

describe('the label of a folder', () => {
  it('is the name of the folder, whatever the path to it', () => {
    expect(labelOf(join('some', 'where', 'pdf-forms'))).toBe('pdf-forms');
    expect(labelOf(`${join('some', 'where', 'pdf-forms')}${sep}`)).toBe('pdf-forms');
  });

  it('is the name of the current folder for a dot, and not a dot', () => {
    expect(labelOf('.')).toBe(labelOf(process.cwd()));
    expect(labelOf('.')).not.toBe('.');
  });

  it('is "folder" for the root of a disk, which has no name', () => {
    expect(labelOf(parse(process.cwd()).root)).toBe('folder');
  });

  it('never starts as an absolute path does, because a passport is read on other machines', () => {
    const label = labelOf('~notes');

    expect(label).toBe('_~notes');
    expect(fits(label)).toBe(true);
  });

  it('is cut to what a label may be, with a mark that it was cut', () => {
    const label = labelOf(join('x', 'n'.repeat(500)));

    expect([...label].length).toBeLessThanOrEqual(80);
    expect(label.endsWith('\u2026')).toBe(true);
    expect(fits(label)).toBe(true);
  });

  it('has no separator in it, whichever one the name has', () => {
    for (const name of [
      'a..b',
      '...',
      'a b',
      '\u00fcn\u00ef-c\u00f6d\u00e9',
      '\u65e5\u672c\u8a9e',
    ]) {
      const label = labelOf(join('x', name));
      expect(label, name).toBe(name);
      expect(fits(label), name).toBe(true);
    }
  });

  it.skipIf(process.platform === 'win32')(
    'writes a character that acts on a terminal, or hides, as a visible escape, and a backslash as an underscore',
    () => {
      const label = labelOf(join('x', 'a\u001b[2J\u202e\\..\\b'));

      expect(RAW_UNSAFE.test(label)).toBe(false);
      expect(label).toContain('_u001b');
      expect(label).not.toContain('\\');
      expect(fits(label)).toBe(true);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'keeps a name that looks like a drive from looking like one',
    () => {
      expect(labelOf(join('x', 'c:evil'))).toBe('_c:evil');
    },
  );
});

describe('the label of an archive', () => {
  const fitsArchive = (label: string): boolean =>
    SourceRefSchema.safeParse({ type: 'tarball', label }).success;

  it('is the base name of the file, with its extension, and nothing of where it is', () => {
    const label = labelOf(join('some', 'where', 'pdf-forms-1.2.0.tgz'), 'tarball');

    expect(label).toBe('pdf-forms-1.2.0.tgz');
    expect(fitsArchive(label)).toBe(true);
  });

  it('is "archive" for a path with no name, and fits the schema as a tarball', () => {
    expect(labelOf(parse(process.cwd()).root, 'tarball')).toBe('archive');
  });

  it('is cut, kept from looking like a drive and written without escapes, as the label of a folder is', () => {
    const long = labelOf(join('x', `${'n'.repeat(500)}.tgz`), 'tarball');

    expect([...long].length).toBeLessThanOrEqual(80);
    expect(fitsArchive(long)).toBe(true);
    expect(labelOf('~notes.tgz', 'tarball')).toBe('_~notes.tgz');
  });

  it('is the label of a folder when it is not told what it names', () => {
    expect(labelOf(join('some', 'where', 'pdf-forms'))).toBe('pdf-forms');
  });
});

describe('what the command loads when it is only asked to start', () => {
  const source = (name: string): string =>
    readFileSync(fileURLToPath(new URL(`../../src/commands/${name}`, import.meta.url)), 'utf8');

  it('reads nothing of the inspectors in the file that every process loads, only types', () => {
    // `vet.ts` is imported by the entry of the CLI, which the hook of an agent starts on every tool call.
    const imports = [...source('vet.ts').matchAll(/^import (type )?.*from '(.*)';$/gm)].map(
      (match) => ({ type: match[1] !== undefined, from: match[2] }),
    );
    const values = imports.filter((entry) => !entry.type).map((entry) => entry.from);

    expect(values.sort()).toEqual(['../help.js', 'node:util']);
  });
});
