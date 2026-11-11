import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { MAX_TRANSCRIPT_BYTES } from '../replay/past.js';
import { cursorChangesPending, cursorUnavailable, readStoreWindow } from '../sent/cursor.js';
import { cursorSessionRefs } from '../sent/sessions.js';
import type { WindowSession } from './window.js';

const MAX_ROWS = 30_000;
const MAX_LIST_MS = 2_000;

/** Only complete snapshots can be split into sessions. Never cache a partially listed session. */
export async function listCursorWindow(
  db: string,
  cutoff: number,
  stopAt: number,
): Promise<{ readonly sessions: WindowSession[]; readonly older: number; readonly note?: string }> {
  const empty = { sessions: [], older: 0 };
  try {
    const file = lstatSync(db);
    if (!file.isFile()) return { ...empty, note: 'Cursor’s session store is not a regular file.' };
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT'
      ? empty
      : { ...empty, note: 'Cursor’s session store could not be read.' };
  }
  const why = await cursorUnavailable();
  if (why !== null) return { ...empty, note: why };
  const deadline = Math.min(stopAt, Date.now() + MAX_LIST_MS);
  // The budget is for the rows of the sessions in the window, not for the whole history (#311).
  const read = await readStoreWindow(db, cutoff, {
    stopAt: deadline,
    maxRows: MAX_ROWS,
    maxBytes: MAX_TRANSCRIPT_BYTES,
  });
  if (read === null) return { ...empty, note: 'Cursor’s session store could not be read in full.' };

  const refs = cursorSessionRefs(db, read.rows);
  const sessions: WindowSession[] = [];
  for (const ref of refs) {
    if (Date.now() >= deadline)
      return { ...empty, note: 'Cursor’s session store could not be read in time.' };
    if (ref.mtimeMs < cutoff) continue;
    // Dates come from the rows themselves. A bubble can change without changing its date or size.
    const { transcript, rows } = ref.cursor;
    const hash = createHash('sha256').update(JSON.stringify(transcript.events.map((e) => e.id)));
    let bytes = 0;
    for (const row of rows) {
      const size = Buffer.byteLength(row);
      bytes += size;
      hash.update(`${size}:`).update(row);
    }
    sessions.push({
      agent: 'cursor',
      path: ref.path,
      cwd: ref.cwd,
      mtimeMs: ref.mtimeMs,
      bytes,
      cursorStamp: hash.digest('hex'),
      ref,
    });
  }
  if (Date.now() >= deadline)
    return { ...empty, note: 'Cursor’s session store could not be read in time.' };
  return {
    sessions,
    older: read.sessions - sessions.length,
    ...(cursorChangesPending(db)
      ? { note: 'Cursor has recent changes still waiting to be saved to its session store.' }
      : {}),
  };
}
