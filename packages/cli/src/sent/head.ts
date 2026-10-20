// The first records of a session file, read only as far as they are needed.
//
// The folder a session ran in and when it started are in its first records. A first record can
// be long: a first prompt can be a pasted log, and a Codex `session_meta` carries the
// instructions it was given. So the file is read a piece at a time, line by line, until the
// caller has what it wants, the file ends, or `HEAD_LIMIT` bytes have been read.
import { StringDecoder } from 'node:string_decoder';
import { openRegularHandle } from './regular-file.js';

/** How far into a file its first records are looked for. */
export const HEAD_LIMIT = 4 * 1024 * 1024;
/** How much is read at a time. */
const PIECE = 64 * 1024;

/**
 * Hands the lines at the start of a file to `visit`, in order, until it returns true, the file
 * ends, or `limit` bytes have been read. A line still open at `limit` is not handed over.
 * Returns false when the file could not be read.
 */
export async function headLines(
  path: string,
  visit: (line: string) => boolean,
  limit = HEAD_LIMIT,
): Promise<boolean> {
  // A FIFO or a device where a session file should be is refused, never waited on.
  const handle = await openRegularHandle(path);
  if (handle === null) return false;
  try {
    const decoder = new StringDecoder('utf8');
    const buffer = Buffer.alloc(PIECE);
    // The line read so far, in pieces: joined once, when its end is found.
    let pending: string[] = [];
    let position = 0;
    while (position < limit) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(PIECE, limit - position),
        position,
      );
      if (bytesRead === 0) {
        const last = pending.join('') + decoder.end();
        if (last.trim() !== '') visit(last);
        return true;
      }
      position += bytesRead;
      const text = decoder.write(buffer.subarray(0, bytesRead));
      let from = 0;
      for (let end = text.indexOf('\n'); end >= 0; end = text.indexOf('\n', from)) {
        const line = pending.join('') + text.slice(from, end);
        pending = [];
        from = end + 1;
        if (visit(line)) return true;
      }
      pending.push(text.slice(from));
    }
    return true;
  } catch {
    return false;
  } finally {
    await handle.close();
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Hands each JSON record at the start of a file to `visit`, as `headLines` does lines. A line
 * that is not a JSON object is passed over.
 */
export function headRecords(
  path: string,
  visit: (record: Record<string, unknown>) => boolean,
  limit = HEAD_LIMIT,
): Promise<boolean> {
  return headLines(
    path,
    (line) => {
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        return false;
      }
      return isRecord(record) && visit(record);
    },
    limit,
  );
}

/** The first line of a file, read as far as `limit`, or null when it cannot be read. */
export async function firstLine(path: string, limit = HEAD_LIMIT): Promise<string | null> {
  const found: { line: string } = { line: '' };
  const readable = await headLines(
    path,
    (line) => {
      found.line = line;
      return true;
    },
    limit,
  );
  return readable ? found.line : null;
}
