import {
  AuditLog,
  warningFor,
  type Decision,
  type ProvenanceHit,
  type SecretHit,
  type StroqEngine,
} from '@stroq/core';
import { z } from 'zod';
import { logError } from '../log.js';
import { auditFile } from '../paths.js';
import { NO_OUTPUT, toolResultToText, withEvidence, type HookOutput } from './claude-code.js';
import { mcpToolName } from './cursor-mcp-name.js';

/** The two Codex events Stroq installs on; any other event is not ours to answer. */
export const CODEX_EVENTS = ['PreToolUse', 'PostToolUse'] as const;
export type CodexEvent = (typeof CODEX_EVENTS)[number];

/**
 * Tool shapes where a Codex deny actually stops a high-impact action, and so the
 * ones an internal error answers with exit code 2 — the single block Codex honours
 * without parsing stdout. Kept identical to the `PreToolUse` matcher `init` writes
 * (`commands/codex-hooks.ts`), so Stroq never sees a Pre event it cannot answer.
 */
export const CODEX_HIGH_IMPACT_TOOL = /^(Bash|apply_patch|mcp__)/;

/**
 * Loose on purpose: a shape surprise in a field Stroq does not read must not fail
 * validation and discard the whole event. On `PostToolUse` a discarded event is a
 * scan that never runs and a taint that is never set, and the follow-up action
 * then sails through. `tool_name` and `session_id` stay required — a `PreToolUse`
 * missing either is malformed, and malformed input is fail-closed, not ignored.
 */
export const CodexHookInputSchema = z.looseObject({
  session_id: z.string().min(1),
  hook_event_name: z.enum(CODEX_EVENTS),
  tool_name: z.string(),
  tool_input: z.unknown().optional(),
  tool_response: z.unknown().optional(),
  cwd: z.string().default(''),
  // Never read; see the note above.
  model: z.unknown().optional(),
  permission_mode: z.unknown().optional(),
  transcript_path: z.unknown().optional(),
  turn_id: z.unknown().optional(),
  tool_use_id: z.unknown().optional(),
});
export type CodexHookInput = z.infer<typeof CodexHookInputSchema>;

/**
 * Codex names an MCP tool `mcp__<server>__<tool>` in `tool_name` and reports no
 * separate server, so the shared sanitiser is called with an empty server: it then
 * splits at the FIRST `__` and re-sanitises each half, so a tool whose own name
 * carries a second separator cannot forge a different server. `apply_patch` becomes
 * `Write` (the tool name the classifier's path rules know); everything else is
 * passed through unchanged and classifies to nothing.
 */
export function codexToolName(rawTool: string): string {
  if (rawTool === 'apply_patch') return 'Write';
  if (rawTool.startsWith('mcp__')) return mcpToolName('', rawTool);
  return rawTool;
}

/**
 * Codex sends `tool_input` as a JSON value: usually an object, sometimes a JSON
 * string. A string that is not a JSON object, and any other non-object value, is
 * kept verbatim under `raw` rather than dropped to `{}` — the secret-egress
 * candidate extractor scans `JSON.stringify(toolInput)`, so a value that
 * disappears here is a value that can never be caught leaving through this call.
 */
function codexRecord(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return { raw: JSON.stringify(value) };
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      return parsed as Record<string, unknown>;
  } catch {
    // not JSON at all — fall through to the raw string below
  }
  return { raw: value };
}

/** Codex's shell input is `{ command }`; some builds send argv instead of one string. */
function commandOf(record: Readonly<Record<string, unknown>>): string {
  const value = record['command'];
  if (typeof value === 'string') return value;
  if (Array.isArray(value))
    return value.filter((p): p is string => typeof p === 'string').join(' ');
  return '';
}

/** The patch body, under whichever key this Codex build put it. */
const PATCH_FIELDS = ['command', 'input', 'patch'] as const;

function patchTextOf(record: Readonly<Record<string, unknown>>): string {
  for (const key of PATCH_FIELDS) {
    const value = record[key];
    if (typeof value === 'string' && value !== '') return value;
    if (Array.isArray(value)) {
      const joined = value.filter((p): p is string => typeof p === 'string').join('\n');
      if (joined !== '') return joined;
    }
  }
  return '';
}

const MAX_PATCH_CHARS = 200_000;
/**
 * A header only counts at column 0. Patch body lines are prefixed with `+`, `-` or a
 * space, so an anchored match is what stops a patch that merely *contains*
 * `*** Add File: /home/dev/.ssh/id_rsa` from claiming to touch a file it does not —
 * and, in the other direction, from hiding the file it really does touch behind noise.
 * The capture may be empty (a header with no path, or one whose path is a lone `\r`):
 * the caller drops those, which is why it is `[^\r\n]*?` and not `.+?`.
 */
