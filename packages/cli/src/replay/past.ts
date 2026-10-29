// `stroq replay --all`: every recent agent session on this machine, replayed through the policy in
// force and summed up. A first look on the day Stroq is installed: what it would have denied or asked
// about before it was there, and which sessions are worth opening. It reads the agent's transcripts
// and judges each recorded call in a throwaway home; nothing runs, nothing is sent, and the user's
// real `~/.stroq` is not touched.
import { lstat } from 'node:fs/promises';
import type { AuditEntry } from '@stroq/core';
import type { Transcript, TranscriptFile } from './transcript.js';

/** The most sessions one look reads, newest first. */
export const MAX_SESSIONS = 300;
/** A transcript larger than this is counted and not read: replaying it would take minutes. */
export const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
const DAY_MS = 86_400_000;

export interface PastSession {
  readonly path: string;
  readonly sessionId: string;
  /** The folder the agent ran in, as the transcript records it. */
  readonly cwd: string | null;
  readonly first: string | null;
  readonly last: string | null;
  /** Tool calls judged. */
  readonly calls: number;
  readonly denied: number;
  readonly asked: number;
  /** Tool results whose text looked like an attack. */
  readonly suspect: number;
}

export interface PastReport {
  readonly days: number;
  /** The sessions read, most to look at first. */
  readonly sessions: readonly PastSession[];
  readonly skipped: {
    /** Older than the window. */
    readonly older: number;
    /** Past `MAX_SESSIONS`. */
    readonly overLimit: number;
    readonly tooLarge: number;
    /** Could not be read, or recorded no tool call. */
    readonly unreadable: number;
  };
}

export interface PastDependencies {
  readonly list: () => Promise<readonly TranscriptFile[]>;
  readonly read: (path: string) => Promise<Transcript>;
  readonly replay: (transcript: Transcript) => Promise<AuditEntry[]>;
  readonly now?: () => Date;
  /** The size of a transcript, or null for one that is not a regular file of its own (a link, a pipe). */
  readonly size?: (path: string) => Promise<number | null>;
}

/** A transcript is read only as a regular file: a link or a pipe named `.jsonl` could read forever. */
async function regularSize(path: string): Promise<number | null> {
  const info = await lstat(path);
  return info.isFile() ? info.size : null;
}

/** What one replayed session comes to. */
export function sessionOf(
  path: string,
  transcript: Transcript,
  entries: readonly AuditEntry[],
): PastSession {
  const mine = entries.filter((entry) => entry.sessionId === transcript.sessionId);
  const actions = mine.filter((entry) => entry.phase === 'pre');
  return {
    path,
    sessionId: transcript.sessionId,
    cwd: transcript.cwd,
    first: mine[0]?.ts ?? null,
    last: mine.at(-1)?.ts ?? null,
    calls: actions.length,
    denied: actions.filter((entry) => entry.decision?.effect === 'deny').length,
    asked: actions.filter((entry) => entry.decision?.effect === 'ask').length,
    suspect: mine.filter((entry) => entry.phase === 'post' && entry.scan?.verdict === 'suspect')
      .length,
  };
}

/** Most to look at first: denials, then questions, then results like an attack, then newest. */
const weight = (s: PastSession): number => s.denied * 1_000_000 + s.asked * 1_000 + s.suspect;

export async function readPastSessions(days: number, deps: PastDependencies): Promise<PastReport> {
  const now = (deps.now ?? (() => new Date()))();
  const size = deps.size ?? regularSize;
  const cutoff = now.getTime() - days * DAY_MS;
  const files = await deps.list();
  const recent = files.filter((file) => file.mtimeMs >= cutoff);
  const chosen = recent.slice(0, MAX_SESSIONS);
  const sessions: PastSession[] = [];
  let tooLarge = 0;
  let unreadable = 0;
  for (const file of chosen) {
    try {
      const bytes = await size(file.path);
      if (bytes === null) {
        unreadable += 1;
        continue;
      }
      if (bytes > MAX_TRANSCRIPT_BYTES) {
        tooLarge += 1;
        continue;
      }
      const transcript = await deps.read(file.path);
      if (transcript.events.length === 0) {
        unreadable += 1;
        continue;
      }
      sessions.push(sessionOf(file.path, transcript, await deps.replay(transcript)));
    } catch {
      unreadable += 1;
    }
  }
  sessions.sort((a, b) => weight(b) - weight(a) || (b.last ?? '').localeCompare(a.last ?? ''));
  return {
    days,
    sessions,
    skipped: {
      older: files.length - recent.length,
      overLimit: recent.length - chosen.length,
      tooLarge,
      unreadable,
    },
  };
}

const n = (value: number): string => value.toLocaleString('en-US');
const plural = (value: number, one: string, many: string): string =>
  `${n(value)} ${value === 1 ? one : many}`;

function counts(s: { denied: number; asked: number; suspect: number }): string | null {
  const parts = [
    s.denied > 0 ? `${n(s.denied)} would have been denied` : null,
    s.asked > 0 ? `${n(s.asked)} asked about` : null,
    s.suspect > 0
      ? plural(s.suspect, 'result looked like an attack', 'results looked like an attack')
      : null,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : parts.join(', ');
}

/** The report for a terminal: totals, then the sessions worth a look, each with how to open it. */
export function formatPast(report: PastReport, home: string): string {
  const shorten = (path: string): string =>
    home !== '' && path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
  const total = report.sessions.reduce(
    (sum, s) => ({
      calls: sum.calls + s.calls,
      denied: sum.denied + s.denied,
      asked: sum.asked + s.asked,
      suspect: sum.suspect + s.suspect,
    }),
    { calls: 0, denied: 0, asked: 0, suspect: 0 },
  );
  const lines = [
    `Replayed ${plural(report.sessions.length, 'agent session', 'agent sessions')} from the last ${plural(report.days, 'day', 'days')} (${plural(total.calls, 'tool call', 'tool calls')}) against the policy in force. Nothing ran and nothing was sent.`,
    counts(total) ??
      'Nothing would have been denied or asked about, and no result looked like an attack.',
  ];
  const notable = report.sessions.filter((s) => weight(s) > 0).slice(0, 10);
  if (notable.length > 0) {
    lines.push('', 'Sessions to look at, most first:');
    for (const s of notable) {
      const when = (s.last ?? s.first ?? '').slice(0, 16).replace('T', ' ');
      lines.push(`  ${when}  ${s.cwd === null ? '(folder not recorded)' : shorten(s.cwd)}`);
      lines.push(`    ${counts(s) ?? ''}`);
      lines.push(`    stroq replay --transcript ${shorten(s.path)}`);
    }
  }
  const { older, overLimit, tooLarge, unreadable } = report.skipped;
  const left = [
    overLimit > 0 ? `${n(overLimit)} past the newest ${n(MAX_SESSIONS)}` : null,
    tooLarge > 0 ? `${n(tooLarge)} too large to replay` : null,
    unreadable > 0 ? `${n(unreadable)} with no tool call that could be read` : null,
  ].filter((part): part is string => part !== null);
  if (left.length > 0) lines.push('', `Not read: ${left.join(', ')}.`);
  if (older > 0)
    lines.push(`${plural(older, 'older session is', 'older sessions are')} left out (use --days).`);
  lines.push(
    '',
    'A replay judges each recorded call with your policy and the rules of today. It cannot see what ran outside the agent, and it does not look for your secrets: `stroq sent` does.',
  );
  return lines.join('\n');
}
