// Outputs Claude Code saved to a file because they were too large for the transcript.
//
// A large tool output is not written into the transcript. The result there is a notice
// and a preview, with the path of the file that holds the whole output:
//
//   <persisted-output>
//   Output too large (5.4MB). Full output saved to: ~/.claude/projects/<slug>/<session>/tool-results/ba8jpcsxa.txt
//   Preview (first 2KB): …
//
// The rest of the output, which is where a key printed late in a long log would be, is
// only in that file. The notice is text a tool returned, so it is read as untrusted: only
// the file NAME after a `tool-results/` is taken from it, and the file is looked up in
// this session's own `tool-results` folder. A path that climbs out (`..`), points
// somewhere else, or reaches a link is not read.
//
// A transcript can name the same file in every result, or many files: each file is read once,
// and every read of one scan (all the sessions `stroq sent` reads, or the one `stroq replay`
// reads) comes out of one byte budget. Past it, no saved file is read, and the reader says how
// many it left.
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';

/** Refuse a link at open time as well, where the platform has the flag (not on Windows). */
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

const FOLDER = 'tool-results';
/** Files named per result: a notice names one, and a result is not expected to name many. */
const MAX_NAMES = 8;
/** Longest file name taken from a notice. */
const MAX_NAME_CHARS = 255;
/** Most of one saved file that is read: the largest seen on the machine this was written on is 5.4 MB. */
export const MAX_SPILLED_BYTES = 64 * 1024 * 1024;
/** Most of the saved files that one scan reads, over every session in it. */
export const SPILL_BUDGET_BYTES = 256 * 1024 * 1024;

/** A character a saved file's name is made of: letters, digits, `.`, `_` and `-`. */
function isNameChar(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    code === 0x2e ||
    code === 0x5f ||
    code === 0x2d
  );
}

const isSeparator = (ch: string | undefined): boolean => ch === '/' || ch === '\\';

/**
 * The names of the saved files a result names: what follows each `/tool-results/`, up to the
 * first character a name cannot hold. One pass with `indexOf`, so a long result costs its length.
 */
export function spilledNames(text: string): string[] {
  const names: string[] = [];
  let from = 0;
  while (names.length < MAX_NAMES) {
    const at = text.indexOf(FOLDER, from);
    if (at < 0) break;
    from = at + FOLDER.length;
    if (!isSeparator(text[at - 1]) || !isSeparator(text[from])) continue;
    let end = from + 1;
    while (end < text.length && end - from <= MAX_NAME_CHARS && isNameChar(text.charCodeAt(end)))
      end += 1;
    const name = text.slice(from + 1, end);
    if (name === '' || /^\.+$/.test(name) || names.includes(name)) continue;
    names.push(name);
  }
  return names;
}

/** What reading one saved file gave: its text and size, or that it did not fit what was left. */
type Read =
  | { readonly kind: 'text'; readonly text: string; readonly bytes: number }
  | { readonly kind: 'over' };

/** Whether `path` is a regular file, not a link to one. */
function isRegular(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * A regular file's first `MAX_SPILLED_BYTES`, if that fits in `left` bytes; null for a link, a
 * folder or a missing file.
 */
function readRegular(path: string, left: number): Read | null {
  if (!isRegular(path)) return null;
  // Once the budget is spent, a file is not opened: that it is there is all that is counted.
  if (left < 0) return { kind: 'over' };
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | NO_FOLLOW);
  } catch {
    return null;
  }
  try {
    const size = Math.min(fstatSync(fd).size, MAX_SPILLED_BYTES);
    if (size > left) return { kind: 'over' };
    const buffer = Buffer.alloc(size);
    let read = 0;
    while (read < size) {
      const n = readSync(fd, buffer, read, size - read, read);
      if (n === 0) break;
      read += n;
    }
    return { kind: 'text', text: buffer.subarray(0, read).toString('utf8'), bytes: read };
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** Reads the saved outputs results name, each file once, out of one byte budget. */
export interface SpillReader {
  /**
   * The saved outputs a result names that were not read before, read from `spillDir` and joined
   * by a line break, or null when it names none that is there to read.
   */
  read(text: string, spillDir: string): string | null;
  /** Saved files a result named that were not read because the budget was spent. */
  skipped(): number;
}

export function spillReader(budget: number = SPILL_BUDGET_BYTES): SpillReader {
  // Only files that are there are remembered, so this holds no more names than the folders do.
  const seen = new Set<string>();
  let left = budget;
  let skipped = 0;
  return {
    read(text: string, spillDir: string): string | null {
      if (!text.includes(FOLDER)) return null;
      const found: string[] = [];
      for (const name of spilledNames(text)) {
        const path = join(spillDir, name);
        if (seen.has(path)) continue;
        const read = readRegular(path, left);
        if (read === null) continue;
        seen.add(path);
        if (read.kind === 'over') {
          // The first file that does not fit ends the reading: nothing after it is read.
          left = -1;
          skipped += 1;
          continue;
        }
        left -= read.bytes;
        found.push(read.text);
      }
      return found.length === 0 ? null : found.join('\n');
    },
    skipped: () => skipped,
  };
}