const PATCH_HEADER =
  /^\*\*\* (?:Add File|Update File|Delete File|Move to):[ \t]*([^\r\n]*?)[ \t\r]*$/;

/** Every distinct path an `apply_patch` body declares, in the order it declares them. */
export function applyPatchPaths(patchText: string): readonly string[] {
  const paths = new Set<string>();
  for (const line of patchText.slice(0, MAX_PATCH_CHARS).split('\n')) {
    const path = PATCH_HEADER.exec(line)?.[1] ?? '';
    if (path !== '') paths.add(path);
  }
  return [...paths];
}

export function codexToolInput(input: CodexHookInput): Record<string, unknown> {
  const record = codexRecord(input.tool_input);
  if (input.tool_name === 'apply_patch') {
    const paths = applyPatchPaths(patchTextOf(record));
    return { file_path: paths[0] ?? '', file_paths: [...paths] };
  }
  if (input.tool_name === 'Bash') return { command: commandOf(record) };
  return record;
}

/**
 * The text of a completed action. Codex puts the unified shell result in `output`;
 * some builds still send `stdout`/`stderr`. An empty `output` is not the official
 * field being in play — Codex (or a proxy) can send `output: ''` — so it must not
 * shadow the streams that carry the real, possibly poisoned, result.
 */
export function codexResultText(response: unknown): string {
  if (response && typeof response === 'object' && !Array.isArray(response)) {
    const record = response as Record<string, unknown>;
    const output = record['output'];
    if (typeof output === 'string' && output !== '') return toolResultToText(output);
    const streams = [record['stdout'], record['stderr']].filter(
      (part): part is string => typeof part === 'string' && part.length > 0,
    );
    if (streams.length > 0) return toolResultToText(streams.join('\n'));
  }
  return toolResultToText(response);
}

const envelope = (event: CodexEvent, fields: Readonly<Record<string, unknown>>): HookOutput => ({
  stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: event, ...fields } }),
  exitCode: 0,
});

/** The JSON deny Codex reads on `PreToolUse`; the same envelope the Claude Code adapter emits. */
export const codexDenyOutput = (reason: string): HookOutput =>
  envelope('PreToolUse', { permissionDecision: 'deny', permissionDecisionReason: reason });

/** A `PostToolUse` warning. No `classifierContext`: that is Claude-only, and an unknown field fails open. */
const codexContextOutput = (context: string): HookOutput =>
  envelope('PostToolUse', { additionalContext: context });

/**
 * The one block Codex honours without parsing stdout: exit code 2, reason on
 * stderr. Used for internal errors on high-impact `PreToolUse` events, where the
 * failure is often *why* the JSON path cannot be trusted in the first place.
 */
export const codexBlockOutput = (reason: string): HookOutput => ({
  stdout: '',
  stderr: reason,
  exitCode: 2,
});

/**
 * Codex's hook contract has no `ask`. Rather than drop the decision to an allow, the
 * adapter denies and says so, naming the rule to relax — lossy on the wire, by
 * design, and never lossy in the audit, which still records the policy's real `ask`.
 */
const askAsDeny = (decision: Decision): string =>
  `Stroq would ask before this action (${decision.ruleId}): ${decision.reason}. ` +
  'Codex hooks cannot prompt, so it is denied; run it yourself or relax the rule in ~/.stroq/policy.yaml.';

/** `NO_OUTPUT` for an allow: Codex treats empty stdout as continue, the smallest surface. */
export function renderDecision(
  decision: Decision,
  provenance: readonly ProvenanceHit[],
  secrets: readonly SecretHit[],
  now: Date = new Date(),
): HookOutput {
  if (decision.effect === 'allow') return NO_OUTPUT;
  const headline =
    decision.effect === 'deny'
      ? `Stroq blocked this action (${decision.ruleId}): ${decision.reason}`
      : askAsDeny(decision);
  return codexDenyOutput(withEvidence(headline, provenance, now, secrets));
}

interface EngineEvent {
  readonly sessionId: string;
  readonly toolName: string;
  readonly toolInput: Record<string, unknown>;
  readonly cwd: string;
}

/**
 * The most a patch may declare before Stroq stops classifying it path by path.
 * Beyond this, the sequential `engine.pre` calls risk running past Codex's hook
 * timeout — and a timed-out hook fails open, which is exactly the outcome a
 * ten-thousand-file patch would be crafted to produce.
 */
export const MAX_PATCH_PATHS = 64;

/** Recorded (and enforced) when a patch is too large to classify inside the timeout. */
export const CODEX_PATCH_TOO_LARGE: Decision = {
  effect: 'deny',
  ruleId: 'codex-patch-too-large',
  reason: `the patch declares more than ${MAX_PATCH_PATHS} files, more than Stroq can classify inside Codex's hook timeout`,
};

