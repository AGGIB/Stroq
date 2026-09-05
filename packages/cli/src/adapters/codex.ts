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
import {
  CODEX_HIGH_IMPACT_TOOL,
  codexToolInput,
  codexToolName,
  describeToolInput,
  isBashTool,
  isEmptyToolInput,
  isPatchTool,
} from './codex-input.js';

export {
  CODEX_HIGH_IMPACT_TOOL,
  applyPatchPaths,
  codexToolInput,
  codexToolName,
} from './codex-input.js';

/** The two Codex events Stroq installs on; any other event is not ours to answer. */
export const CODEX_EVENTS = ['PreToolUse', 'PostToolUse'] as const;
export type CodexEvent = (typeof CODEX_EVENTS)[number];

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

/**
 * Recorded (and enforced) when Codex sent something under a shape the adapter
 * could not read a command or a patch out of. The reason names the top-level KEYS
 * (or the value's type) and never a value: `tool_input` is exactly where a secret
 * would be, and this reason is printed to the agent, logged and audited.
 */
export const codexUnreadableInput = (shape: string): Decision => ({
  effect: 'deny',
  ruleId: 'codex-unreadable-input',
  reason:
    `Stroq could not read the command or patch from Codex's tool_input (keys: ${shape}); ` +
    'denied fail-closed. Report the payload shape at https://github.com/AGGIB/Stroq/issues',
});

const asPaths = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((p): p is string => typeof p === 'string') : [];

/**
 * A high-impact call Codex sent arguments for, whose command or patch the adapter
 * could not find. Handing the engine the empty action it extracted would classify
 * nothing and allow the call — fail-open on precisely the shape surprise this
 * adapter cannot anticipate — so it is denied instead. An EMPTY `tool_input` is a
 * different thing: there is nothing to act on, and it keeps running through the
 * engine. MCP tools are never this: their arguments are the record itself, which
 * the secret guard scans whatever shape it arrived in.
 */
function unreadableInput(
  input: CodexHookInput,
  toolInput: Readonly<Record<string, unknown>>,
): Decision | null {
  const bash = isBashTool(input.tool_name);
  const patch = isPatchTool(input.tool_name);
  // The only two high-impact shapes with a command or a patch to lose.
  if (!bash && !patch) return null;
  if (isEmptyToolInput(input.tool_input)) return null;
  const readable = bash ? toolInput['command'] !== '' : asPaths(toolInput['file_paths']).length > 0;
  return readable ? null : codexUnreadableInput(describeToolInput(input.tool_input));
}

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
 * `stroq log` will show the patch's paths. `inputs` is always non-empty in practice —
 * `patchInputs` never returns `[]` — the guard exists only to give `first` a real
 * (non-`undefined`) type under `noUncheckedIndexedAccess` without a silent fallback.
 */
async function decidePre(
  engine: StroqEngine,
  event: EngineEvent,
  inputs: readonly Record<string, unknown>[],
) {
  const [first, ...rest] = inputs;
  if (!first) throw new Error('decidePre: inputs must be non-empty');
  let worst = await engine.pre({ ...event, toolInput: first });
  for (const toolInput of rest) {
    const next = await engine.pre({ ...event, toolInput });
    if (SEVERITY[next.decision.effect] > SEVERITY[worst.decision.effect]) worst = next;
  }
  return worst;
}

/** An audited deny the engine never made: recorded here so `stroq log`/`why` still explain it. */
async function denyDirectly(
  event: EngineEvent,
  decision: Decision,
  summary: string,
): Promise<HookOutput> {
  await new AuditLog(auditFile()).append({
    sessionId: event.sessionId,
    phase: 'pre',
    tool: event.toolName,
    summary,
    classes: [],
    decision,
  });
  return renderDecision(decision, [], []);
}

interface PreGuards {
  readonly patchPaths: readonly string[];
  readonly unreadable: Decision | null;
}

async function handlePre(
  engine: StroqEngine,
  event: EngineEvent,
  guards: PreGuards,
): Promise<HookOutput> {
  if (guards.unreadable)
    return denyDirectly(event, guards.unreadable, 'codex: unreadable tool_input');
  if (guards.patchPaths.length > MAX_PATCH_PATHS)
    return denyDirectly(
      event,
      CODEX_PATCH_TOO_LARGE,
      `apply_patch: ${guards.patchPaths.length} files`,
    );
  const { decision, provenance, secrets } = await decidePre(
    engine,
    event,
    patchInputs(event.toolInput, guards.patchPaths),
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
 * Coupling to know about: the two adapter-level denies (oversized patch, unreadable
 * input) append their audit entry through `auditFile()` (the engine keeps its own
 * `AuditLog` private), so an engine built at a different home — `createEngineAt`,
 * used only by `stroq attack`, which never routes Codex events — would see those
 * entries land under `STROQ_HOME` instead.
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
  return handlePre(engine, event, {
    patchPaths: isPatchTool(input.tool_name) ? asPaths(toolInput['file_paths']) : [],
    unreadable: unreadableInput(input, toolInput),
  });
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
