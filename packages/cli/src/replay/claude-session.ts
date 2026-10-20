// One Claude Code session is more than its `<id>.jsonl`.
//
// Beside the main transcript, Claude Code keeps a folder named after the session:
//
//   <slug>/<id>.jsonl                       the main transcript
//   <slug>/<id>/subagents/agent-<a>.jsonl   each subagent's own transcript
//   <slug>/<id>/tool-results/<name>         outputs too large for a transcript
//
// A subagent's calls carry the parent's session id, so the live hooks already judge them
// as the parent session's. Reading only `<id>.jsonl` skipped them: on two real sessions on
// the machine this was written on, 81% and 49% of the tool calls ran inside subagents.
import { readdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { spillReader } from './spilled.js';
import {
  createTranscriptParser,
  feedLines,
  type ParserOptions,
  type Transcript,
  type TranscriptEvent,
  type TranscriptText,
} from './transcript-parse.js';

/** One subagent transcript of a session, and the label its lines are given. */
export interface SubagentFile {
  readonly path: string;
  readonly label: string;
}

/** The files of one session. */
export interface SessionFiles {
  readonly main: string;
  readonly subagents: readonly SubagentFile[];
  /** Where outputs too large for the transcript were saved. It may not exist. */
  readonly spillDir: string;
}

const SUBAGENTS = 'subagents';

/** `agent-a1b2c3.jsonl` → `a1b2c3`: the label of a subagent file whose lines name no agent. */
function labelOf(file: string): string {
  const stem = basename(file, '.jsonl');
  return stem.startsWith('agent-') ? stem.slice('agent-'.length) : stem;
}

/**
 * The files of the session whose main transcript is `path`. A path that is itself a subagent's
 * transcript is read alone, with its parent's `tool-results` folder.
 */
export async function sessionFiles(path: string): Promise<SessionFiles> {
  const dir = dirname(path);
  if (basename(dir) === SUBAGENTS) {
    return { main: path, subagents: [], spillDir: join(dirname(dir), 'tool-results') };
  }
  const sessionDir = join(dir, basename(path, '.jsonl'));
  let names: string[] = [];
  try {
    names = await readdir(join(sessionDir, SUBAGENTS));
  } catch {
    // No subagent ran in this session, or the folder cannot be read: the main file is the session.
  }
  const subagents = names
    .filter((name) => name.endsWith('.jsonl'))
    .sort()
    .map((name) => ({ path: join(sessionDir, SUBAGENTS, name), label: labelOf(name) }));
  return { main: path, subagents, spillDir: join(sessionDir, 'tool-results') };
}

/** One file of the session, parsed with its label and the session's `tool-results` folder. */
export function readSessionFile(path: string, options: ParserOptions): Promise<Transcript> {
  return feedLines(path, createTranscriptParser(options));
}

/**
 * Items of several files in one list, in time order. A stamp that will not parse takes the
 * time of the item before it in the same file, so it stays where its file put it; ties keep
 * the order of the files and of the lines.
 */
function byTime<T extends { readonly at: string }>(lists: readonly (readonly T[])[]): T[] {
  const keyed: { readonly item: T; readonly time: number }[] = [];
  for (const list of lists) {
    let time = Number.NEGATIVE_INFINITY;
    for (const item of list) {
      const parsed = Date.parse(item.at);
      if (!Number.isNaN(parsed)) time = parsed;
      keyed.push({ item, time });
    }
  }
  return keyed.sort((a, b) => a.time - b.time || 0).map((k) => k.item);
}

/**
 * The whole session: the main transcript and every subagent transcript, merged in time order,
 * with saved large outputs read back into the results that name them.
 */
export async function readClaudeSession(path: string): Promise<Transcript> {
  const files = await sessionFiles(path);
  // One reader for every file of the session: a saved output is read once, out of one budget.
  const spill = spillReader();
  const main = await readSessionFile(files.main, { spillDir: files.spillDir, spill });
  if (files.subagents.length === 0) return main;
  const subs: Transcript[] = [];
  for (const sub of files.subagents) {
    subs.push(
      await readSessionFile(sub.path, { spillDir: files.spillDir, spill, subagent: sub.label }),
    );
  }
  const all = [main, ...subs];
  return {
    sessionId: main.sessionId,
    cwd: main.cwd ?? subs.find((s) => s.cwd !== null)?.cwd ?? null,
    events: byTime<TranscriptEvent>(all.map((t) => t.events)),
    texts: byTime<TranscriptText>(all.map((t) => t.texts ?? [])),
    skipped: all.reduce((sum, t) => sum + t.skipped, 0),
  };
}
