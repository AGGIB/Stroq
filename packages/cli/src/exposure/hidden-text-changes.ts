import { settle, type TaggedHit } from './agent-change.js';
import { hit } from './agent-kinds.js';
import { MAX_FILE_BYTES, MAX_TOTAL_BYTES } from './agent-surface.js';
import { hiddenTextHit } from './agent-text.js';
import { readBlobs, type Changed, type TreeEntry } from './git-read.js';
import { byPath, isBlob } from './git-tree.js';

/**
 * Any text a change adds or edits that an agent may be pointed at, not only the files a host reads
 * by name: a `CLAUDE.md` can import `@docs/rules.md`, and many hosts read rules folders this check
 * does not know. So every `.md`, `.mdc` and `.txt` file the change adds or edits, wherever it is,
 * is scanned for what a reader does not see (see `hiddenTextHit`), and so are bytes that are not
 * UTF-8, which a reader may decode as controls. One too big to scan, or past the files and bytes
 * one check reads, fails. A link is left to the reading of links.
 */

const TEXT_FILE = /\.(?:md|mdc|txt)$/i;
/** The most such files one check scans; past it, one finding fails. */
const MAX_TEXT_FILES = 5_000;
/** What lossy UTF-8 decoding puts for bytes that are not UTF-8. */
const NOT_UTF8 = '�';

export function hiddenTextChanges(
  top: string,
  tree: ReadonlyMap<string, TreeEntry>,
  changed: ReadonlyMap<string, Changed>,
  scanned: ReadonlySet<string>,
): TaggedHit[] {
  const status = (path: string): 'new' | 'changed' =>
    changed.get(path)?.status === 'A' ? 'new' : 'changed';
  const out: TaggedHit[] = [];
  const unread = (path: string, why: string): void => {
    out.push(settle(hit('unreadable-config', path, 1, 'hidden text', why), status(path)));
  };
  const files = [...changed]
    .filter(
      ([path, c]) =>
        (c.status === 'A' || c.status === 'M' || c.status === 'T') &&
        TEXT_FILE.test(path) &&
        !scanned.has(path),
    )
    .map(([path]) => path)
    .sort(byPath);
  const wanted: { readonly path: string; readonly head: TreeEntry }[] = [];
  let bytes = 0;
  for (const [i, path] of files.entries()) {
    if (i >= MAX_TEXT_FILES || bytes > MAX_TOTAL_BYTES) {
      unread(path, `${files.length - i} more text files were not scanned for hidden characters`);
      break;
    }
    const head = tree.get(path);
    if (head === undefined || !isBlob(head)) continue;
    if (head.size > MAX_FILE_BYTES) {
      unread(path, 'too big to scan for hidden characters');
      continue;
    }
    bytes += head.size;
    wanted.push({ path, head });
  }
  const blobs = readBlobs(
    top,
    wanted.map((w) => w.head),
  );
  for (const { path, head } of wanted) {
    const text = blobs.get(head.oid);
    if (text === undefined) {
      unread(path, 'not read, so not scanned for hidden characters');
      continue;
    }
    const found = hiddenTextHit(path, text);
    if (found !== undefined) out.push(settle(found, status(path)));
    else if (text.includes(NOT_UTF8))
      out.push(
        settle(
          hit('instruction-hidden-text', path, 1, 'hidden', 'bytes that are not UTF-8'),
          status(path),
        ),
      );
  }
  return out;
}
