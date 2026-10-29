import {
  DEFAULT_MAX_CHARS,
  collectStringsDeep,
  describeEvidence,
  describeSecretHit,
  mcpIdentityFromEncodedTool,
  toEvidence,
  taintSource,
  warningFor,
  type Atom,
  type AtomKind,
  type ProvenanceHit,
  type SecretHit,
  type StroqEngine,
} from '@stroq/core';
import { z } from 'zod';
import { logError } from '../log.js';

export const ClaudeHookInputSchema = z.looseObject({
  session_id: z
    .string()
    .min(1)
    .max(256)
    .refine((text) => Buffer.byteLength(text) <= 256),
  tool_use_id: z
    .string()
    .min(1)
    .max(256)
    .refine((text) => Buffer.byteLength(text) <= 256)
    .optional(),
  hook_event_name: z.enum(['PreToolUse', 'PostToolUse', 'PostToolUseFailure']),
  tool_name: z
    .string()
    .min(1)
    .max(256)
    .refine((text) => Buffer.byteLength(text) <= 256),
  tool_input: z.record(z.string(), z.unknown()).default({}),
  cwd: z.string().default(''),
  tool_result: z.unknown().optional(),
  // Real Claude Code (v2.1.226) sends the tool output as `tool_response`;
  // `tool_result` is kept as a fallback for other agents/older payloads.
  tool_response: z.unknown().optional(),
  // A tool that FAILED reports through its own event, `PostToolUseFailure`, and its
  // output is `error` (a string in Claude Code 2.1.271's schema). What a failing
  // command printed is as much content the model reads as a success's, and a hostile
  // page or package can decide what it says.
  error: z.unknown().optional(),
});
export type ClaudeHookInput = z.infer<typeof ClaudeHookInputSchema>;
/** The shape a recorded event has before parsing (defaults still optional); used by `stroq attack` scenarios. */
export type ClaudeHookEvent = z.input<typeof ClaudeHookInputSchema>;

export const HIGH_IMPACT_TOOL =
  /^(Bash|PowerShell|Monitor|Write|Edit|MultiEdit|NotebookEdit|WebFetch|mcp__)/;
// The engine reads a result of exactly this length as possibly cut short here, so every place
// that clips a result clips at the one number (`DEFAULT_MAX_CHARS`, which the scan reads to).
const MAX_RESULT_CHARS = DEFAULT_MAX_CHARS;

export interface HookOutput {
  readonly stdout: string;
  /**
   * Written by `stroq hook` before it exits. Only the Codex adapter sets it: exit
   * code 2 with the reason on stderr is the one block Codex honours without
   * parsing stdout, which is exactly what a fail-closed answer needs. Optional and
   * additive — the Claude Code and Cursor adapters never set it.
   */
  readonly stderr?: string;
  readonly exitCode: number;
  /**
   * Set only by the watchdog in `runHook`. The answer is complete and safe to print,
   * but the work behind it is still running and may hold the event loop open, so the
   * command layer flushes and exits rather than waiting for a process that has
   * already said what it had to say.
   */
  readonly timedOut?: boolean;
}

export const NO_OUTPUT: HookOutput = { stdout: '', exitCode: 0 };

const clip = (s: string): string => s.slice(0, MAX_RESULT_CHARS);

const MAX_EVIDENCE = 2;

/**
 * Appends up to MAX_EVIDENCE sentences to a hook reason. Secrets come first: when a
 * secret value is in the arguments it IS the reason for the denial, and the two-sentence
 * budget must not be spent on provenance before it is mentioned.
 */
export function withEvidence(
  reason: string,
  hits: readonly ProvenanceHit[],
  now: Date = new Date(),
  secrets: readonly SecretHit[] = [],
): string {
  const sentences = [
    ...secrets.map(describeSecretHit),
    ...hits.map((hit) => describeEvidence(toEvidence(hit), now)),
  ].slice(0, MAX_EVIDENCE);
  if (sentences.length === 0) return reason;
  return `${reason} Evidence: ${sentences.join(' ')}`;
}

