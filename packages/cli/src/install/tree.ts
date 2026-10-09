// The tree of an artifact and its digest, `stroq-tree/1`.
//
// The digest is the one name of an artifact that survives being copied, renamed or fetched twice. An
// author quotes it in a README, a lock file pins it, and `stroq vet --expect` compares against it, each
// on a machine this code has never seen, so the format is a contract and is written out in full in
// docs/superpowers/specs/2026-10-10-safe-install.md. In short, the hash is of this text:
//
//     stroq-tree/1\n
//     <k> <x> <size> <sha256> <path>\n        one line per entry, in the order of the UTF-8 bytes of the path
//
// with k `f`, `l` or `g` (file, symlink, gitlink), x `1` for an executable file and `0` for anything
// else, size and sha256 those of the raw bytes (of the target text for a symlink; 0 and 64 zeros for a
// gitlink), and the path last, so that a space in it is not a separator.
//
// A tree is checked every time it is hashed, not once when it is made: the bytes of a tree are the
// ones that get analysed and then written, and a digest that was true when it was taken says nothing
// of bytes that changed since.
import { createHash } from 'node:crypto';
import { checkEntryPath, isWellFormed, quotePath } from './safe-path.js';
import { LIMITS, type EntryKind, type Tree, type TreeEntry } from './types.js';

/** The first line of the text that is hashed. A change to the format is a new name, never a quiet edit. */
export const TREE_FORMAT = 'stroq-tree/1';

/** What a gitlink records instead of a hash: there is nothing of it to hash, and it is never opened. */
export const GITLINK_SHA256 = '0'.repeat(64);

export type TreeErrorCode =
  /** A path that is not safe to write (see `checkEntryPath`). */
  | 'bad-path'
  | 'duplicate-path'
  /** A path that is a file and also the folder of another entry. */
  | 'path-conflict'
  /** An entry that is not shaped like one: an unknown kind, a size that is not a size, bytes on a link. */
  | 'bad-entry'
  | 'size-mismatch'
  | 'digest-mismatch'
  /** Over a limit of `LIMITS`. */
  | 'limit';

/**
 * Why a tree is refused. `message` is a fixed phrase and the path in quotes with everything that could
 * act on a terminal written out, so it is safe to print. `path` is the offending path exactly as
 * it was given: text from outside, and not to be shown without the same care.
 */
export class TreeError extends Error {
  readonly code: TreeErrorCode;
  readonly path: string | null;

  constructor(code: TreeErrorCode, message: string, path: string | null = null) {
    super(message);
    this.name = 'TreeError';
    this.code = code;
    this.path = path;
  }
}

/** The SHA-256 of raw bytes, in lower-case hex. Of the bytes in the view, not of the buffer under it. */
export function fileDigestOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
const KIND_LETTER: Readonly<Record<EntryKind, string>> = { file: 'f', symlink: 'l', gitlink: 'g' };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

// ---------------------------------------------------------------------------------------------
// One entry
// ---------------------------------------------------------------------------------------------

/** Throws the TreeError for one entry, whose path is quoted in the message. */
type Fail = (code: TreeErrorCode, what: string) => never;

function failFor(path: unknown): Fail {
  const where = typeof path === 'string' ? quotePath(path) : 'an entry with no text for a path';
  return (code, what) => {
    throw new TreeError(code, `entry ${where}: ${what}`, typeof path === 'string' ? path : null);
  };
}

/** What every kind of entry has. */
interface Header {
  readonly kind: EntryKind;
  readonly size: number;
  readonly sha256: string;
}

/** The fields every entry has, checked for what they are and not yet for what they say. */
function checkHeader(raw: Record<string, unknown>, fail: Fail): Header {
  const { path, kind, exec, size, sha256 } = raw;
  const checked = checkEntryPath(path);
  if (!checked.ok) return fail('bad-path', `path refused: ${checked.reason}`);
  if (kind !== 'file' && kind !== 'symlink' && kind !== 'gitlink') {
    return fail('bad-entry', 'kind is not file, symlink or gitlink');
  }
  if (typeof exec !== 'boolean') return fail('bad-entry', 'exec is not true or false');
  // A symlink or a nested repository has no mode of its own to speak of, and readers differ in what
  // they make of the one the disk shows: the flag is a fact about files only, or digests would differ.
  if (exec && kind !== 'file') return fail('bad-entry', 'only a file can be executable');
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
    return fail('bad-entry', 'size is not a whole number of bytes');
  }
  if (typeof sha256 !== 'string' || !SHA256_HEX.test(sha256)) {
    return fail('bad-entry', 'sha256 is not 64 lower-case hex digits');
  }
  return { kind, size, sha256 };
}

