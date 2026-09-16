// Reading a coding agent's own session transcript, so `stroq replay` can answer
// for sessions that happened BEFORE Stroq was installed.
//
// Claude Code writes every session to `~/.claude/projects/<slug>/<id>.jsonl`, and
// those records carry both halves of what the hooks would have seen: an assistant
// message's `tool_use` block is the call, and the matching user message's
// `tool_result` block is the output that came back. Replaying those through the
// engine reconstructs the same causal graph the live hooks would have produced.
//
// Nothing here writes to the user's real `~/.stroq`: the caller runs these events
// against a throwaway home, exactly as `stroq attack` does.
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface TranscriptPre {
  readonly kind: 'pre';
  readonly id: string;
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly at: string;
}

export interface TranscriptPost {
  readonly kind: 'post';
  readonly id: string;
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly resultText: string;
  readonly at: string;
}

export type TranscriptEvent = TranscriptPre | TranscriptPost;

export interface Transcript {
  readonly sessionId: string;
  readonly cwd: string | null;
  readonly events: readonly TranscriptEvent[];
  /** Lines that were not valid JSON. A partially written transcript is normal. */
  readonly skipped: number;
}

interface Block {
  readonly type?: unknown;
  readonly id?: unknown;
  readonly name?: unknown;
  readonly input?: unknown;
  readonly tool_use_id?: unknown;
  readonly content?: unknown;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A tool result is a plain string or a list of content blocks; both reduce to text. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => {
      if (typeof b === 'string') return b;
      if (isRecord(b) && typeof b['text'] === 'string') return b['text'];
      return '';
    })
    .filter((t) => t.length > 0)
    .join('\n');
}

function blocksOf(record: Record<string, unknown>): Block[] {
  const message = record['message'];
  if (!isRecord(message)) return [];
  const content = message['content'];
  return Array.isArray(content) ? content.filter(isRecord) : [];
}

/**
 * Parses a Claude Code transcript into the events the hooks would have seen.
 *
 * A `tool_use` becomes the `pre` event at the point the agent decided to call the
 * tool, and its `tool_result` becomes the `post` event where the output came back.
 * Keeping that order is what makes provenance work: an atom has to be recorded by
 * the read before the later action can be matched against it.
 */
export function parseTranscript(text: string): Transcript {
  const events: TranscriptEvent[] = [];
  const pending = new Map<string, { tool: string; input: Record<string, unknown> }>();
  let sessionId = 'transcript';
  let cwd: string | null = null;
  let skipped = 0;

  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      skipped += 1;
      continue;
    }
    if (!isRecord(record)) {
      skipped += 1;
      continue;
    }
    if (typeof record['sessionId'] === 'string') sessionId = record['sessionId'];
    if (cwd === null && typeof record['cwd'] === 'string') cwd = record['cwd'];
    const at = typeof record['timestamp'] === 'string' ? record['timestamp'] : '';

    for (const block of blocksOf(record)) {
      if (block.type === 'tool_use' && typeof block.id === 'string') {
        const tool = typeof block.name === 'string' ? block.name : 'unknown';
        const input = isRecord(block.input) ? block.input : {};
        pending.set(block.id, { tool, input });
        events.push({ kind: 'pre', id: block.id, tool, input, at });
        continue;
      }
      if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        const call = pending.get(block.tool_use_id);
        if (!call) continue;
        events.push({
          kind: 'post',
          id: block.tool_use_id,
          tool: call.tool,
          input: call.input,
          resultText: resultText(block.content),
          at,
        });
      }
    }
  }

  return { sessionId, cwd, events, skipped };
}

/** Claude Code's transcript directory for a working directory, by its own slug rule. */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[/.]/g, '-');
}

export const transcriptRoot = (): string => join(homedir(), '.claude', 'projects');

export interface TranscriptFile {
  readonly path: string;
  readonly mtimeMs: number;
}

/**
 * Transcripts for `cwd`, newest first. Falls back to every project when this
 * directory has none, so `--last` still finds something to show.
 */
export async function findTranscripts(cwd: string): Promise<TranscriptFile[]> {
  const root = transcriptRoot();
  const scoped = join(root, projectSlug(cwd));
  const found = (await listJsonl(scoped)) ?? [];
  if (found.length > 0) return found.sort((a, b) => b.mtimeMs - a.mtimeMs);

  let dirs: string[];
  try {
    dirs = (await readdir(root, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => join(root, d.name));
  } catch {
    return [];
  }
  const all: TranscriptFile[] = [];
  for (const dir of dirs) all.push(...((await listJsonl(dir)) ?? []));
  return all.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

async function listJsonl(dir: string): Promise<TranscriptFile[] | null> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  const files: TranscriptFile[] = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const path = join(dir, name);
    try {
      files.push({ path, mtimeMs: (await stat(path)).mtimeMs });
    } catch {
      // A transcript deleted between readdir and stat is simply not listed.
    }
  }
  return files;
}

export async function readTranscript(path: string): Promise<Transcript> {
  return parseTranscript(await readFile(path, 'utf8'));
}