// Only the kinds that can fire an `origin.*` class on their own. URLs and hosts
// count for network-shaped actions only, so reporting them here would tell the
// auto-mode classifier about a page of ordinary documentation links.
const COUNTED_KINDS: readonly AtomKind[] = ['pkg', 'pipe_shell', 'encoded'];

export function countAtoms(atoms: readonly Atom[]): Partial<Record<AtomKind, number>> {
  return atoms
    .filter((atom) => COUNTED_KINDS.includes(atom.kind))
    .reduce<Partial<Record<AtomKind, number>>>(
      (acc, atom) => ({ ...acc, [atom.kind]: (acc[atom.kind] ?? 0) + 1 }),
      {},
    );
}

function postOutput(
  fields: Readonly<Record<string, unknown>>,
  event: 'PostToolUse' | 'PostToolUseFailure' = 'PostToolUse',
): HookOutput {
  return {
    stdout: JSON.stringify({
      hookSpecificOutput: { hookEventName: event, ...fields },
    }),
    exitCode: 0,
  };
}

/** Read/Write responses nest the file body under `file.content`. */
function fileContentOf(obj: Record<string, unknown>): string | null {
  const file = obj['file'];
  if (!file || typeof file !== 'object') return null;
  const content = (file as Record<string, unknown>)['content'];
  return typeof content === 'string' ? content : null;
}

/** Bash responses carry `stdout`/`stderr` instead of a single text field. */
function streamsOf(obj: Record<string, unknown>): string | null {
  const parts = [obj['stdout'], obj['stderr']].filter(
    (p): p is string => typeof p === 'string' && p.length > 0,
  );
  if (typeof obj['stdout'] !== 'string' && typeof obj['stderr'] !== 'string') return null;
  return parts.join('\n');
}

/** The text of a tool result, and whether it had to be serialised because it held none. */
export interface ResultReading {
  readonly text: string;
  readonly serialised: boolean;
}

const plain = (value: string): ResultReading => ({ text: value, serialised: false });

const MEDIA_KINDS: ReadonlySet<unknown> = new Set(['image', 'audio', 'video']);
/** How deep a result is looked into for media; a result nested deeper keeps what it holds. */
const MEDIA_SCAN_DEPTH = 32;
/** How many levels of items and lists are looked into for the shapes of a result, before the rest is read flat. */
const MAX_READ_DEPTH = 64;
/** How many characters of strings are collected from a value: twice what is kept, so that the clip is the reader's. */
const STRING_ROOM = MAX_RESULT_CHARS * 2;

/** The keys that hold the bytes of media, in the media object and in the objects inside it. */
const PAYLOAD_KEYS: ReadonlySet<string> = new Set(['base64', 'data', 'bytes']);

/**
 * `value` without the bytes of its media: in an object whose `type` is an image, audio or video,
 * and in the objects inside it, the keys that hold the payload (`base64`, `data`, `bytes`) are
 * dropped, and a `base64` field is dropped wherever it is. What a screenshot returns is its bytes
 * in base64 (hundreds of thousands of characters for a large one). It is not text anything is copied
 * from, and it would otherwise be read as text, scanned, and, past the clip, make the session look
 * as if a result had been cut short. Every other string beside them stays: a caption, a
 * description, a title or a transcript is text the model reads, and is where a page can put what it
 * wants said.
 */
function withoutMedia(value: unknown, depth = 0, inMedia = false): unknown {
  if (depth > MEDIA_SCAN_DEPTH || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => withoutMedia(item, depth + 1, inMedia));
  const record = value as Record<string, unknown>;
  const kind = record['type'];
  const media = inMedia || (typeof kind === 'string' && MEDIA_KINDS.has(kind));
  return Object.fromEntries(
    Object.entries(record)
      .filter(([key]) => key !== 'base64' && !(media && PAYLOAD_KEYS.has(key)))
      .map(([key, item]) => [key, withoutMedia(item, depth + 1, media)]),
  );
}

/** The most of the serialised form that is added after the text, and the longest string in it. */
const JSON_FORM_CHARS = 32_768;
const JSON_FORM_STRING_CHARS = 2_000;

