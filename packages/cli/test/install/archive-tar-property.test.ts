import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ArchiveError } from '../../src/install/archive-error.js';
import { readTarArchive, type ArchiveRead } from '../../src/install/archive-tar.js';
import { checkEntryPath } from '../../src/install/safe-path.js';
import { treeDigest } from '../../src/install/tree.js';
import { cpuNow } from '../helpers/cpu-time.js';
import { treeOf, type EntrySpec } from '../helpers/install-tree.js';
import {
  concat,
  dataBlocks,
  gzip,
  headerBlock,
  paxBlocks,
  tarOf,
  type Format,
  type NameVia,
  type TarEntry,
} from '../helpers/tar-writer.js';

/**
 * Two properties of an archive reader that is given hostile bytes. What a tool writes, it reads back as
 * the same tree (the writer here shares no code with the reader). And what is not a tool's output,
 * whatever has been done to it, ends in a tree or in the one typed error, in a time that a person does
 * not wait for: never a RangeError from an allocation, a TypeError from a header that was not
 * checked, or a loop.
 */
const RUNS = 300;
/** Processor time one reading may take, in reference milliseconds: the archives here are a few kilobytes. */
const READING_BUDGET_MS = 1000;

type Outcome = { readonly read: ArchiveRead } | { readonly refused: ArchiveError };

function readOrRefuse(bytes: Uint8Array): Outcome {
  const started = cpuNow();
  try {
    return { read: readTarArchive(bytes) };
  } catch (error) {
    if (error instanceof ArchiveError) return { refused: error };
    throw error;
  } finally {
    expect(cpuNow() - started).toBeLessThan(READING_BUDGET_MS);
  }
}

// ---------------------------------------------------------------------------------------------
// What is written is read back
// ---------------------------------------------------------------------------------------------

/** Letters outside ASCII are made from code points, so that no tool turns an escape in this file into the character. */
const OUTSIDE_ASCII = [0xe9, 0x65e5, 0x1f600].map((code) => String.fromCodePoint(code));
const LETTERS = [...'abcdefghijklmnopqrstuvwxyz0123456789_', ...OUTSIDE_ASCII];
const tail = fc.string({ unit: fc.constantFrom(...LETTERS), minLength: 0, maxLength: 10 });
/** Folders start with d and files with f, so that no path is a file and also the folder of another. */
const folderName = tail.map((rest) => `d${rest}`);
const fileName = tail.map((rest) => `f${rest}.txt`);

const utf8Length = (text: string): number => new TextEncoder().encode(text).length;

/** Whether the name can be split into a ustar prefix of 155 bytes and a name of 100. */
function splits(name: string): boolean {
  for (let slash = name.lastIndexOf('/'); slash > 0; slash = name.lastIndexOf('/', slash - 1)) {
    if (utf8Length(name.slice(0, slash)) <= 155 && utf8Length(name.slice(slash + 1)) <= 100) {
      return true;
    }
  }
  return false;
}

function carrying(name: string, wanted: NameVia): NameVia {
  if (wanted === 'header') return utf8Length(name) <= 100 ? 'header' : 'pax';
  if (wanted === 'prefix') return splits(name) ? 'prefix' : 'pax';
  return wanted;
}

interface Planned {
  readonly path: string;
  readonly data: Uint8Array;
  readonly mode: number;
  readonly wanted: NameVia;
  readonly format: Format;
}

const planned = fc.record({
  path: fc
    .tuple(fc.array(folderName, { maxLength: 3 }), fileName)
    .map(([folders, file]) => [...folders, file].join('/')),
  data: fc.uint8Array({ maxLength: 700 }),
  mode: fc.constantFrom(0o644, 0o755, 0o600, 0o700, 0o444, 0o555, 0o100, 0o010),
  wanted: fc.constantFrom<NameVia>('header', 'prefix', 'pax', 'gnu'),
  format: fc.constantFrom<Format>('ustar', 'gnu', 'v7'),
});

/** The entry that writes a planned file under `name`, carrying the name the way that was asked, if it can be. */
function entryFor(name: string, file: Planned): TarEntry {
  const via = carrying(name, file.wanted);
  return {
    name,
    data: file.data,
    mode: file.mode,
    via,
    // A prefix is only read from a ustar header; the other ways carry a name in any format.
    header: { format: via === 'prefix' ? 'ustar' : file.format },
  };
}

const archiveShape = fc.record({
  files: fc.uniqueArray(planned, { selector: (file) => file.path, minLength: 1, maxLength: 12 }),
  wrap: tail.map((rest) => `w${rest}`),
  folders: fc.boolean(),
  end: fc.constantFrom<'two' | 'padded'>('two', 'padded'),
  zipped: fc.boolean(),
});

