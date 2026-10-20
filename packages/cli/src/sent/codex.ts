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
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { codexToolName, commandOf, isPatchTool } from '../adapters/codex-input.js';
import {
  directoryAndParents,
  feedLines,
  samePath,
  type LineParser,
  type SessionList,
  type Transcript,
  type TranscriptEvent,
  type TranscriptFile,
  type TranscriptSink,
} from '../replay/transcript.js';
import { readObjectLiteral } from './codex-literal.js';
import { firstLine } from './head.js';

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
  /** Where the literal read as its argument starts and ends, when one was read. */
  readonly span?: readonly [number, number];
}

/** A script with the spans of the literals read as tool arguments taken out. */
function restOf(script: string, invocations: readonly Invocation[]): string {
  const parts: string[] = [];
  let from = 0;
  for (const { span } of invocations) {
    if (span === undefined || span[0] < from) continue;
    parts.push(script.slice(from, span[0]));
    from = span[1];
  }
  parts.push(script.slice(from));
  return parts.join(' ');
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
function invocationsIn(script: string, segments = false): Invocation[] {
  const found: Invocation[] = [];
  const starts: number[] = [];
  TOOL_CALL.lastIndex = 0;
  for (let m = TOOL_CALL.exec(script); m !== null; m = TOOL_CALL.exec(script)) {
    const afterParen = m.index + m[0].length;
    /* Only a literal that opens immediately after the parenthesis is this call's
       argument; anything further along belongs to a later statement. Looked for in
       those few characters only: a search to the end for every call would read the
       script once per call. */
    let brace = -1;
    for (let at = afterParen - 1; at <= afterParen + 2 && at < script.length; at += 1)
      if (script[at] === '{') {
        brace = at;
        break;
      }
    const literal = brace >= 0 ? readObjectLiteral(script, brace) : null;
    starts.push(m.index);
    if (literal !== null && isRecord(literal.value))
      found.push({ tool: m[1] as string, input: { ...literal.value }, span: [brace, literal.end] });
    else found.push({ tool: m[1] as string, input: { raw: script } });
  }
  if (!segments) return found;
  /* For `stroq sent`, which reads the script outside the calls on its own (`scriptRest`), a
     call whose argument could not be read keeps its own part of the script, from where it is
     called to the next call, not all of it: every such call holding the whole script read it
     once per call. */
  return found.map((inv, n) =>
    inv.span !== undefined
      ? inv
      : { ...inv, input: { raw: script.slice(starts[n] ?? 0, starts[n + 1] ?? script.length) } },
  );
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
  keepScript: boolean,
): TranscriptEvent[] {
  /* A patch body is not a script: 44 records in the corpus carry `*** Begin Patch`
     directly in `input`, and running the script reader over one finds nothing. */
  const patch = isPatchTool(rawTool);
  const invocations: readonly Invocation[] = patch
    ? [{ tool: rawTool, input: { input: rawInput } }]
    : invocationsIn(rawInput, keepScript);
  const list: readonly Invocation[] =
    invocations.length > 0 ? invocations : [{ tool: rawTool, input: { raw: rawInput } }];
  const rest = keepScript && !patch ? restOf(rawInput, invocations) : '';

  return list.map((inv, n) => {
    const tool = codexToolName(inv.tool);
    const input = normalized(tool, inv.input);
    return {
      kind: 'pre',
      /* One script, several calls: the ids stay distinct so the output can attach to
         exactly one of them, and the first keeps the recorded `call_id` so the
         common single-call case reads as the rollout wrote it. */
      id: n === 0 ? callId : `${callId}#${n}`,
      tool,
      input,
      at,
      // The script outside its read calls, beside the input and not in it: the input is what the
      // script wrote, and a field of its own there would be read, or hidden, as this one.
      ...(n === 0 && rest.trim() !== '' ? { scriptRest: rest } : {}),
    };
  });
}

interface Pending {
  readonly id: string;
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
}

/** Response items read as a call, a call's output or text, by the reader below. */
const CALL_ITEMS: ReadonlySet<string> = new Set([
  'function_call',
  'custom_tool_call',
  'local_shell_call',
  'function_call_output',
  'custom_tool_call_output',
]);

/** The text of a message or a reasoning summary: its content blocks, and a plain string. */
function blocksText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .map((block) => (isRecord(block) && typeof block['text'] === 'string' ? block['text'] : ''))
    .filter((t) => t !== '')
    .join('\n');
}

/** The output fields of a command Codex ran, as its `exec_command_end` event records them. */
const EXEC_OUTPUT = ['stdout', 'stderr', 'aggregated_output', 'formatted_output'] as const;

/**
 * For `stroq sent`: what an `event_msg` record echoes. A prompt, the AI's reply or its reasoning is
 * text; a command's output is the output of that call. Any other kind is read as nothing, so a key
 * in it is in a record no reader read, and maybe sent (`analyze.ts`).
 */
