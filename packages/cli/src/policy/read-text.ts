import { readRegularFile } from '@stroq/core';

/** Why a file given on the command line could not be read at all. */
export type Unreadable = 'missing' | 'not-a-file' | 'too-large' | 'unreadable';

const MISSING_CODES = new Set(['ENOENT', 'ENOTDIR']);
const NOT_A_FILE_CODES = new Set(['EISDIR']);

function unreadableBecause(err: unknown): Unreadable {
  const code = (err as NodeJS.ErrnoException | undefined)?.code ?? '';
  if (MISSING_CODES.has(code)) return 'missing';
  if (NOT_A_FILE_CODES.has(code)) return 'not-a-file';
  return 'unreadable';
}

/**
 * The text of a regular file of at most `maxBytes`, or why there is none. One handle is opened,
 * checked (a regular file, not too big) and read, so a path swapped for a pipe or a link to
 * `/dev/zero` in between cannot make this wait or read without end, and there is no look at the path
 * before the open for something to change after.
 */
export function readBoundedText(
  path: string,
  maxBytes: number,
): { text: string } | { why: Unreadable } {
  try {
    const read = readRegularFile(path, maxBytes);
    if (read.kind === 'text') return { text: read.text };
    return { why: read.kind === 'too-large' ? 'too-large' : 'not-a-file' };
  } catch (err) {
    return { why: unreadableBecause(err) };
  }
}
