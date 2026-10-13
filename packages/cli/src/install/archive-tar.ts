// A tar archive, read into the in-memory tree of Safe Install (`stroq vet --from <archive>`).
//
// Our own reader, with no dependency, because the archive is somebody else's: an archive is read as a
// hostile input, and every decision that a general-purpose extractor leaves to the caller is made here,
// in the direction of refusing.
//
//  - It works in memory and only in memory. Nothing in an archive is executed, and no file or folder is
//    made from one: there is no path in this file that goes to a disk.
//  - Files are read. Folders are recognised and not recorded (an empty folder is not in the digest).
//    Everything else is refused, and the whole archive with it, not skipped: a link, a device, a FIFO, a
//    sparse or contiguous file, a type nobody knows. A tool that left them out would give a tree that is
//    not the archive and a digest that no one else can reproduce.
//  - The formats are those that npm, GitHub and GNU tar write: ustar, GNU long names (`L`), and pax
//    (`x` for the next entry, `g` for all of them, of which only the keys that do not change a name or a
//    size are allowed). The owner, the group and the times are checked to be numbers and are not kept.
//  - A header that npm's extractor (node-tar) would skip or read another way is refused, never read:
//    it skips a header it finds wrong and reads what follows as headers, so a reader that accepts the
//    header sees one file where npm installs two (`tar-header.ts`, `tar-number.ts`, `tar-pax.ts`).
//  - Sizes are checked against the limits before anything is sliced, so a header that claims 8 GiB in an
//    archive of 1 MiB costs nothing. The counting is as it goes, and the first limit stops the reading.
//  - The end is two blocks of zeros and then only zeros. A missing end, a lone zero block, data after the
//    end and a cut-off archive are each refused, with a phrase of their own.
//  - Every name must be valid UTF-8, is judged by the path rules of the tree, and is said in a message only
//    quoted and written out. The one folder that wraps all the files (`package/`, `owner-repo-sha/`) is
//    taken off, and its name is returned, because it is where a GitHub commit shows.
//
// The reading is one pass over the bytes, a block at a time, with no recursion over entries.
import { ArchiveError } from './archive-error.js';
import { foreignFormat, gunzipOnce, isGzip } from './archive-gzip.js';
import { treeOfFiles, type ArchiveRead, type CollectedFile } from './archive-tree.js';
import {
  BLOCK,
  MAX_NAME_BYTES,
  TYPE,
  decodeName,
  hasValidChecksum,
  isZeroBlock,
  readHeader,
  unsupportedType,
  type TarHeader,
} from './tar-header.js';
import { MAX_PAX_BYTES, parsePax } from './tar-pax.js';
import { LIMITS } from './types.js';

export type { ArchiveRead } from './archive-tree.js';

/** The fixed phrases of the blind spots this reader adds, for the tests and for a caller that matches on them. */
export const ARCHIVE_BLIND_SPOTS = Object.freeze({
  specialModeBits:
    'a set-user-id, set-group-id or sticky bit in the archive was not kept: only the owner-execute bit is',
});

// ---------------------------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------------------------

/** The limits a read is held to. A caller may ask for less than `LIMITS`, never more. */
export interface ArchiveLimits {
  readonly maxEntries?: number;
  readonly maxFileBytes?: number;
  readonly maxExpanded?: number;
  readonly maxCompressed?: number;
}

export interface ArchiveOptions {
  readonly limits?: ArchiveLimits;
}

export interface HeldLimits {
  readonly maxEntries: number;
  readonly maxFileBytes: number;
  readonly maxExpanded: number;
  readonly maxCompressed: number;
  /** Headers of every kind, folders and extended headers too: an archive of a million empty folders is not a tree either. */
  readonly maxRecords: number;
}

/** The smaller of what was asked for and what the contract allows. */
export function heldLimits(limits: ArchiveLimits = {}): HeldLimits {
  const least = (asked: number | undefined, allowed: number): number =>
    asked === undefined || !(asked >= 0) ? allowed : Math.min(asked, allowed);
  const maxEntries = least(limits.maxEntries, LIMITS.maxEntries);
  return {
    maxEntries,
    maxFileBytes: least(limits.maxFileBytes, LIMITS.maxFileBytes),
    maxExpanded: least(limits.maxExpanded, LIMITS.maxExpanded),
    maxCompressed: least(limits.maxCompressed, LIMITS.maxCompressed),
    maxRecords: 4 * maxEntries,
  };
}

