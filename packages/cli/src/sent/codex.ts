/**
 * Reading a Codex CLI session, so `stroq sent` can answer for it.
 *
 * Codex writes one rollout per session to `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`,
 * one JSON envelope per line: `{timestamp, ordinal, type, payload}`. Three things in
 * that format will defeat a reader written from the Claude Code one, and all three
 * were measured on the 73 rollouts this was built against (24,638 records, 290 MB):
 *
 *  - **Pairing is by `call_id`.** A call and its output both carry an `id`, and the
 *    two `id`s are different. Matching on `id` yields a transcript with no results.
 *  - **The dominant call carries JavaScript, not arguments.** 2,650 records are
 *    `custom_tool_call`, whose `input` is a script — `const r = await
 *    tools.exec_command({cmd:"git status"})` — and 1,581 of the 3,131 named calls in
 *    the corpus are that shape. Only 438 are `function_call` with a JSON `arguments`
 *    string. A reader that expects JSON classifies 14% of the session.
 *  - **Outputs are content blocks.** `output` is an array of `{type,text}`, or
 *    occasionally a bare string.
 *
 * Tool names go through `codexToolName`, the same mapper the live Codex hook uses, so
 * a session read back off disk classifies the way it would have classified live. A
 * transcript path that disagreed with the hook would report findings against tools
 * the policy never judged.
 */
import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { codexToolName, commandOf, isPatchTool } from '../adapters/codex-input.js';
import {
  feedLines,
  type LineParser,
  type Transcript,
  type TranscriptEvent,
  type TranscriptFile,
} from '../replay/transcript.js';
import { readObjectLiteral } from './codex-literal.js';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** An output is an array of content blocks, or a plain string; both reduce to text. */
function outputText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .map((block) => {
      if (typeof block === 'string') return block;
      if (isRecord(block) && typeof block['text'] === 'string') return block['text'];
      return '';
    })
    .filter((t) => t.length > 0)
    .join('');
}

