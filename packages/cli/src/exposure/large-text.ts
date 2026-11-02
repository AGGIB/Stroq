import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import type { AgentHit } from './agent-kinds.js';
import { HiddenScan } from './agent-text.js';

/**
 * A file too large to read whole, scanned for the characters nobody reading it would see (the
 * check of `hiddenTextHit`) in pieces of a megabyte, all of it, up to a cap. The pieces are cut in
 * bytes and decoded as a stream, so one may end inside a character; the scan keeps a few characters
 * between pieces, and nothing more of the text, so the memory it takes does not grow with the file.
 *
 * What a skill keeps as data may be much larger than an agent's config (a font index of a
 * megabyte). A file past the cap, one that is not a file, or one that cannot be read is not
 * scanned, and the caller treats it as unread.
 */

/** The most bytes of one file that are scanned. */
export const LARGE_SCAN_CAP = 32 * 1024 * 1024;
/** The bytes read at a time. */
const PIECE = 1024 * 1024;
/**
 * The hidden characters counted before the scan stops: a file that holds this many fails whatever
 * the rest holds, and a file of them (32 MiB of zero-width spaces) would otherwise be walked
 * character by character. The counts are those of the first ones, whatever the pieces.
 */
const LIMIT = 10_000;

export type LargeScan =
  { readonly kind: 'clean' } | { readonly kind: 'hidden'; readonly hit: AgentHit };

/**
 * The scan of the file at `path`, whose finding (if any) is named `rel`: clean, or the finding for
 * what it hides; undefined when it was not scanned. A file that grows past the cap while it is read
 * is not scanned either.
 */
export function scanLargeFile(
  path: string,
  rel: string,
  cap: number = LARGE_SCAN_CAP,
  piece: number = PIECE,
): LargeScan | undefined {
  let fd: number | undefined;
  try {
    // `O_NONBLOCK` so that opening a FIFO returns at once; it is then refused as not a file.
    fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    const stats = fstatSync(fd);
    if (!stats.isFile() || stats.size > cap) return undefined;
    const buffer = Buffer.alloc(piece);
    const decoder = new StringDecoder('utf8');
    const scan = new HiddenScan(LIMIT);
    for (let at = 0; !scan.full;) {
      const read = readSync(fd, buffer, 0, piece, at);
      if (read === 0) break;
      at += read;
      if (at > cap) return undefined;
      scan.feed(decoder.write(buffer.subarray(0, read)));
    }
    if (!scan.full) scan.feed(decoder.end());
    const hit = scan.finish(rel);
    return hit === undefined ? { kind: 'clean' } : { kind: 'hidden', hit };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