/** `value` serialised, its long strings cut (their text is read in full beside it), and the whole kept short. */
const jsonForm = (value: unknown): string => {
  try {
    return (
      JSON.stringify(value, (_key, item: unknown) =>
        typeof item === 'string' && item.length > JSON_FORM_STRING_CHARS
          ? item.slice(0, JSON_FORM_STRING_CHARS)
          : item,
      ) ?? ''
    ).slice(0, JSON_FORM_CHARS);
  } catch {
    // Too deep to serialise: the strings in it have been read, which is what this is a copy of.
    return '';
  }
};

/**
 * What the shapes of a result that are known read, each in its own way: the `text` of a text item,
 * the `content` of a file, the streams of a command, the items of a `content` list. Every one that
 * is there is read, and not only the first, in that order. `consumed` is the keys they read, which
 * the rest of the object is read without.
 */
interface KnownReading {
  readonly pieces: string[];
  /** The keys of the object a known shape read whole. */
  readonly consumed: ReadonlySet<string>;
  /** The rest of a file object after its content, which is read like any other sibling. */
  readonly fileRest: Readonly<Record<string, unknown>> | null;
  /** The text of the pieces is no text: a list of items that held none, and had to be serialised. */
  readonly serialised: boolean;
}

function knownReading(
  obj: Record<string, unknown>,
  requestPath: string | undefined,
  depth: number,
): KnownReading {
  const pieces: string[] = [];
  const consumed = new Set<string>();
  let fileRest: Record<string, unknown> | null = null;
  let serialised = false;
  if (typeof obj['text'] === 'string') {
    pieces.push(obj['text']);
    consumed.add('text');
  }
  const file = fileContentOf(obj);
  if (file !== null) {
    pieces.push(file);
    const { content: _content, ...rest } = obj['file'] as Record<string, unknown>;
    fileRest = rest;
  }
  const streams = streamsOf(obj);
  if (streams !== null) {
    pieces.push(streams);
    // Only a stream that was a string was read; any other is a sibling to read like the rest.
    for (const stream of ['stdout', 'stderr'])
      if (typeof obj[stream] === 'string') consumed.add(stream);
  }
  if (Array.isArray(obj['content'])) {
    const items = toolResultReading(obj['content'], requestPath, depth + 1);
    pieces.push(items.text);
    consumed.add('content');
    serialised = items.serialised;
  }
  return { pieces, consumed, fileRest, serialised };
}

/** What `type` is when it only labels the kind of item an object is. */
const TYPE_LABELS: ReadonlySet<string> = new Set([
  'text',
  'image',
  'audio',
  'video',
  'resource',
  'resource_link',
  'file',
  'tool_use',
  'tool_result',
]);

/** The keys of a file object that can only echo the path of the file that was asked for. */
const FILE_ECHO_KEYS: ReadonlySet<string> = new Set(['filePath', 'path']);
/** The longest a string can be and still be a path to leave out of the text. */
const MAX_ECHOED_PATH = 4096;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Whether the value of a file object's `filePath` or `path` only echoes the path that was asked
 * for, and so says nothing a person did not already write: it is that very path, or, when the
 * request's path is not known, it is a single string of a plausible length with no blank and no
 * control character in it. Anything else (a sentence, a string with line breaks, a value that is
 * not a string at all) is text like the rest, and is read: a file result is where a hostile page
 * can put what it wants said, and the path is a field it controls.
 */
function echoesPath(value: unknown, requestPath: string | undefined): boolean {
  if (typeof value !== 'string') return false;
  if (requestPath !== undefined && value === requestPath) return true;
  return value.length <= MAX_ECHOED_PATH && !/\s/.test(value) && !CONTROL_CHARS.test(value);
}

/** A `type` whose value is one of the labels, which says what an item is and is not text anyone wrote. */
const isTypeLabel = (key: string, value: unknown): boolean =>
  key === 'type' && typeof value === 'string' && TYPE_LABELS.has(value);

/**
 * The string values of the object that no known shape read: the keys it did not read whole, and
 * what a file object holds beside its content (a note, another key). A `type` that is one of the
 * labels is left out; any other `type` is text like the rest. The bytes of media are left out.
 */