const overLimit = (message: string): ArchiveError => new ArchiveError('limit', message);
const corrupt = (message: string): ArchiveError => new ArchiveError('corrupt', message);

// ---------------------------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------------------------

const OWNER_EXECUTE = 0o100;
const SPECIAL_MODE_BITS = 0o7000;
const NOT_FOLLOWED = 'an extended header of the archive is not followed by the entry it describes';

/** What a pax header or a GNU long name says of the entry that comes next. */
interface Pending {
  readonly path: string | null;
  readonly size: number | null;
}

/** What a walk collects as it goes; local to one read. */
interface Walk {
  readonly tar: Uint8Array;
  readonly limits: HeldLimits;
  readonly files: CollectedFile[];
  pos: number;
  records: number;
  expanded: number;
  specialModeBits: boolean;
  pending: Pending | null;
}

/** The data of an entry, a view into the archive, and the position moved past it and its padding. */
function takeData(walk: Walk, size: number): Uint8Array {
  const padded = Math.ceil(size / BLOCK) * BLOCK;
  if (walk.pos + padded > walk.tar.length)
    throw corrupt('the archive ends inside the data of a file');
  const data = walk.tar.subarray(walk.pos, walk.pos + size);
  walk.pos += padded;
  return data;
}

function takePending(walk: Walk): Pending | null {
  const { pending } = walk;
  walk.pending = null;
  return pending;
}

/** How many components a name has, counted without splitting it. */
function depthOf(path: string): number {
  let depth = 1;
  for (let at = path.indexOf('/'); at !== -1; at = path.indexOf('/', at + 1)) depth += 1;
  return depth;
}

const PAX_SIZE =
  'an extended header of the archive gives a size that is not the size in the header';

/**
 * A pax size has to be the size in the header. It is only needed for a file of 8 GiB or more, which is
 * over the limits anyway, and where the two differ, programs read different files: a reader that takes
 * the pax size reads the data of the entry as that long, and one that takes the header's reads what is
 * left as headers.
 */
function checkPaxSize(pending: Pending | null, header: TarHeader): void {
  if (pending !== null && pending.size !== null && pending.size !== header.size) {
    throw corrupt(PAX_SIZE);
  }
}

function addFile(walk: Walk, header: TarHeader): void {
  const pending = takePending(walk);
  const path = pending?.path ?? decodeName(header.nameBytes);
  const size = pending?.size ?? header.size;
  if (path.endsWith('/'))
    throw new ArchiveError('refused', 'a file in the archive has a trailing slash in its name');
  // The wrapping folder is not known yet, and takes one component off: past that many a path is too deep
  // whatever is taken off it. The exact depth is the tree's to judge.
  if (depthOf(path) > LIMITS.maxDepth + 1) {
    throw overLimit(`a path in the archive is deeper than ${LIMITS.maxDepth} components`);
  }
  const { limits } = walk;
  if (walk.files.length >= limits.maxEntries) {
    throw overLimit(`the archive has more than ${limits.maxEntries} files`);
  }
  if (size > limits.maxFileBytes) {
    throw overLimit(`a file in the archive is over the ${limits.maxFileBytes} bytes a file may be`);
  }
  if (walk.expanded + size > limits.maxExpanded) {
    throw overLimit(`the files in the archive are over ${limits.maxExpanded} bytes in all`);
  }
  checkPaxSize(pending, header);
  const bytes = takeData(walk, size);
  walk.expanded += size;
  walk.specialModeBits ||= (header.mode & SPECIAL_MODE_BITS) !== 0;
  walk.files.push({ path, exec: (header.mode & OWNER_EXECUTE) !== 0, bytes });
}

/** A folder is not recorded. Its name still has to be text, and it has no data: the size field is not for a reader to skip by. */
function addFolder(walk: Walk, header: TarHeader): void {
  const pending = takePending(walk);
  if ((pending?.path ?? null) === null) decodeName(header.nameBytes);
  checkPaxSize(pending, header);
  if ((pending?.size ?? header.size) !== 0) throw corrupt('a folder in the archive has data in it');
}

function takeExtended(walk: Walk, header: TarHeader, isGlobal: boolean): void {
  if (walk.pending !== null) throw corrupt(NOT_FOLLOWED);
  if (header.size > MAX_PAX_BYTES) {
    throw overLimit(`an extended header in the archive is over ${MAX_PAX_BYTES} bytes`);
  }
  const pax = parsePax(takeData(walk, header.size), isGlobal);
  if (!isGlobal) walk.pending = pax;
}