function eventMessage(
  kind: string,
  payload: Record<string, unknown>,
  at: string,
  sink: TranscriptSink,
): void {
  const str = (field: string): string =>
    typeof payload[field] === 'string' ? (payload[field] as string) : '';
  if (kind === 'user_message' || kind === 'agent_message') {
    const text = str('message');
    const role = kind === 'user_message' ? 'user' : 'assistant';
    if (text !== '') sink.text({ kind: 'text', role, text, at });
  } else if (kind === 'agent_reasoning' || kind === 'agent_reasoning_raw_content') {
    const text = str('text');
    if (text !== '') sink.text({ kind: 'text', role: 'assistant', text, at });
  } else if (kind === 'exec_command_end' && str('call_id') !== '') {
    const resultText = EXEC_OUTPUT.map(str)
      .filter((t) => t !== '')
      .join('\n');
    if (resultText !== '')
      sink.event({ kind: 'post', id: str('call_id'), tool: 'Bash', input: {}, resultText, at });
  }
}

/**
 * For `stroq sent`: a record that is not a tool call or its output, handed to the sink. A message
 * and a reasoning summary are text the user or the AI wrote, a compacted history is the AI's, and
 * a web search sent its query to a search engine. A response item of a kind not read here may be a
 * call: it is handed on whole, marked as one no reader knows, so a key in it is maybe sent. True
 * when the record was one of these.
 */
function otherRecord(
  envelope: Record<string, unknown>,
  payload: Record<string, unknown>,
  at: string,
  sink: TranscriptSink,
): boolean {
  const kind = typeof payload['type'] === 'string' ? payload['type'] : '';
  if (envelope['type'] === 'event_msg') {
    eventMessage(kind, payload, at, sink);
    return true;
  }
  if (envelope['type'] === 'compacted') {
    const text = typeof payload['message'] === 'string' ? payload['message'] : '';
    if (text !== '') sink.text({ kind: 'text', role: 'assistant', text, at });
    return true;
  }
  // A rollout from before the envelope was added holds the item itself.
  const item = envelope['type'] === 'response_item' || envelope === payload;
  if (!item || CALL_ITEMS.has(kind)) return false;
  if (kind === 'message' || kind === 'reasoning') {
    // What the user, Codex or a developer instruction said to the AI is a message sent to it.
    const role = kind === 'reasoning' || payload['role'] === 'assistant' ? 'assistant' : 'user';
    const text = [blocksText(payload['content']), blocksText(payload['summary'])]
      .filter((t) => t !== '')
      .join('\n');
    if (text !== '') sink.text({ kind: 'text', role, text, at });
    return true;
  }
  const id = typeof payload['call_id'] === 'string' ? payload['call_id'] : `${kind}@${at}`;
  if (kind === 'web_search_call') {
    const action = isRecord(payload['action']) ? payload['action'] : {};
    sink.event({ kind: 'pre', id, tool: 'WebSearch', input: action, at });
    return true;
  }
  sink.event({ kind: 'pre', id, tool: kind || 'unknown', input: payload, at, unknownRecord: true });
  return true;
}

/**
 * Whether a call item has the shape this reader reads: a shell call's `action` an object, a
 * function call's `arguments` a string, a custom call's `input` a string, and an output one whose
 * call was read. Anything else would be read as nothing, and a key in it lost.
 */
function readable(kind: string, payload: Record<string, unknown>, paired: boolean): boolean {
  switch (kind) {
    case 'local_shell_call':
      return isRecord(payload['action']);
    case 'function_call':
      return typeof payload['arguments'] === 'string';
    case 'custom_tool_call':
      return typeof payload['input'] === 'string';
    default:
      return paired;
  }
}

/** Parses one Codex rollout into the events the hooks would have seen. */
export function parseCodexRollout(text: string): Transcript {
  const parser = createCodexParser();
  for (const line of text.split('\n')) parser.push(line);
  return parser.finish();
}

/**
 * The same parser fed one line at a time; see `feedLines` for why. With a `sink`, events are
 * handed over as they are read and not kept.
 */