describe('what is written is read back as the same tree', () => {
  it('holds for any set of files, however their names are carried, wrapped in a folder, plain or gzipped', () => {
    fc.assert(
      fc.property(archiveShape, (shape) => {
        const entries = shape.files.map((file) => entryFor(`${shape.wrap}/${file.path}`, file));
        const folderEntries: TarEntry[] = shape.folders
          ? [{ name: `${shape.wrap}/`, typeflag: '5' }]
          : [];
        const written = tarOf([...folderEntries, ...entries], { end: shape.end });
        const bytes = shape.zipped ? gzip(written) : written;
        const expected = treeOf(
          Object.fromEntries(
            shape.files.map((file): [string, EntrySpec] => [
              file.path,
              { bytes: file.data, exec: (file.mode & 0o100) !== 0 },
            ]),
          ),
        );

        const read = readTarArchive(bytes);

        expect(treeDigest(read.tree)).toBe(treeDigest(expected));
        expect(read.topFolder).toBe(shape.wrap);
      }),
      { numRuns: RUNS },
    );
  });

  it('holds with a file at the top, which keeps every path as it was written', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(planned, { selector: (file) => file.path, maxLength: 8 }),
        (files) => {
          const top: Planned = {
            path: 'ftop.txt',
            data: new Uint8Array([1, 2, 3]),
            mode: 0o644,
            wanted: 'header',
            format: 'ustar',
          };
          const all = [top, ...files.filter((file) => file.path !== top.path)];

          const read = readTarArchive(tarOf(all.map((file) => entryFor(file.path, file))));

          expect(read.topFolder).toBeNull();
          expect(read.tree.entries.map((entry) => entry.path).sort()).toEqual(
            all.map((file) => file.path).sort(),
          );
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// ---------------------------------------------------------------------------------------------
// What is done to it is a tree or the typed error
// ---------------------------------------------------------------------------------------------

const LONG = `${'long-folder-name/'.repeat(8)}file.txt`;
const SAMPLE: (TarEntry | Uint8Array)[] = [
  concat(paxBlocks({ comment: '0123456789abcdef0123456789abcdef01234567' }, 'g')),
  { name: 'pkg/', typeflag: '5' },
  { name: 'pkg/SKILL.md', data: '---\nname: s\n---\n# s\n' },
  { name: 'pkg/run.sh', data: '#!/bin/sh\necho hi\n', mode: 0o755 },
  { name: `pkg/${LONG}`, data: 'pax', via: 'pax' },
  { name: `pkg/${LONG}2`, data: 'gnu', via: 'gnu' },
  { name: `pkg/${LONG}3`, data: 'prefix', via: 'prefix' },
  { name: 'pkg/big.bin', data: new Uint8Array(1500).fill(7) },
];

type Mutation =
  | { readonly kind: 'flip'; readonly at: number; readonly xor: number }
  | { readonly kind: 'set'; readonly at: number; readonly value: number }
  | { readonly kind: 'truncate'; readonly at: number }
  | { readonly kind: 'insert'; readonly at: number; readonly bytes: Uint8Array }
  | { readonly kind: 'zero'; readonly at: number; readonly length: number }
  | { readonly kind: 'append'; readonly bytes: Uint8Array };

const mutation = fc.oneof(
  fc.record({
    kind: fc.constant('flip' as const),
    at: fc.nat(),
    xor: fc.integer({ min: 1, max: 255 }),
  }),
  fc.record({
    kind: fc.constant('set' as const),
    at: fc.nat(),
    value: fc.integer({ min: 0, max: 255 }),
  }),
  fc.record({ kind: fc.constant('truncate' as const), at: fc.nat() }),
  fc.record({
    kind: fc.constant('insert' as const),
    at: fc.nat(),
    bytes: fc.uint8Array({ maxLength: 40 }),
  }),
  fc.record({
    kind: fc.constant('zero' as const),
    at: fc.nat(),
    length: fc.integer({ min: 1, max: 600 }),
  }),
  fc.record({ kind: fc.constant('append' as const), bytes: fc.uint8Array({ maxLength: 700 }) }),
);

/** The bytes with one change made: a new array, the original is not touched. */
function mutate(bytes: Uint8Array, change: Mutation): Uint8Array {
  const length = Math.max(1, bytes.length);
  switch (change.kind) {
    case 'append':
      return concat([bytes, change.bytes]);
    case 'truncate':
      return bytes.slice(0, change.at % length);
    case 'insert': {
      const at = change.at % length;
      return concat([bytes.subarray(0, at), change.bytes, bytes.subarray(at)]);
    }
    case 'zero': {
      const out = bytes.slice();
      out.fill(0, change.at % length, (change.at % length) + change.length);
      return out;
    }
    case 'flip':
    case 'set': {
      const out = bytes.slice();
      const at = change.at % length;
      out[at] = change.kind === 'flip' ? (out[at] ?? 0) ^ change.xor : change.value;
      return out;
    }
  }
}

const mutated = (base: Uint8Array, changes: readonly Mutation[]): Uint8Array =>
  changes.reduce(mutate, base);

/** What has to be true of a tree that was read, whatever the bytes it was read from. */
function expectSound(outcome: Outcome): void {
  if ('refused' in outcome) {
    expect(outcome.refused.message.length).toBeGreaterThan(0);
    return;
  }
  const { tree } = outcome.read;
  expect(() => treeDigest(tree)).not.toThrow();
  for (const entry of tree.entries) {
    expect(checkEntryPath(entry.path).ok).toBe(true);
    expect(entry.bytes?.length).toBe(entry.size);
  }
}

describe('what is done to an archive ends in a tree or in the typed error', () => {
  const base = tarOf(SAMPLE);

  it('reads the sample, or the tests below prove nothing about it', () => {
    expect(readTarArchive(base).tree.entries.length).toBe(6);
  });

  it('holds for a plain archive with bytes changed, cut, added and zeroed', () => {
    fc.assert(
      fc.property(fc.array(mutation, { minLength: 1, maxLength: 6 }), (changes) => {
        expectSound(readOrRefuse(mutated(base, changes)));
      }),
      { numRuns: RUNS * 2 },
    );
  });

  it('holds for a gzipped archive that was changed before it was gzipped, so that the tar is what is hit', () => {
    fc.assert(
      fc.property(fc.array(mutation, { minLength: 1, maxLength: 6 }), (changes) => {
        expectSound(readOrRefuse(gzip(mutated(base, changes))));
      }),
      { numRuns: RUNS },
    );
  });

  it('holds for a gzip file that was changed after, so that the gzip is what is hit', () => {
    const zipped = gzip(base);

    fc.assert(
      fc.property(fc.array(mutation, { minLength: 1, maxLength: 4 }), (changes) => {
        expectSound(readOrRefuse(mutated(zipped, changes)));
      }),
      { numRuns: RUNS },
    );
  });

  it('holds for any bytes at all', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 3000 }), (bytes) => {
        expectSound(readOrRefuse(bytes));
      }),
      { numRuns: RUNS },
    );
  });

  it('holds for headers that add up, whatever they say and wherever the data is', () => {
    const header = fc.record({
      typeflag: fc.constantFrom(
        '0',
        '\0',
        '1',
        '2',
        '3',
        '4',
        '5',
        '6',
        '7',
        'x',
        'g',
        'L',
        'K',
        'S',
        'V',
        'Z',
      ),
      name: fc.constantFrom(
        'a',
        'pkg/b.txt',
        '../x',
        '/abs',
        'pkg/c/d.txt',
        'dup',
        'dup',
        'pkg/.git/x',
        'A',
        'a/b',
      ),
      size: fc.constantFrom(0, 1, 5, 511, 512, 513, 2000, 100_000),
      dataLength: fc.constantFrom(0, 1, 5, 511, 512, 513, 2000),
      mode: fc.constantFrom(0, 0o644, 0o755, 0o7777),
      format: fc.constantFrom<Format>('ustar', 'gnu', 'v7'),
    });
    const ends = fc.constantFrom<'two' | 'padded' | 'one' | 'none'>('two', 'padded', 'one', 'none');

    fc.assert(
      fc.property(fc.array(header, { minLength: 1, maxLength: 8 }), ends, (headers, end) => {
        const parts = headers.flatMap((one) => [
          headerBlock({
            name: one.name,
            typeflag: one.typeflag,
            size: one.size,
            mode: one.mode,
            format: one.format,
          }),
          ...(one.dataLength > 0 ? [dataBlocks(new Uint8Array(one.dataLength).fill(0x61))] : []),
        ]);

        expectSound(readOrRefuse(tarOf([concat(parts)], { end })));
      }),
      { numRuns: RUNS * 2 },
    );
  });

  it('holds for pax records that are well formed or nearly', () => {
    const record = fc.oneof(
      fc
        .constantFrom('path', 'size', 'mtime', 'linkpath', 'GNU.sparse.name', 'comment')
        .chain((key) => fc.string({ maxLength: 20 }).map((value) => `${key}=${value}\n`)),
      fc.string({ maxLength: 30 }),
    );

    fc.assert(
      fc.property(
        fc.array(record, { maxLength: 5 }),
        fc.constantFrom<'x' | 'g'>('x', 'g'),
        (lines, typeflag) => {
          // Each line gets a length that is right, or one that is a little wrong.
          const body = lines.map((line) => {
            const text = ` ${line}`;
            return `${text.length + String(text.length).length}${text}`;
          });
          const records = new TextEncoder().encode(body.join(''));

          expectSound(
            readOrRefuse(
              tarOf([concat(paxBlocks(records, typeflag)), { name: 'pkg/a.txt', data: 'x' }]),
            ),
          );
        },
      ),
      { numRuns: RUNS * 2 },
    );
  });
});

describe('the properties are not empty', () => {
  it('finds some archives that are refused and some that are read, among the changed ones', () => {
    const base = tarOf(SAMPLE);
    let read = 0;
    let refused = 0;

    fc.assert(
      fc.property(fc.array(mutation, { minLength: 1, maxLength: 3 }), (changes) => {
        const outcome = readOrRefuse(mutated(base, changes));
        if ('read' in outcome) read += 1;
        else refused += 1;
      }),
      { numRuns: 300, seed: 7 },
    );

    expect(read).toBeGreaterThan(10);
    expect(refused).toBeGreaterThan(10);
  });
});