/** What each kind of entry may carry: a file its bytes, a symlink its target text, a gitlink nothing. */
function checkCarried(header: Header, bytes: unknown, target: unknown, fail: Fail): void {
  if (header.kind === 'file') {
    if (target !== undefined) fail('bad-entry', 'a file has no target');
    if (bytes !== undefined && !(bytes instanceof Uint8Array)) {
      fail('bad-entry', 'bytes are not bytes');
    }
  } else if (header.kind === 'symlink') {
    if (bytes !== undefined) fail('bad-entry', 'a symlink has a target and no bytes');
    const notText = typeof target !== 'string' || target === '' || !isWellFormed(target);
    if (target !== undefined && notText) fail('bad-entry', 'the target of a symlink is not text');
  } else {
    if (bytes !== undefined || target !== undefined) fail('bad-entry', 'a gitlink has no content');
    if (header.size !== 0) fail('size-mismatch', 'a gitlink records a size of 0');
    if (header.sha256 !== GITLINK_SHA256) {
      fail('digest-mismatch', 'a gitlink records 64 zeros for its hash');
    }
  }
}

/**
 * That the size and the hash an entry records are those of what it carries (a symlink is hashed by
 * its target text). The length is compared before anything is encoded or hashed: a text is never
 * fewer bytes than it has UTF-16 units, so a target longer than its recorded size is wrong unread.
 */
function checkContent(header: Header, bytes: unknown, target: unknown, fail: Fail): void {
  const { size, sha256 } = header;
  if (bytes instanceof Uint8Array) {
    if (bytes.byteLength !== size) {
      fail('size-mismatch', `size is ${size}, the bytes are ${bytes.byteLength}`);
    }
    if (fileDigestOf(bytes) !== sha256) fail('digest-mismatch', 'sha256 is not that of the bytes');
  } else if (typeof target === 'string') {
    if (target.length > size) fail('size-mismatch', `size is ${size}, the target is longer`);
    const text = Buffer.from(target, 'utf8');
    if (text.byteLength !== size) {
      fail('size-mismatch', `size is ${size}, the target is ${text.byteLength}`);
    }
    if (fileDigestOf(text) !== sha256) fail('digest-mismatch', 'sha256 is not that of the target');
  }
}

/**
 * Checks one entry and says how many bytes it adds to the tree. Everything is checked that can be
 * checked from the entry itself: its path, its shape, the rules of its kind, the limits, and that
 * its record agrees with what it carries. The limits are judged before anything is hashed, so a tree
 * that is too big is refused for being too big and not after the work of hashing it.
 */
function checkEntry(raw: unknown, expandedSoFar: number): { entry: TreeEntry; size: number } {
  if (!isRecord(raw)) throw new TreeError('bad-entry', 'an entry is not an object');
  const fail = failFor(raw['path']);
  const header = checkHeader(raw, fail);
  const { bytes, target } = raw;
  checkCarried(header, bytes, target, fail);
  if (header.size > LIMITS.maxFileBytes) {
    fail('limit', `${header.size} bytes is over the ${LIMITS.maxFileBytes} a file may be`);
  }
  if (expandedSoFar + header.size > LIMITS.maxExpanded) {
    fail('limit', `the tree is over ${LIMITS.maxExpanded} bytes in all`);
  }
  checkContent(header, bytes, target, fail);
  return { entry: raw as unknown as TreeEntry, size: header.size };
}

// ---------------------------------------------------------------------------------------------
// All the entries
// ---------------------------------------------------------------------------------------------

interface Checked {
  readonly entry: TreeEntry;
  /** The UTF-8 bytes of the path: what the order of a tree is the order of. */
  readonly key: Buffer;
}

/** Whether a proper folder of `path` is itself the path of an entry. */
function hasEntryAsFolder(path: string, paths: ReadonlySet<string>): boolean {
  for (let slash = path.indexOf('/'); slash !== -1; slash = path.indexOf('/', slash + 1)) {
    if (paths.has(path.slice(0, slash))) return true;
  }
  return false;
}

