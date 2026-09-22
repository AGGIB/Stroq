// Where a past session can be read from, per agent.
//
// `stroq sent` needs two things from an agent: a way to find its recorded sessions
// for a directory, and a way to turn one into the `Transcript` shape the scanner
// consumes. That is the whole contract, and it is small on purpose — adding Codex or
// Cursor later means one object here plus its parser, with nothing in the scanner or
// the formatter to change.
//
// Two readers are registered. Each was written against real sessions on a machine
// that runs that agent — Claude Code's 92 transcripts and Codex's 73 rollouts — and
// no reader is registered for a format nobody here has a session in, because a reader
// written blind is a claim of coverage nobody has tested. Cursor keeps its history in
// an undocumented SQLite blob and Windsurf leaves no local transcript at all, so
// neither can be verified from here yet.
import {
  findTranscripts,
  readTranscript,
  type Transcript,
  type TranscriptFile,
} from '../replay/transcript.js';
import { open } from 'node:fs/promises';
import { findCodexRollouts, readCodexRollout } from './codex.js';

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

export const READERS: readonly TranscriptReader[] = [claudeCodeReader, codexReader];

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
    const handle = await open(path, 'r');
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
 * Readers are asked in order and the newest across all of them wins. Both formats
 * are plain files whose mtime is the last time the agent wrote to the session, so the
 * comparison means the same thing on either side; a reader whose mtime meant
 * something else would have to be ranked some other way before it could join this.
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