function otherStrings(
  obj: Record<string, unknown>,
  known: KnownReading,
  requestPath: string | undefined,
): string[] {
  const siblings = Object.entries(obj).filter(
    ([key, value]) => !known.consumed.has(key) && key !== 'file' && !isTypeLabel(key, value),
  );
  const inFile = Object.entries(known.fileRest ?? {}).filter(
    ([key, value]) => !(FILE_ECHO_KEYS.has(key) && echoesPath(value, requestPath)),
  );
  const unread =
    known.fileRest === null ? Object.entries(obj).filter(([key]) => key === 'file') : [];
  return [...siblings, ...inFile, ...unread]
    .flatMap(([, value]) => collectStringsDeep(withoutMedia(value), STRING_ROOM))
    .filter((value) => value !== '');
}

/** The strings, one to a line, and then the serialised object as far as the clip leaves room. */
function stringsAndJson(strings: readonly string[], readable: unknown): ResultReading {
  const joined = strings.join('\n');
  const room = MAX_RESULT_CHARS - 1 - joined.length - 1;
  return plain(room > 0 ? `${joined}\n${jsonForm(readable).slice(0, room)}` : joined);
}

/**
 * An object, read as every string in it. The shapes that are known read what they hold in their
 * own way (see `knownReading`); the rest of the object, whatever a sibling of them holds
 * (`structuredContent` beside `content`, a note beside a file), is read as its string values. When
 * the object is none of the known shapes, all of its strings are its text. Whenever strings were
 * read that a known shape did not own, the serialised object follows them: about a hundred rules
 * are written for JSON syntax (a key, a colon, a value), and a web fetch's result
 * (`{bytes, code, codeText, result, durationMs, url}`) has no shape of its own and read only
 * serialised turned every line break in the page into the two characters backslash and `n`. An
 * object with no string at all is serialised alone, and said to be.
 */
function objectReading(
  obj: Record<string, unknown>,
  requestPath: string | undefined,
  depth: number,
): ResultReading {
  const known = knownReading(obj, requestPath, depth);
  if (known.pieces.length === 0) {
    const readable = withoutMedia(obj);
    const strings = collectStringsDeep(readable, STRING_ROOM).filter((value) => value !== '');
    if (strings.length === 0) return { text: jsonForm(readable), serialised: true };
    return stringsAndJson(strings, readable);
  }
  const primary = known.pieces.filter((piece) => piece !== '');
  const others = otherStrings(obj, known, requestPath);
  if (others.length === 0) return { text: primary.join('\n'), serialised: known.serialised };
  return stringsAndJson([...primary, ...others], withoutMedia(obj));
}

export function toolResultReading(result: unknown, requestPath?: string, depth = 0): ResultReading {
  if (typeof result === 'string') return plain(clip(result));
  // Past this the shapes are not looked for: whatever strings are down there are read, flat.
  if (depth > MAX_READ_DEPTH && result !== null && typeof result === 'object')
    return plain(clip(collectStringsDeep(result, STRING_ROOM).join('\n')));
  if (Array.isArray(result)) {
    const parts = result.map((item) => toolResultReading(item, requestPath, depth + 1));
    return {
      text: clip(parts.map((part) => part.text).join('\n')),
      serialised: parts.some((part) => part.serialised),
    };
  }
  if (result && typeof result === 'object') {
    const reading = objectReading(result as Record<string, unknown>, requestPath, depth);
    return { ...reading, text: clip(reading.text) };
  }
  return plain(result === undefined || result === null ? '' : String(result));
}

export function toolResultToText(result: unknown, requestPath?: string): string {
  return toolResultReading(result, requestPath).text;
}

/** Tools whose output is prose: a result of one that held no text is not a result Stroq has read. */
const PROSE_TOOL = /^(WebFetch|WebSearch|Grep)$/;

function preOutput(decision: 'deny' | 'ask', reason: string): HookOutput {
  return {
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision,
        permissionDecisionReason: reason,
      },
    }),
    exitCode: 0,
  };
}

export const denyOutput = (reason: string): HookOutput => preOutput('deny', reason);
export const askOutput = (reason: string): HookOutput => preOutput('ask', reason);

/**
 * The reading of a result, which does not throw. A result that cannot be read (it is not what the
 * reader looks at, or reading it fails) is posted with nothing to scan and as unread, so that the
 * session is marked incomplete and a package no record accounts for is asked about: the engine is
 * given every result, whatever the reading of it came to.
 */