const asPaths = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((p): p is string => typeof p === 'string') : [];

/** One `toolInput` per patched path, so every file the patch touches is classified and audited. */
function patchInputs(
  toolInput: Readonly<Record<string, unknown>>,
  paths: readonly string[],
): Record<string, unknown>[] {
  if (paths.length <= 1) return [{ ...toolInput }];
  return paths.map((file_path) => ({ ...toolInput, file_path }));
}

/** deny beats ask beats allow: a patch is only as safe as its worst path. */
const SEVERITY: Readonly<Record<Decision['effect'], number>> = { allow: 0, ask: 1, deny: 2 };

/**
 * Sequential on purpose: the session store is file-locked and the audit log is a
 * hash chain, so the calls cannot overlap — and the order they run in is the order
 * `stroq log` will show the patch's paths.
 */
async function decidePre(
  engine: StroqEngine,
  event: EngineEvent,
  inputs: readonly Record<string, unknown>[],
) {
  let worst = await engine.pre({ ...event, toolInput: inputs[0] ?? event.toolInput });
  for (const toolInput of inputs.slice(1)) {
    const next = await engine.pre({ ...event, toolInput });
    if (SEVERITY[next.decision.effect] > SEVERITY[worst.decision.effect]) worst = next;
  }
  return worst;
}

async function denyOversizedPatch(event: EngineEvent, count: number): Promise<HookOutput> {
  await new AuditLog(auditFile()).append({
    sessionId: event.sessionId,
    phase: 'pre',
    tool: 'Write',
    summary: `apply_patch: ${count} files`,
    classes: [],
    decision: CODEX_PATCH_TOO_LARGE,
  });
  return codexDenyOutput(
    `Stroq blocked this action (${CODEX_PATCH_TOO_LARGE.ruleId}): ${CODEX_PATCH_TOO_LARGE.reason}. Split the change into smaller patches.`,
  );
}

async function handlePre(
  engine: StroqEngine,
  event: EngineEvent,
  patchPaths: readonly string[],
): Promise<HookOutput> {
  if (patchPaths.length > MAX_PATCH_PATHS) return denyOversizedPatch(event, patchPaths.length);
  const { decision, provenance, secrets } = await decidePre(
    engine,
    event,
    patchInputs(event.toolInput, patchPaths),
  );
  return renderDecision(decision, provenance, secrets);
}

async function handlePost(
  engine: StroqEngine,
  event: EngineEvent,
  response: unknown,
): Promise<HookOutput> {
  const result = await engine.post({ ...event, toolResultText: codexResultText(response) });
  if (result.provenanceError) logError('provenance', result.provenanceError);
  if (!result.scanned || result.scan.verdict !== 'suspect') return NO_OUTPUT;
  return codexContextOutput(warningFor(result.scan, event.toolName));
}

/**
 * Coupling to know about: the oversized-patch deny appends its audit entry through
 * `auditFile()` (the engine keeps its own `AuditLog` private), so an engine built at
 * a different home — `createEngineAt`, used only by `stroq attack`, which never
 * routes Codex events — would see that one entry land under `STROQ_HOME` instead.
 */
export async function handleCodexHook(engine: StroqEngine, raw: unknown): Promise<HookOutput> {
  const input = CodexHookInputSchema.parse(raw);
  const toolInput = codexToolInput(input);
  const event: EngineEvent = {
    sessionId: input.session_id,
    toolName: codexToolName(input.tool_name),
    toolInput,
    cwd: input.cwd || process.cwd(),
  };
  if (input.hook_event_name === 'PostToolUse')
    return handlePost(engine, event, input.tool_response);
  return handlePre(
    engine,
    event,
    input.tool_name === 'apply_patch' ? asPaths(toolInput['file_paths']) : [],
  );
}

/**
 * Exit 2 + stderr for a high-impact `PreToolUse`, nothing anywhere else. A *named*
 * event or tool outside that set is not ours to block: Stroq does not answer events
 * it did not install on, and stalling a `PostToolUse` buys no safety. A missing or
 * non-string event name or tool name is malformed input, which is fail-closed
 * exactly like stdin that was not JSON at all.
 */
export function codexFailClosedOutput(raw: unknown, err: unknown): HookOutput {
  const record = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const event = record['hook_event_name'];
  const tool = record['tool_name'];
  if (typeof event === 'string' && event !== 'PreToolUse') return NO_OUTPUT;
  if (typeof tool === 'string' && !CODEX_HIGH_IMPACT_TOOL.test(tool)) return NO_OUTPUT;
  const message = err instanceof Error ? err.message : String(err);
  return codexBlockOutput(`Stroq internal error (fail-closed): ${message}`);
}
