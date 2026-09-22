// Where a past session can be read from, per agent.
//
// `stroq sent` needs two things from an agent: a way to find its recorded sessions
// for a directory, and a way to turn one into the `Transcript` shape the scanner
// consumes. That is the whole contract, and it is small on purpose — adding Codex or
// Cursor later means one object here plus its parser, with nothing in the scanner or
// the formatter to change.
//
// Three readers are registered. Each was written against real sessions on a machine
// that runs that agent — Claude Code's 92 transcripts, Codex's 73 rollouts, Cursor's
// 9 sessions and 1,126 tool calls — and no reader is registered for a format nobody
// here has a session in, because a reader written blind is a claim of coverage nobody
// has tested. That still rules out two: Copilot CLI leaves only logs (no
// `session-state`, nothing of the conversation), and Antigravity keeps its
// trajectories as base64-wrapped protobuf in a VS Code state database, with no
// transcript on disk to read.
import {
  findTranscripts,
  readTranscript,
  type Transcript,
  type TranscriptFile,
} from '../replay/transcript.js';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { findCodexRollouts, readCodexRollout } from './codex.js';
import {
  cursorStateDb,
  cursorUnavailable,
  findCursorSessions,
  readCursorSession,
  splitCursorSessionPath,
} from './cursor.js';

/** Enough of a transcript to hold its first record, whichever agent wrote it. */
const HEAD_BYTES = 64 * 1024;

export interface TranscriptReader {
  /** The agent's name as the report prints it. */
  readonly agent: string;
  /** Recorded sessions for `cwd`, newest first; empty when this agent leaves none. */
  find(cwd: string): Promise<readonly TranscriptFile[]>;
  read(path: string): Promise<Transcript>;
  /** Whether this reader wrote the file whose first line is `head`. */
  claims(head: string): boolean;
  /** Where this reader looks, for the message printed when it finds nothing. */
  readonly root: string;
  /**
   * Why this reader could not look at all, or null when it could. A reader that is
   * skipped must never be mistaken for one that looked and found nothing — that is
   * the same confusion `readerForFile` exists to prevent on the other side of the
   * command.
   */
  unavailable?(): Promise<string | null>;
}

export const claudeCodeReader: TranscriptReader = {
  agent: 'claude-code',
  find: findTranscripts,
  read: readTranscript,
  root: '~/.claude/projects',
  /* A Claude record is the message itself: `{type:'user'|'assistant', message:{…}}`,
     with `sessionId` on nearly every line. A Codex record is an envelope around a
     payload and has neither. */
  claims: (head) => {
    const record: unknown = tryParse(head);
    if (!isRecord(record)) return false;
    return 'message' in record || 'sessionId' in record;
  },
};

/**
 * Codex files sessions by date rather than by project, so `find` reads the head of
 * each rollout to learn which directory it ran in. See `codex.ts` for why only the
 * head: reading them in full is 290 MB on the machine this was measured on.
 */
export const codexReader: TranscriptReader = {
  agent: 'codex',
  find: (cwd) => findCodexRollouts(cwd),
  read: readCodexRollout,
  root: '~/.codex/sessions',
  /* Codex wraps every record: `{timestamp, ordinal, type, payload}`. The envelope
     is the format, so its presence is the test. */
  claims: (head) => {
    const record: unknown = tryParse(head);
    return isRecord(record) && isRecord(record['payload']) && typeof record['type'] === 'string';
  },
};

/**
 * Cursor keeps no transcript files: its sessions are rows in one SQLite store, so a
 * path here is `<store>#<session>` rather than a filename. See `cursor.ts` for what
 * the store does and does not record.
 */
export const cursorReader: TranscriptReader = {
  agent: 'cursor',
  find: (cwd) => findCursorSessions(cwd),
  read: readCursorSession,
  root: tilde(cursorStateDb()),
  unavailable: cursorUnavailable,
  /* A SQLite file announces itself in its first 16 bytes, and that is all the
     dispatch needs: no other agent here writes one. */
  claims: (head) => head.startsWith('SQLite format 3'),
};

export const READERS: readonly TranscriptReader[] = [claudeCodeReader, codexReader, cursorReader];

/** Every reason a registered reader could not look, in registration order. */
export async function readerNotices(): Promise<readonly string[]> {
  const notices: string[] = [];
  for (const reader of READERS) {
    const why = await reader.unavailable?.();
    if (why !== undefined && why !== null) notices.push(why);
  }
  return notices;
}

/**
 * A path with the home directory written as `~`, the way the other two readers
 * spell theirs. Cursor's store is found per platform rather than named as a
 * constant, and the message that prints it should not carry the user's username.
 */
function tilde(path: string): string {
  const home = homedir();
  return home !== '' && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function tryParse(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/** Every place a registered reader looks, for a message that has found nothing. */
export const READER_ROOTS = (): string => READERS.map((r) => r.root).join(' or ');

/**
 * The reader for a file named on the command line, chosen by what is IN it.
 *
 * Not by its path: a transcript handed to `--transcript` may have been copied
 * anywhere, and a Codex rollout parsed as a Claude one produces a transcript with
 * no events at all — a silent "nothing found" that reads exactly like a clean
 * session. Claude Code is the fallback because it is the older format and the one
 * an unrecognised file is most likely to be.
 */
export async function readerForFile(path: string): Promise<TranscriptReader> {
  let head = '';
  try {
    // A Cursor session is addressed as `<store>#<session>`, and only the store half
    // is a file. Sniffing the literal string would fail to open and fall back to the
    // Claude reader, which then reports the store as an empty session.
    const handle = await open(splitCursorSessionPath(path).db, 'r');
    try {
      const buffer = Buffer.alloc(HEAD_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
      head = buffer.subarray(0, bytesRead).toString('utf8').split('\n')[0] ?? '';
    } finally {
      await handle.close();
    }
  } catch {
    return claudeCodeReader;
  }
  return READERS.find((reader) => reader.claims(head)) ?? claudeCodeReader;
}

export interface FoundTranscript {
  readonly reader: TranscriptReader;
  readonly path: string;
}

/**
 * The most recently modified transcript any registered reader can find for `cwd`.
 *
 * Readers are asked in order and the newest across all of them wins. For the two
 * file formats that is the file's mtime; Cursor has no file, so its reader reports
 * the newest moment recorded inside the session. Both are the last time the agent
 * wrote to that session, which is what makes them comparable — a reader whose number
 * meant something else would have to be ranked some other way before it could join
 * this.
 */
export async function newestTranscript(cwd: string): Promise<FoundTranscript | null> {
  let best: (FoundTranscript & { mtimeMs: number }) | null = null;
  for (const reader of READERS) {
    const newest = (await reader.find(cwd))[0];
    if (!newest) continue;
    if (best === null || newest.mtimeMs > best.mtimeMs) {
      best = { reader, path: newest.path, mtimeMs: newest.mtimeMs };
    }
  }
  return best === null ? null : { reader: best.reader, path: best.path };
}