/** `tools.<name>(` — the only call form a rollout's script uses to reach a tool. */
const TOOL_CALL = /\btools\.([A-Za-z_$][\w$]*)\s*\(/g;

interface Invocation {
  readonly tool: string;
  readonly input: Record<string, unknown>;
}

/**
 * Every tool invocation in one script, in source order.
 *
 * The argument is read as a JS object literal, not as JSON: 82% of the literals in
 * the corpus are not valid JSON. When it cannot be read — a value that only exists
 * while the script runs, such as `{session_id:r.session_id}` — the script's source
 * text is kept under `raw` instead. That field is one the Codex adapter already
 * reads for both commands and patch bodies, and a scan of the arguments still sees
 * every character of it, so an unreadable literal costs structure and never content.
 */
function invocationsIn(script: string): Invocation[] {
  const found: Invocation[] = [];
  TOOL_CALL.lastIndex = 0;
  for (let m = TOOL_CALL.exec(script); m !== null; m = TOOL_CALL.exec(script)) {
    const afterParen = m.index + m[0].length;
    const brace = script.indexOf('{', afterParen - 1);
    /* Only a literal that opens immediately after the parenthesis is this call's
       argument; anything further along belongs to a later statement. */
    const literal = brace >= 0 && brace <= afterParen + 2 ? readObjectLiteral(script, brace) : null;
    const args = isRecord(literal?.value) ? { ...literal.value } : { raw: script };
    found.push({ tool: m[1] as string, input: args });
  }
  return found;
}

/**
 * The input the engine and the report see, given the tool this call maps to.
 *
 * A Bash call gets `command` alongside whatever the literal held, because that is
 * the field the classifier, the secret guard and `summarizeInput` all read, and
 * Codex spells it `cmd`. Nothing is removed: the original fields stay so a scan of
 * the arguments still sees them.
 */
function normalized(mapped: string, input: Record<string, unknown>) {
  if (mapped !== 'Bash' || typeof input['command'] === 'string') return input;
  const command = commandOf(input);
  return command === '' ? input : { ...input, command };
}

function eventsFor(
  callId: string,
  rawTool: string,
  rawInput: string,
  at: string,
): TranscriptEvent[] {
  /* A patch body is not a script: 44 records in the corpus carry `*** Begin Patch`
     directly in `input`, and running the script reader over one finds nothing. */
  const invocations = isPatchTool(rawTool)
    ? [{ tool: rawTool, input: { input: rawInput } }]
    : invocationsIn(rawInput);
  const list = invocations.length > 0 ? invocations : [{ tool: rawTool, input: { raw: rawInput } }];

  return list.map((inv, n) => {
    const tool = codexToolName(inv.tool);
    return {
      kind: 'pre',
      /* One script, several calls: the ids stay distinct so the output can attach to
         exactly one of them, and the first keeps the recorded `call_id` so the
         common single-call case reads as the rollout wrote it. */
      id: n === 0 ? callId : `${callId}#${n}`,
      tool,
      input: normalized(tool, inv.input),
      at,
    };
  });
}

interface Pending {
  readonly id: string;
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
}

/** Parses one Codex rollout into the events the hooks would have seen. */
export function parseCodexRollout(text: string): Transcript {
  const parser = createCodexParser();
  for (const line of text.split('\n')) parser.push(line);
  return parser.finish();
}

/** The same parser fed one line at a time; see `feedLines` for why. */
export function createCodexParser(): LineParser {
  const events: TranscriptEvent[] = [];
  /* Keyed by `call_id`. The value is the LAST call of the script, because a
     script's output is a single stream that cannot be divided between its calls;
     attaching it to the call the script ends with reports it once, under the tool
     that produced it, rather than duplicating the same text across every call. */
  const pending = new Map<string, Pending>();
  let sessionId = 'transcript';
  let cwd: string | null = null;
  let skipped = 0;

  function push(line: string): void {
    if (line.trim().length === 0) return;
    let envelope: unknown;
    try {
      envelope = JSON.parse(line);
    } catch {
      skipped += 1;
      return;
    }
    if (!isRecord(envelope)) {
      skipped += 1;
      return;
    }
    const at = typeof envelope['timestamp'] === 'string' ? envelope['timestamp'] : '';
    const payload = isRecord(envelope['payload']) ? envelope['payload'] : envelope;

    if (envelope['type'] === 'session_meta') {
      if (typeof payload['session_id'] === 'string') sessionId = payload['session_id'];
      if (typeof payload['cwd'] === 'string') cwd = payload['cwd'];
      return;
    }
    if (cwd === null && typeof payload['cwd'] === 'string') cwd = payload['cwd'];

    const kind = payload['type'];
    const callId = payload['call_id'];
    if (typeof callId !== 'string') return;

    if (kind === 'custom_tool_call' || kind === 'function_call') {
      const rawTool = typeof payload['name'] === 'string' ? payload['name'] : 'unknown';
      if (kind === 'function_call') {
        /* `arguments` is a JSON string here, and was valid JSON in all 438 records
           of the corpus — but a rollout is a file on disk, so a bad one is skipped
           rather than trusted. */
        let parsed: unknown = null;
        if (typeof payload['arguments'] === 'string') {
          try {
            parsed = JSON.parse(payload['arguments']);
          } catch {
            parsed = { raw: payload['arguments'] };
          }
        }
        const tool = codexToolName(rawTool);
        const input = isRecord(parsed) ? parsed : {};
        const event: TranscriptEvent = {
          kind: 'pre',
          id: callId,
          tool,
          input: normalized(tool, input),
          at,
        };
        events.push(event);
        pending.set(callId, { id: event.id, tool: event.tool, input: event.input });
        return;
      }
      const script = typeof payload['input'] === 'string' ? payload['input'] : '';
      const produced = eventsFor(callId, rawTool, script, at);
      events.push(...produced);
      const last = produced[produced.length - 1];
      if (last) pending.set(callId, { id: last.id, tool: last.tool, input: last.input });
      return;
    }

    if (kind === 'custom_tool_call_output' || kind === 'function_call_output') {
      const call = pending.get(callId);
      if (!call) return;
      events.push({
        kind: 'post',
        id: call.id,
        tool: call.tool,
        input: call.input,
        resultText: outputText(payload['output']),
        at,
      });
    }
  }

  return { push, finish: () => ({ sessionId, cwd, events, skipped }) };
}

export const codexRoot = (home = homedir()): string => join(home, '.codex', 'sessions');

/** How much of a rollout has to be read to learn which directory it ran in. */
const META_BYTES = 64 * 1024;

/**
 * The working directory a rollout recorded, read from its first line only.
 *
 * Codex files sessions by date rather than by project, so unlike Claude Code there
 * is no directory whose name answers this. Reading each rollout in full to find out
 * would mean 290 MB for one `stroq sent --last`, so only the head is read: the
 * `session_meta` record Codex writes first carries `cwd`.
 */
async function rolloutCwd(path: string): Promise<string | null> {
  let head: string;
  try {
    const handle = await open(path, 'r');
    try {
      const buffer = Buffer.alloc(META_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, META_BYTES, 0);
      head = buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
  const first = head.split('\n')[0];
  if (first === undefined || first.trim() === '') return null;
  try {
    const envelope: unknown = JSON.parse(first);
    if (!isRecord(envelope)) return null;
    const payload = isRecord(envelope['payload']) ? envelope['payload'] : envelope;
    return typeof payload['cwd'] === 'string' ? payload['cwd'] : null;
  } catch {
    return null;
  }
}

async function everyRollout(root: string): Promise<TranscriptFile[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
  const files: TranscriptFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.startsWith('rollout-') || !entry.name.endsWith('.jsonl')) continue;
    const path = join(entry.parentPath, entry.name);
    try {
      files.push({ path, mtimeMs: (await stat(path)).mtimeMs });
    } catch {
      // A rollout deleted between readdir and stat is simply not listed.
    }
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Rollouts for `cwd`, newest first, falling back to every session when this
 * directory has none — the same contract, and the same fallback, as the Claude Code
 * reader, so `--last` behaves identically whichever agent recorded the session.
 */
export async function findCodexRollouts(cwd: string, home?: string): Promise<TranscriptFile[]> {
  const all = await everyRollout(codexRoot(home));
  const here: TranscriptFile[] = [];
  for (const file of all) {
    if ((await rolloutCwd(file.path)) === cwd) here.push(file);
  }
  return here.length > 0 ? here : all;
}

export async function readCodexRollout(path: string): Promise<Transcript> {
  return feedLines(path, createCodexParser());
}