export function createCodexParser(
  options: {
    readonly sink?: TranscriptSink;
    /** `stroq sent`: give a script's first event the script outside its read calls (`scriptRest`). */
    readonly keepScript?: boolean;
  } = {},
): LineParser {
  const events: TranscriptEvent[] = [];
  const emit = (event: TranscriptEvent): void => {
    if (options.sink === undefined) events.push(event);
    else options.sink.event(event);
  };
  /* Keyed by `call_id`. The value is the LAST call of the script, because a
     script's output is a single stream that cannot be divided between its calls;
     attaching it to the call the script ends with reports it once, under the tool
     that produced it, rather than duplicating the same text across every call. */
  const pending = new Map<string, Pending>();
  let sessionId = 'transcript';
  let cwd: string | null = null;
  let skipped = 0;
  /** Call items with neither a `call_id` nor an `id`, named in turn. */
  let unnamed = 0;

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
    if (options.sink !== undefined && otherRecord(envelope, payload, at, options.sink)) return;
    if (typeof kind !== 'string' || !CALL_ITEMS.has(kind)) return;
    // A call item without a `call_id` is still a call: by its `id`, or by a name of its own.
    const callId =
      typeof payload['call_id'] === 'string'
        ? payload['call_id']
        : typeof payload['id'] === 'string'
          ? payload['id']
          : `${kind}@${at}#${(unnamed += 1)}`;
    // For `stroq sent`, a call item whose shape is not read here, or an output no call was read
    // for, is handed on whole as a record no reader knows: a key in it is at least maybe sent.
    if (options.sink !== undefined && !readable(kind, payload, pending.has(callId))) {
      options.sink.event({
        kind: 'pre',
        id: callId,
        tool: kind,
        input: payload,
        at,
        unknownRecord: true,
      });
      return;
    }

    if (kind === 'local_shell_call') {
      /* A shell call the model made through Codex's own shell tool: its argv is in `action`. */
      const action = isRecord(payload['action']) ? payload['action'] : {};
      const event: TranscriptEvent = {
        kind: 'pre',
        id: callId,
        tool: 'Bash',
        input: normalized('Bash', { ...action }),
        at,
      };
      emit(event);
      pending.set(callId, { id: event.id, tool: event.tool, input: event.input });
      return;
    }

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
        emit(event);
        pending.set(callId, { id: event.id, tool: event.tool, input: event.input });
        return;
      }
      const script = typeof payload['input'] === 'string' ? payload['input'] : '';
      const produced = eventsFor(callId, rawTool, script, at, options.keepScript === true);
      produced.forEach(emit);
      const last = produced[produced.length - 1];
      if (last) pending.set(callId, { id: last.id, tool: last.tool, input: last.input });
      return;
    }

    if (kind === 'custom_tool_call_output' || kind === 'function_call_output') {
      const call = pending.get(callId);
      if (!call) return;
      if (options.sink !== undefined) pending.delete(callId);
      emit({
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

/** What a rollout's first record says about it: the folder it ran in, and when it started. */
export interface RolloutMeta {
  readonly cwd: string | null;
  readonly at: string | null;
}

/**
 * The working directory a rollout recorded, read from its first line only.
 *
 * Codex files sessions by date rather than by project, so unlike Claude Code there
 * is no directory whose name answers this. Reading each rollout in full to find out
 * would mean 290 MB for one `stroq sent --last`, so only the head is read: the
 * `session_meta` record Codex writes first carries `cwd`.
 */
async function rolloutCwd(path: string): Promise<string | null> {
  return (await rolloutMeta(path)).cwd;
}

/** `rolloutCwd`, and the time on the same first record. */
export async function rolloutMeta(path: string): Promise<RolloutMeta> {
  const none: RolloutMeta = { cwd: null, at: null };
  // The first line whole, however long: `session_meta` carries the instructions Codex was given.
  const first = await firstLine(path);
  if (first === null || first.trim() === '') return none;
  try {
    const envelope: unknown = JSON.parse(first);
    if (!isRecord(envelope)) return none;
    const payload = isRecord(envelope['payload']) ? envelope['payload'] : envelope;
    const stamp = envelope['timestamp'] ?? payload['timestamp'];
    return {
      cwd: typeof payload['cwd'] === 'string' ? payload['cwd'] : null,
      at: typeof stamp === 'string' ? stamp : null,
    };
  } catch {
    return none;
  }
}

/** Every rollout under `root`, newest first. */
export async function everyRollout(root: string): Promise<TranscriptFile[]> {
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
  return [...(await findCodexRolloutsScoped(cwd, home)).files];
}

/** Whether a recorded working directory is `dir`, however the two are spelled. */
const sameFolder = (recorded: string | null, dir: string): boolean =>
  recorded !== null && samePath(resolve(recorded), dir);

/** `findCodexRollouts`, and whether the list is this directory's own; see `SessionList`. */
export async function findCodexRolloutsScoped(cwd: string, home?: string): Promise<SessionList> {
  const all = await everyRollout(codexRoot(home));
  const recorded = new Map<TranscriptFile, string | null>();
  for (const file of all) recorded.set(file, await rolloutCwd(file.path));
  // This directory's own rollouts, else those of the nearest folder above it that has any:
  // the same reading of "the project's session" as the Claude reader's.
  for (const [depth, dir] of directoryAndParents(cwd).entries()) {
    const here = all.filter((file) => sameFolder(recorded.get(file) ?? null, dir));
    if (here.length > 0) return { files: here, scoped: true, depth };
  }
  return { files: all, scoped: false, depth: 0 };
}

export async function readCodexRollout(path: string): Promise<Transcript> {
  return feedLines(path, createCodexParser());
}
