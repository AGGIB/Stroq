// From the files of an archive to the tree of Safe Install: the one folder that wraps them is taken
// off, every name is held to the path rules, and the tree contract does the rest.
//
// This is the step after the reader has gone through the whole archive, because what is shared by all
// the names (and so what is taken off) is only known then. Everything cheap is checked before a byte is
// hashed: the names, a path that is given twice. What is left is the tree's own: names that are one
// name on a disk that ignores letter case or Unicode form, a file that is also a folder, the limits.
import { ArchiveError } from './archive-error.js';
import { checkEntryPath, quotePath, stripTopComponent } from './safe-path.js';
import { buildTree, fileDigestOf, TreeError } from './tree.js';
import type { Tree, TreeEntry } from './types.js';

/** A file as the walk of the archive collected it: the name as it was spelled in the archive, and a view of its bytes. */
export interface CollectedFile {
  readonly path: string;
  readonly exec: boolean;
  readonly bytes: Uint8Array;
}

export interface ArchiveRead {
  readonly tree: Tree;
  /** What was not looked at, sorted and without repeats. */
  readonly blindSpots: readonly string[];
  /** The one folder every file was in and that was taken off, or null when nothing was. A name that has passed the path rules. */
  readonly topFolder: string | null;
}

/**
 * A tar made inside a folder with `.` as the thing to pack puts `./` in front of every name, which is
 * the one wrapping that is common and is not taken off: a dot is not a folder, and the path rules
 * refuse it. The refusal says what to do instead.
 */
const DOT_HINT =
  ' (a tar made from inside a folder with . puts ./ before every name; make the archive from the folder above it)';

function refusedPath(path: string, reason: string): ArchiveError {
  const hint = path.startsWith('./') ? DOT_HINT : '';
  return new ArchiveError(
    'refused',
    `entry ${quotePath(path)}: path refused: ${reason}${hint}`,
    'bad-path',
  );
}

/** The folder that was taken off, if one was: the first component of the first name. */
function topFolderOf(raw: string, stripped: string): string | null {
  return stripped === raw ? null : raw.slice(0, raw.length - stripped.length - 1);
}

function checkTopFolder(top: string): void {
  const checked = checkEntryPath(top);
  if (!checked.ok) {
    throw new ArchiveError(
      'refused',
      `the folder the archive is wrapped in, ${quotePath(top)}, is refused: ${checked.reason}`,
      'bad-path',
    );
  }
}

/** Throws for a path the tree would refuse, and for a path that is given twice, before anything is hashed. */
function checkPaths(paths: readonly string[]): void {
  const seen = new Set<string>();
  for (const path of paths) {
    const checked = checkEntryPath(path);
    if (!checked.ok) throw refusedPath(path, checked.reason);
    if (seen.has(path)) {
      throw new ArchiveError(
        'refused',
        `the archive holds the path ${quotePath(path)} twice`,
        'duplicate-path',
      );
    }
    seen.add(path);
  }
}

/** The error for a tree the contract refuses: its code and its fixed phrase, in the archive's words. */
function fromTreeError(error: TreeError): ArchiveError {
  return new ArchiveError(error.code === 'limit' ? 'limit' : 'refused', error.message, error.code);
}

export function treeOfFiles(
  files: readonly CollectedFile[],
  blindSpots: readonly string[],
): ArchiveRead {
  const first = files[0];
  if (first === undefined) throw new ArchiveError('empty', 'the archive has no files in it');
  const paths = stripTopComponent(files.map((file) => file.path));
  const topFolder = topFolderOf(first.path, paths[0] ?? first.path);
  if (topFolder !== null) checkTopFolder(topFolder);
  checkPaths(paths);
  const entries: TreeEntry[] = files.map((file, at) => ({
    path: paths[at] ?? file.path,
    kind: 'file',
    exec: file.exec,
    size: file.bytes.length,
    sha256: fileDigestOf(file.bytes),
    bytes: file.bytes,
  }));
  try {
    const tree = buildTree(entries, { complete: true });
    return Object.freeze({ tree, blindSpots: Object.freeze([...blindSpots].sort()), topFolder });
  } catch (error) {
    if (error instanceof TreeError) throw fromTreeError(error);
    throw error;
  }
}