/** The entries of a tree, checked and in the order of the UTF-8 bytes of their paths. Throws a TreeError. */
function checkedEntries(tree: unknown): readonly Checked[] {
  const entries = isRecord(tree) ? tree['entries'] : undefined;
  if (!Array.isArray(entries)) throw new TreeError('bad-entry', 'a tree has a list of entries');
  if (entries.length > LIMITS.maxEntries) {
    throw new TreeError('limit', `the tree has more than ${LIMITS.maxEntries} entries`);
  }

  let expanded = 0;
  const checked: Checked[] = [];
  for (const raw of entries) {
    const { entry, size } = checkEntry(raw, expanded);
    expanded += size;
    checked.push({ entry, key: Buffer.from(entry.path, 'utf8') });
  }
  checked.sort((a, b) => Buffer.compare(a.key, b.key));

  for (let i = 1; i < checked.length; i += 1) {
    const before = checked[i - 1];
    const after = checked[i];
    if (before !== undefined && after !== undefined && before.key.equals(after.key)) {
      const path = after.entry.path;
      throw new TreeError('duplicate-path', `path ${quotePath(path)} appears twice`, path);
    }
  }
  const paths = new Set(checked.map(({ entry }) => entry.path));
  for (const { entry } of checked) {
    if (hasEntryAsFolder(entry.path, paths)) {
      const message = `entry ${quotePath(entry.path)}: a folder of this path is also an entry`;
      throw new TreeError('path-conflict', message, entry.path);
    }
  }
  return checked;
}

// ---------------------------------------------------------------------------------------------
// The digest, and the tree
// ---------------------------------------------------------------------------------------------

/**
 * The text that `treeDigest` hashes, for a person who has to see why two digests differ. Throws a
 * TreeError for a tree that is not valid, as `treeDigest` does.
 */
export function treeManifest(tree: Tree): string {
  const lines = checkedEntries(tree).map(({ entry }) => {
    const { kind, exec, size, sha256, path } = entry;
    return `${KIND_LETTER[kind]} ${exec ? 1 : 0} ${size} ${sha256} ${path}\n`;
  });
  return `${TREE_FORMAT}\n${lines.join('')}`;
}

/**
 * The `stroq-tree/1` digest of a tree: 64 lower-case hex characters. It does not depend on the order
 * the entries are in, nor on whether their bytes are there, only on what they record. Throws a
 * TreeError for a tree with a path that is unsafe or appears twice, an entry whose size or hash is not
 * that of its bytes, or one that is over a limit.
 */
export function treeDigest(tree: Tree): string {
  return createHash('sha256').update(treeManifest(tree), 'utf8').digest('hex');
}

/** A copy of an entry that nothing the caller holds points into, bytes included. */
function ownedCopy(entry: TreeEntry): TreeEntry {
  return Object.freeze({
    path: entry.path,
    kind: entry.kind,
    exec: entry.exec,
    size: entry.size,
    sha256: entry.sha256,
    ...(entry.bytes !== undefined ? { bytes: new Uint8Array(entry.bytes) } : {}),
    ...(entry.target !== undefined ? { target: entry.target } : {}),
  });
}

/**
 * A tree from entries: checked as `treeDigest` checks it, sorted in the order of the digest, and
 * frozen. The bytes are copied, so a reader that goes on to reuse its buffers cannot change the
 * bytes that were checked. (A byte array cannot be frozen; `treeDigest` catches a change anyway.)
 */
export function buildTree(entries: readonly TreeEntry[]): Tree {
  const owned = checkedEntries({ entries }).map(({ entry }) => ownedCopy(entry));
  return Object.freeze({ entries: Object.freeze(owned) });
}

export interface TreeStats {
  /** Regular files only: a symlink or a nested repository is not one. */
  readonly files: number;
  /** The bytes of those files. */
  readonly bytes: number;
}

/** What to say a tree is made of: how many files, and how many bytes they hold. */
export function treeStats(tree: Tree): TreeStats {
  const files = tree.entries.filter((entry) => entry.kind === 'file');
  return { files: files.length, bytes: files.reduce((total, entry) => total + entry.size, 0) };
}
