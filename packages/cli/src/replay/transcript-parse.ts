// Parsing one Claude Code transcript file into the events the hooks would have seen.
//
// Claude Code writes every session to `~/.claude/projects/<slug>/<id>.jsonl`, and those
// records carry both halves of what the hooks would have seen: an assistant message's
// `tool_use` block is the call, and the matching user message's `tool_result` block is
// the output that came back. Replaying those through the engine reconstructs the same
// causal graph the live hooks would have produced.
//
// Besides the calls, a record can hold the user's prompt and the assistant's reply. They
// are kept apart from the events (as `texts`), because they are not tool calls: replay
// judges calls, and `stroq sent` also wants to know when a key was pasted into a prompt.
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { spillReader, type SpillReader } from './spilled.js';

export interface TranscriptPre {
  readonly kind: 'pre';
  readonly id: string;
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly at: string;
  /** The subagent that made the call, when a subagent did. */
  readonly subagent?: string;
  /**
   * For `stroq sent` only: the text of a Codex script outside the arguments its tool calls were
   * read from. Set by the rollout reader on a script's first call, never read from a record, so no
   * session text can set it or take it out of what is read.
   */
  readonly scriptRest?: string;
  /**
   * For `stroq sent` only: a record of a kind the reader does not know, handed on whole because it
   * may be a call. Set by a reader, never read from a record.
   */
  readonly unknownRecord?: true;
}

export interface TranscriptPost {
  readonly kind: 'post';
  readonly id: string;
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly resultText: string;
  readonly at: string;
  /** The result came back marked as an error: the call failed, or was refused or blocked. */
  readonly isError?: boolean;
  /** Part of the result was read from the file Claude Code saved a large output to. */
  readonly spilled?: boolean;
  readonly subagent?: string;
}

export type TranscriptEvent = TranscriptPre | TranscriptPost;

/** A prompt the user sent, or text the assistant wrote: not a tool call. */
export interface TranscriptText {
  readonly kind: 'text';
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly at: string;
  readonly subagent?: string;
}

export interface Transcript {
  readonly sessionId: string;
  readonly cwd: string | null;
  readonly events: readonly TranscriptEvent[];
  /** Prompt and reply text, in order. Absent for a reader that does not read it. */
  readonly texts?: readonly TranscriptText[];
  /** Lines that were not valid JSON. A partially written transcript is normal. */
  readonly skipped: number;
}

/** Where a parser hands what it reads, one item at a time, instead of keeping it. */
export interface TranscriptSink {
  event(event: TranscriptEvent): void;
  text(text: TranscriptText): void;
}

export interface ParserOptions {
  /** Stream to this instead of collecting: `finish()` then returns no events or texts. */
  readonly sink?: TranscriptSink;
  /** The label for every line of this file, when the file is one subagent's transcript. */
  readonly subagent?: string;
  /** The session's `tool-results` folder, where outputs too large for the transcript were saved. */
  readonly spillDir?: string;
  /**
   * What reads those saved outputs, shared by every file of a scan so that each saved file is read
   * once and all of them come out of one byte budget. Without one, this parser has its own.
   */
  readonly spill?: SpillReader;
}

/**
 * A parser fed one line at a time.
 *
 * It exists because `readFile(path, 'utf8')` cannot read every transcript: V8 caps a string
 * at 536,870,888 characters, and a long session goes past that. On the machine this was
 * written on, four transcripts are over 200 MB and the largest is 1.3 GB.
 */
export interface LineParser {
  push(line: string): void;
  finish(): Transcript;
}

