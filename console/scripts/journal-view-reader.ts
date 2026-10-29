import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_POLICY } from '../../packages/core/src/policy/default-policy.js';
import { ACTION_CLASSES, type ActionClass } from '../../packages/core/src/types.js';
import type { JournalRow, JournalTool } from '../lib/journal-view';

/**
 * Reads the newest part of the audit journal and projects each line into the safe row the console
 * shows. The file is `<home>/audit.jsonl`, a fixed name under a folder the server chose; nothing
 * from the browser picks a path. Hook processes append to this file while the console reads it, so
 * growth during a read is expected and tolerated; shrinking is not.
 */

export const WINDOW_BYTES = 1024 * 1024;
/** The writer allows an approval review of up to 64 KiB beside an operation of similar size, so a decision line can be this long. */
const MAX_LINE_BYTES = 256 * 1024;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const NONBLOCK = constants.O_NONBLOCK ?? 0;
const OWNER = typeof process.getuid === 'function' ? process.getuid() : null;
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const KNOWN_CLASSES = new Set<string>(ACTION_CLASSES);
const BUNDLED_RULES = new Set<string>(DEFAULT_POLICY.rules.map((rule) => rule.id));

export interface JournalLine {
  readonly seq: number;
  /** sha256 of the raw line, the same digest Investigations uses to name a finding. */
  readonly sha: string;
  /** Null for a line that is a record but not one the console shows (a clean result, a failure). */
  readonly row: JournalRow | null;
}

export interface JournalWindow {
  readonly state: 'ready' | 'missing' | 'refused';
  /** Readable records in file order, with strictly increasing sequence numbers. */
  readonly lines: readonly JournalLine[];
  /** True when the file is longer than the window, so older lines were not read. */
  readonly truncated: boolean;
  /** Lines that were not a readable record, or were out of order. */
  readonly unreadable: number;
}

const empty = (state: 'missing' | 'refused'): JournalWindow => ({
  state,
  lines: [],
  truncated: false,
  unreadable: 0,
});

const owned = (uid: number) => OWNER === null || uid === OWNER;
const private_ = (mode: number) => (mode & 0o022) === 0;

export function toolKind(name: unknown): JournalTool {
  if (typeof name !== 'string') return 'other';
  if (name.startsWith('mcp__')) return 'mcp';
  switch (name) {
    case 'Bash':
      return 'shell';
    case 'Read':
    case 'NotebookRead':
      return 'file-read';
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return 'file-write';
    case 'Glob':
    case 'Grep':
    case 'LS':
      return 'search';
    case 'WebFetch':
    case 'WebSearch':
      return 'web';
    case 'Task':
    case 'Agent':
      return 'task';
    default:
      return 'other';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function project(record: Record<string, unknown>, sha: string): JournalRow | null {
  // A pre decision, or a result that looked suspect. A failed call can still return text that looked
  // like an instruction, so a suspect result is kept whatever the outcome; other failed calls are not.
  const phase = record.phase;
  const decision = isRecord(record.decision) ? record.decision.effect : undefined;
  const scan = isRecord(record.scan) ? record.scan.verdict : undefined;
  const isPre =
    phase === 'pre' &&
    record.outcome === undefined &&
    (decision === 'allow' || decision === 'ask' || decision === 'deny');
  const isFlag = phase === 'post' && scan === 'suspect';
  if (!isPre && !isFlag) return null;
  const classes = Array.isArray(record.classes)
    ? [
        ...new Set(
          record.classes.filter(
            (c): c is ActionClass => typeof c === 'string' && KNOWN_CLASSES.has(c),
          ),
        ),
      ]
    : [];
  const ruleId = isRecord(record.decision) ? record.decision.ruleId : null;
  return {
    seq: record.seq as number,
    at: record.ts as string,
    phase: isPre ? 'pre' : 'post',
    decision: isPre ? (decision as 'allow' | 'ask' | 'deny') : null,
    scan: isFlag ? 'suspect' : null,
    tool: toolKind(record.tool),
    classes,
    // A bundled rule id is public; one from the person's own policy is their text, so it is not shown.
    ruleId: typeof ruleId === 'string' && BUNDLED_RULES.has(ruleId) ? ruleId : null,
    session: `session-${createHash('sha256').update(String(record.sessionId)).digest('hex').slice(0, 16)}`,
    evidenceSha: sha,
  };
}

function parseLine(text: string): JournalLine | null {
  if (Buffer.byteLength(text) > MAX_LINE_BYTES) return null;
  let record: unknown;
  try {
    record = JSON.parse(text);
  } catch {
    return null;
  }
  if (
    !isRecord(record) ||
    !Number.isSafeInteger(record.seq) ||
    (record.seq as number) < 1 ||
    typeof record.ts !== 'string' ||
    !STAMP.test(record.ts) ||
    (record.phase !== 'pre' && record.phase !== 'post') ||
    typeof record.sessionId !== 'string' ||
    record.sessionId.length > 512
  )
    return null;
  const sha = createHash('sha256').update(text).digest('hex');
  return { seq: record.seq as number, sha, row: project(record, sha) };
}

/** Reads the newest megabyte of `<home>/audit.jsonl`. Never writes, never follows a link. */
export async function readJournalWindow(home: string): Promise<JournalWindow> {
  const file = join(home, 'audit.jsonl');
  try {
    const folder = await lstat(home);
    if (!folder.isDirectory() || !owned(folder.uid) || !private_(folder.mode))
      return empty('refused');
    const before = await lstat(file);
    if (!before.isFile() || before.nlink !== 1 || !owned(before.uid) || !private_(before.mode))
      return empty('refused');
    const handle = await open(file, constants.O_RDONLY | NOFOLLOW | NONBLOCK);
    try {
      const opened = await handle.stat();
      if (opened.dev !== before.dev || opened.ino !== before.ino || !opened.isFile())
        return empty('refused');
      const size = opened.size;
      const start = Math.max(0, size - WINDOW_BYTES);
      // One byte before the window says whether the window begins on a line boundary.
      const begin = start > 0 ? start - 1 : 0;
      const buffer = Buffer.alloc(size - begin);
      let filled = 0;
      while (filled < buffer.length) {
        const { bytesRead } = await handle.read(
          buffer,
          filled,
          buffer.length - filled,
          begin + filled,
        );
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      // A hook can append while this runs, and that is fine. A file that got shorter was replaced.
      if (filled < buffer.length || (await handle.stat()).size < size) return empty('refused');
      let body = buffer.toString('utf8');
      if (start > 0) {
        // A window that begins in the middle of a line loses that line; one that begins on a boundary keeps it.
        const newline = body.indexOf('\n');
        body = body.startsWith('\n') ? body.slice(1) : newline < 0 ? '' : body.slice(newline + 1);
      }
      // The last line may be one a hook is still writing.
      const end = body.lastIndexOf('\n');
      body = end < 0 ? '' : body.slice(0, end);
      const lines: JournalLine[] = [];
      let unreadable = 0;
      let last = 0;
      for (const text of body.split('\n')) {
        if (text === '') continue;
        const parsed = parseLine(text);
        if (parsed === null || parsed.seq <= last) {
          unreadable += 1;
          continue;
        }
        last = parsed.seq;
        lines.push(parsed);
      }
      return { state: 'ready', lines, truncated: start > 0, unreadable };
    } finally {
      await handle.close();
    }
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
      ? empty('missing')
      : empty('refused');
  }
}
