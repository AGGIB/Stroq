import { createHash } from 'node:crypto';
import { buildTree, TreeError, treeDigest, type TreeErrorCode } from '../../src/install/tree.js';
import type { Tree, TreeEntry } from '../../src/install/types.js';

/**
 * How `treeOf` is told what one entry is:
 *
 * - a string: a plain file with that text;
 * - `{ text, exec }` or `{ bytes, exec }`: a file, optionally executable;
 * - `{ symlink }`: a symbolic link to that target text;
 * - `{ gitlink: true }`: a nested repository, which a tree records and never opens.
 */
export type EntrySpec =
  | string
  | { readonly text: string; readonly exec?: boolean }
  | { readonly bytes: Uint8Array; readonly exec?: boolean }
  | { readonly symlink: string }
  | { readonly gitlink: true };

/**
 * The sha-256 of some bytes, from node:crypto directly. These helpers deliberately do not call the
 * module under test, so that a wrong `fileDigestOf` cannot make a wrong entry look right.
 */
const sha256Of = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const utf8 = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'utf8'));

export function fileEntry(path: string, content: string | Uint8Array, exec = false): TreeEntry {
  const bytes = typeof content === 'string' ? utf8(content) : content;
  return { path, kind: 'file', exec, size: bytes.byteLength, sha256: sha256Of(bytes), bytes };
}

export function symlinkEntry(path: string, target: string): TreeEntry {
  const raw = utf8(target);
  return {
    path,
    kind: 'symlink',
    exec: false,
    size: raw.byteLength,
    sha256: sha256Of(raw),
    target,
  };
}

export function gitlinkEntry(path: string): TreeEntry {
  return { path, kind: 'gitlink', exec: false, size: 0, sha256: '0'.repeat(64) };
}

function entryOf(path: string, spec: EntrySpec): TreeEntry {
  if (typeof spec === 'string') return fileEntry(path, spec);
  if ('symlink' in spec) return symlinkEntry(path, spec.symlink);
  if ('gitlink' in spec) return gitlinkEntry(path);
  return 'text' in spec
    ? fileEntry(path, spec.text, spec.exec === true)
    : fileEntry(path, spec.bytes, spec.exec === true);
}

/** The entries a spec describes, in the order the spec lists them and not yet checked by anything. */
export function entriesOf(files: Readonly<Record<string, EntrySpec>>): TreeEntry[] {
  return Object.entries(files).map(([path, spec]) => entryOf(path, spec));
}

/**
 * A tree built from a spec:
 *
 *     treeOf({ 'a/b.txt': 'text', 'bin/run': { text: '#!/bin/sh', exec: true }, link: { symlink: 'target' } })
 *
 * The tree goes through `buildTree`, so a spec that breaks a rule of the format throws here. A test that
 * needs a tree that is wrong on purpose builds the entries with `entriesOf` and bends them itself.
 */
export function treeOf(files: Readonly<Record<string, EntrySpec>>): Tree {
  return buildTree(entriesOf(files));
}

/** The digest of entries that may not be a valid tree: it throws the `TreeError` that says why not. */
export const digestOf = (entries: readonly TreeEntry[]): string => treeDigest({ entries });

/** The TreeError a call throws; any other outcome fails the test. */
export function refusal(run: () => unknown): TreeError {
  try {
    run();
  } catch (error) {
    if (error instanceof TreeError) return error;
    throw error;
  }
  throw new Error('expected a TreeError, and nothing was thrown');
}

/** The code of the refusal that hashing `entries` meets. */
export const codeOf = (entries: readonly TreeEntry[]): TreeErrorCode =>
  refusal(() => digestOf(entries)).code;

/** A file of a declared size, with no bytes behind it: a tree read back from a manifest looks like this. */
export const declared = (path: string, size: number): TreeEntry => ({
  path,
  kind: 'file',
  exec: false,
  size,
  sha256: 'ab'.repeat(32),
});