interface Block {
  readonly type?: unknown;
  readonly id?: unknown;
  readonly name?: unknown;
  readonly input?: unknown;
  readonly tool_use_id?: unknown;
  readonly content?: unknown;
  readonly is_error?: unknown;
  readonly text?: unknown;
  readonly thinking?: unknown;
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

function messageOf(record: Record<string, unknown>): Record<string, unknown> | null {
  const message = record['message'];
  return isRecord(message) ? message : null;
}

function blocksOf(message: Record<string, unknown> | null): Block[] {
  const content = message?.['content'];
  return Array.isArray(content) ? content.filter(isRecord) : [];
}

/** Who wrote a record's text: the assistant, or the user (a prompt, or a command's output). */
function roleOf(record: Record<string, unknown>, message: Record<string, unknown> | null) {
  const role = message?.['role'] ?? record['type'];
  return role === 'assistant' ? 'assistant' : role === 'user' ? 'user' : null;
}

/** The subagent a record belongs to: its own `agentId` on a side chain, else the file's label. */
function subagentOf(record: Record<string, unknown>, fileLabel: string | undefined) {
  const id = record['agentId'];
  if (record['isSidechain'] === true && typeof id === 'string' && id !== '') return id;
  return fileLabel;
}

/** The text in a block, for the blocks that hold prose: `text` and `thinking`. */
function blockProse(block: Block): string | null {
  if (block.type === 'text' && typeof block.text === 'string') return block.text;
  if (block.type === 'thinking' && typeof block.thinking === 'string') return block.thinking;
  return null;
}

/**
 * Parses a Claude Code transcript into the events the hooks would have seen.
 *
 * A `tool_use` becomes the `pre` event at the point the agent decided to call the tool,
 * and its `tool_result` becomes the `post` event where the output came back. Keeping that
 * order is what makes provenance work: an atom has to be recorded by the read before the
 * later action can be matched against it.
 */
export function parseTranscript(text: string, options: ParserOptions = {}): Transcript {
  const parser = createTranscriptParser(options);
  for (const line of text.split('\n')) parser.push(line);
  return parser.finish();
}

export function createTranscriptParser(options: ParserOptions = {}): LineParser {
  const events: TranscriptEvent[] = [];
  const texts: TranscriptText[] = [];
  const sink: TranscriptSink = options.sink ?? {
    event: (e) => events.push(e),
    text: (t) => texts.push(t),
  };
  const pending = new Map<string, { tool: string; input: Record<string, unknown> }>();
  const spillDir = options.spillDir;
  const spill = spillDir === undefined ? null : (options.spill ?? spillReader());
  let sessionId = 'transcript';
  let cwd: string | null = null;
  let skipped = 0;

  function onBlock(block: Block, at: string, role: 'user' | 'assistant' | null, label?: string) {
    const tag = label === undefined ? {} : { subagent: label };
    if (block.type === 'tool_use' && typeof block.id === 'string') {
      const tool = typeof block.name === 'string' ? block.name : 'unknown';
      const input = isRecord(block.input) ? block.input : {};
      pending.set(block.id, { tool, input });
      sink.event({ kind: 'pre', id: block.id, tool, input, at, ...tag });
      return;
    }
    if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
      const call = pending.get(block.tool_use_id);
      if (!call) return;
      const shown = resultText(block.content);
      const saved = spill === null || spillDir === undefined ? null : spill.read(shown, spillDir);
      // Streaming: a result arrives once, so the call's input need not be kept after it.
      if (options.sink !== undefined) pending.delete(block.tool_use_id);
      sink.event({
        kind: 'post',
        id: block.tool_use_id,
        tool: call.tool,
        input: call.input,
        resultText: saved === null ? shown : `${shown}\n${saved}`,
        at,
        ...(block.is_error === true ? { isError: true } : {}),
        ...(saved === null ? {} : { spilled: true }),
        ...tag,
      });
      return;
    }
    const prose = blockProse(block);
    if (prose !== null && prose !== '' && role !== null)
      sink.text({ kind: 'text', role, text: prose, at, ...tag });
  }

  function push(line: string): void {
    if (line.trim().length === 0) return;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      skipped += 1;
      return;
    }
    if (!isRecord(record)) {
      skipped += 1;
      return;
    }
    if (typeof record['sessionId'] === 'string') sessionId = record['sessionId'];
    if (cwd === null && typeof record['cwd'] === 'string') cwd = record['cwd'];
    const at = typeof record['timestamp'] === 'string' ? record['timestamp'] : '';
    const message = messageOf(record);
    const role = roleOf(record, message);
    const label = subagentOf(record, options.subagent);
    const content = message?.['content'];
    // A prompt is often a bare string rather than a list of blocks.
    if (typeof content === 'string' && content !== '' && role !== null) {
      sink.text({
        kind: 'text',
        role,
        text: content,
        at,
        ...(label === undefined ? {} : { subagent: label }),
      });
      return;
    }
    for (const block of blocksOf(message)) onBlock(block, at, role, label);
  }

  return { push, finish: () => ({ sessionId, cwd, events, texts, skipped }) };
}

/**
 * Feeds a JSONL file to a line parser without ever holding it as one string.
 *
 * `crlfDelay: Infinity` so a transcript written on Windows is split on `\r\n` rather than
 * leaving a `\r` on the end of every line, which would not break `JSON.parse` but would
 * survive into a recorded value.
 */
export async function feedLines(path: string, parser: LineParser): Promise<Transcript> {
  const lines = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of lines) parser.push(line);
  } finally {
    lines.close();
  }
  return parser.finish();
}
