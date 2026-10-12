// The files of a tree as text, for the inspectors that read text.
//
// Only a file that is UTF-8 text is read; a file with a NUL in it, or bytes that are not UTF-8, is
// skipped and counted, because a regular expression over bytes that are not text finds what is not
// there and misses what is. A file longer than the cap is read in part: the cap is what keeps the
// work an inspector does on one file from depending on how big the author made it. Both are blind
// spots, said by count.
import type { Tree } from '../types.js';
import { READ_CAP_BYTES } from './blind-spots.js';
import type { Findings } from './findings.js';

export interface TextFile {
  /** The path in the tree. */
  readonly path: string;
  /** The text, without a byte order mark; at most the first `READ_CAP_BYTES` bytes of the file. */
  readonly text: string;
  readonly exec: boolean;
  /** The size of the whole file, in bytes. */
  readonly size: number;
  /** True when the file is longer than what was read. */
  readonly truncated: boolean;
  readonly lines: LineIndex;
}

/** The number of the line a place in a text is on, found by bisection over the starts of the lines. */
export class LineIndex {
  private starts: number[] | null = null;

  constructor(private readonly text: string) {}

  private build(): number[] {
    if (this.starts !== null) return this.starts;
    const starts = [0];
    for (let at = this.text.indexOf('\n'); at !== -1; at = this.text.indexOf('\n', at + 1)) {
      starts.push(at + 1);
    }
    this.starts = starts;
    return starts;
  }

  /** The line (from 1) that the character at `index` is on. A place outside the text is on its first or last line. */
  lineAt(index: number): number {
    const starts = this.build();
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if ((starts[middle] ?? 0) <= index) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  }
}

/** The text of `bytes`, or null if they are not UTF-8. A cut that falls inside a character is not a fault. */
function decode(bytes: Uint8Array, cut: boolean): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: cut });
  } catch {
    return null;
  }
}

/**
 * Every regular file of the tree that is text, in the order of the tree. The tree is the one a
 * reader made with `complete: true`; a file without its bytes is counted as unread.
 */
export function loadTexts(tree: Tree, findings: Findings): TextFile[] {
  const files: TextFile[] = [];
  for (const entry of tree.entries) {
    if (entry.kind !== 'file') continue;
    const bytes = entry.bytes;
    const cut = bytes !== undefined && bytes.byteLength > READ_CAP_BYTES;
    const head = bytes === undefined || !cut ? bytes : bytes.subarray(0, READ_CAP_BYTES);
    const text = head === undefined || head.includes(0) ? null : decode(head, cut);
    if (text === null) {
      findings.tally('unreadable-text');
      continue;
    }
    if (cut) findings.tally('partial-file');
    files.push({
      path: entry.path,
      text,
      exec: entry.exec,
      size: entry.size,
      truncated: cut,
      lines: new LineIndex(text),
    });
  }
  return files;
}
