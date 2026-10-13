import { readTarArchive } from '../../src/install/archive-tar.js';
import {
  concat,
  dataBlocks,
  headerBlock,
  tarOf,
  type HeaderFields,
  type TarEntry,
} from './tar-writer.js';

/**
 * Archives for the tests of the headers that npm's extractor (node-tar) reads differently from a
 * reader that is lax about them. The attack they share: a header that node-tar rejects (it skips 512
 * bytes and goes on) is followed by the data of the file it describes, and that data is itself a
 * header and a file. A reader that accepts the outer header sees one file, a program that skips it
 * sees two, and the second is one that was never in the tree that was looked at.
 */
const HIDDEN = '{"name":"x","version":"1.0.0","scripts":{"postinstall":"echo hidden"}}';
const HIDDEN_ENTRY = concat([
  headerBlock({ name: 'package/package.json', size: HIDDEN.length }),
  dataBlocks(HIDDEN),
]);

/** The manifest that is looked at: the entry that comes first. */
const MANIFEST: TarEntry = { name: 'package/package.json', data: '{"name":"x","version":"1.0.0"}' };

/**
 * An archive of a manifest and a file whose data is a second manifest, header and all. With nothing
 * wrong in `outer` the file is read as a file of 1024 bytes and the archive has two entries.
 */
export function hiding(outer: Partial<HeaderFields> = {}): Uint8Array {
  const header = headerBlock(outerFields(outer));
  return tarOf([MANIFEST, concat([header, HIDDEN_ENTRY])]);
}

/** The fields of the header that `hiding` writes before the hidden one, for a test that needs its sum. */
export const outerFields = (outer: Partial<HeaderFields> = {}): Partial<HeaderFields> => ({
  name: 'package/data.bin',
  size: HIDDEN_ENTRY.length,
  ...outer,
});

/** The paths of the files an archive gives, in the order of the digest. */
export const pathsOf = (bytes: Uint8Array): string[] =>
  readTarArchive(bytes).tree.entries.map((entry) => entry.path);

/** The sum of the unsigned bytes of a header with the checksum field counted as spaces. */
export function unsignedSum(fields: Partial<HeaderFields>): number {
  const written = headerBlock({ checksum: 'unsigned', ...fields });
  return Number.parseInt(new TextDecoder('latin1').decode(written.subarray(148, 154)), 8);
}

/** The bytes of a text, NULs and all. */
export const bytesOfText = (value: string): Uint8Array => new TextEncoder().encode(value);

/** `value` at the start of a field of `width` bytes, the rest NUL. */
export function field(width: number, value: string | readonly number[]): Uint8Array {
  const out = new Uint8Array(width);
  out.set(typeof value === 'string' ? bytesOfText(value) : value);
  return out;
}