function safeReading(
  response: unknown,
  requestPath: string | undefined,
): ResultReading & { readonly failed?: true } {
  try {
    return toolResultReading(response, requestPath);
  } catch (err) {
    logError('result', err);
    return { text: '', serialised: false, failed: true };
  }
}

/** The path a tool call asked for, which a result may echo back. */
function requestedPath(toolInput: Readonly<Record<string, unknown>>): string | undefined {
  for (const key of ['file_path', 'notebook_path', 'path']) {
    const value = toolInput[key];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

export async function handleClaudeHook(engine: StroqEngine, raw: unknown): Promise<HookOutput> {
  const input = ClaudeHookInputSchema.parse(raw);
  const cwd = input.cwd || process.cwd();
  const mcpIdentity = mcpIdentityFromEncodedTool('claude-code', input.tool_name);
  const base = {
    sessionId: input.session_id,
    toolName: input.tool_name,
    toolInput: input.tool_input,
    cwd,
    ...(mcpIdentity === undefined ? {} : { mcpIdentity }),
    ...(input.tool_use_id === undefined ? {} : { callId: input.tool_use_id }),
  };
  if (input.hook_event_name === 'PreToolUse') {
    const { decision, provenance, secrets } = await engine.pre(base);
    if (decision.effect === 'deny')
      return denyOutput(
        withEvidence(
          `Stroq blocked this action (${decision.ruleId}): ${decision.reason}`,
          provenance,
          new Date(),
          secrets,
        ),
      );
    if (decision.effect === 'ask')
      return askOutput(
        withEvidence(
          `Stroq: ${decision.reason} (${decision.ruleId})`,
          provenance,
          new Date(),
          secrets,
        ),
      );
    return NO_OUTPUT;
  }
  const failed = input.hook_event_name === 'PostToolUseFailure';
  const response = failed ? input.error : (input.tool_response ?? input.tool_result);
  const reading = safeReading(response, requestedPath(input.tool_input));
  const result = await engine.post({
    ...base,
    ...(failed ? { resultFailed: true as const } : {}),
    toolResultText: reading.text,
    ...((reading.serialised && PROSE_TOOL.test(input.tool_name)) || reading.failed
      ? { resultUnread: true as const }
      : {}),
    // No result field at all is not an empty result: it is a payload shape this
    // adapter does not know, and the audit says so instead of recording a clean scan.
    ...(response === undefined ? { resultMissing: Object.keys(input).sort() } : {}),
  });
  if (result.provenanceError) logError('provenance', result.provenanceError);
  if (!result.scanned) return NO_OUTPUT;
  const ruleIds = [...new Set(result.scan.matches.map((m) => m.ruleId))];
  const atoms = countAtoms(result.atoms);
  const stroq = {
    verdict: result.scan.verdict,
    score: result.scan.score,
    ruleIds,
    atoms,
  };
  const warning = warningFor(
    result.scan,
    input.tool_name,
    taintSource(result),
    result.flaggedOwn !== undefined,
  );
  // The failure event's output carries `additionalContext` and nothing else: the
  // classifier's context is a PostToolUse field, and a hookEventName that does not
  // match the event Claude Code fired is not accepted.
  if (failed)
    return result.scan.verdict === 'suspect' && result.trusted !== true
      ? postOutput({ additionalContext: warning }, 'PostToolUseFailure')
      : NO_OUTPUT;
  if (result.scan.verdict !== 'suspect' || result.trusted === true) {
    return Object.keys(atoms).length === 0
      ? NO_OUTPUT
      : postOutput({ classifierContext: { stroq } });
  }
  return postOutput({ additionalContext: warning, classifierContext: { stroq } });
}

export function failClosedOutput(raw: unknown, err: unknown): HookOutput {
  const record = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const toolName = typeof record['tool_name'] === 'string' ? record['tool_name'] : '';
  if (record['hook_event_name'] !== 'PreToolUse' || !HIGH_IMPACT_TOOL.test(toolName))
    return NO_OUTPUT;
  const message = err instanceof Error ? err.message : String(err);
  return denyOutput(`Stroq internal error (fail-closed): ${message}`);
}