/** A GNU long name: the data is the name of the next entry, with a NUL at the end. */
function takeLongName(walk: Walk, header: TarHeader): void {
  if (walk.pending !== null) throw corrupt(NOT_FOLLOWED);
  if (header.size > MAX_NAME_BYTES + 1) {
    throw overLimit(`a long name in the archive is over ${MAX_NAME_BYTES} bytes`);
  }
  const data = takeData(walk, header.size);
  let end = data.length;
  while (end > 0 && data[end - 1] === 0) end -= 1;
  walk.pending = { path: decodeName(data.subarray(0, end)), size: null };
}

function handle(walk: Walk, header: TarHeader): void {
  switch (header.type) {
    case TYPE.file:
    case TYPE.oldFile:
      return addFile(walk, header);
    case TYPE.directory:
      return addFolder(walk, header);
    case TYPE.pax:
      return takeExtended(walk, header, false);
    case TYPE.globalPax:
      return takeExtended(walk, header, true);
    case TYPE.gnuLongName:
      return takeLongName(walk, header);
    default:
      throw unsupportedType(header.type);
  }
}

const NOT_A_TAR = 'this is not a tar archive (its first header does not add up)';

/** What to say of bytes that are not a tar archive: the name of a format they look like, or that they are not one. */
const notATar = (tar: Uint8Array): ArchiveError =>
  new ArchiveError('not-a-tar', foreignFormat(tar) ?? NOT_A_TAR);

/** Reads the headers and their data to the end marker. */
function walkArchive(walk: Walk): void {
  const { tar } = walk;
  let zeros = 0;
  while (zeros < 2) {
    if (walk.pos === tar.length)
      throw corrupt('the archive ends without its end marker (two empty blocks)');
    if (walk.pos + BLOCK > tar.length) throw corrupt('the archive ends in the middle of a header');
    const block = tar.subarray(walk.pos, walk.pos + BLOCK);
    walk.pos += BLOCK;
    if (isZeroBlock(block)) {
      zeros += 1;
      continue;
    }
    if (zeros === 1) throw corrupt('the archive has an empty block in the middle of it');
    walk.records += 1;
    if (walk.records > walk.limits.maxRecords) {
      throw overLimit(`the archive has more than ${walk.limits.maxRecords} entries`);
    }
    if (!hasValidChecksum(block)) {
      throw walk.records === 1 ? notATar(tar) : corrupt('the checksum of a header does not match');
    }
    handle(walk, readHeader(block));
  }
  if (walk.pending !== null) throw corrupt(NOT_FOLLOWED);
  for (let at = walk.pos; at < tar.length; at += 1) {
    if (tar[at] !== 0) throw corrupt('the archive has data after the end of the archive');
  }
}

// ---------------------------------------------------------------------------------------------
// The archive
// ---------------------------------------------------------------------------------------------

/** The bytes of the tar inside: the archive itself, or what a gzip layer expands to, under the limits of each. */
function unpack(input: Uint8Array, limits: HeldLimits): Uint8Array {
  if (isGzip(input)) {
    if (input.length > limits.maxCompressed) {
      throw overLimit(`the compressed archive is over ${limits.maxCompressed} bytes`);
    }
    return gunzipOnce(input, limits.maxExpanded);
  }
  if (input.length > limits.maxExpanded) {
    throw overLimit(`the archive is over ${limits.maxExpanded} bytes`);
  }
  return input;
}

/**
 * The tree of a tar archive, plain or gzipped (told by the first two bytes), and what was not looked at.
 * Throws an `ArchiveError`; the faults of a tree come back as one with the code `refused` (or `limit`)
 * and the tree's code in `treeCode`. The bytes given are not changed and not kept: the files in the tree
 * are copies.
 */
export function readTarArchive(input: Uint8Array, options: ArchiveOptions = {}): ArchiveRead {
  const limits = heldLimits(options.limits);
  const tar = unpack(input, limits);
  if (tar.length === 0) throw new ArchiveError('empty', 'the archive has no files in it');
  if (tar.length < BLOCK) throw notATar(tar);
  const walk: Walk = {
    tar,
    limits,
    files: [],
    pos: 0,
    records: 0,
    expanded: 0,
    specialModeBits: false,
    pending: null,
  };
  walkArchive(walk);
  const blindSpots = walk.specialModeBits ? [ARCHIVE_BLIND_SPOTS.specialModeBits] : [];
  return treeOfFiles(walk.files, blindSpots);
}
