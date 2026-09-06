import type { Decision, ProvenanceHit, SecretHit, StroqEngine } from '@stroq/core';
import { z } from 'zod';
import { NO_OUTPUT, withEvidence, type HookOutput } from './claude-code.js';
import {
  CODEX_HIGH_IMPACT_TOOL,
  codexToolInput,
  codexToolName,
  commandCandidates,
  describeToolInput,
  isBashTool,
  isEmptyToolInput,
  isPatchTool,
} from './codex-input.js';
import {
  MAX_PATCH_PATHS,
  asPaths,
  decideWithGuards,
  handlePostResult,
  type EngineEvent,
  type PreGuards,
} from './pre-decision.js';
import { streamResultText } from './tool-result.js';

export {
  CODEX_HIGH_IMPACT_TOOL,
  applyPatchPaths,
  codexToolInput,
  codexToolName,
} from './codex-input.js';
// Both moved out of this file when the Copilot adapter became their second caller;
// re-exported so the Codex adapter's public surface is unchanged.
export { MAX_PATCH_PATHS } from './pre-decision.js';
export { streamResultText as codexResultText } from './tool-result.js';

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

/**
 * A high-impact call Codex sent arguments for, whose command or patch the adapter
 * could not find. Handing the engine the empty action it extracted would classify
 * nothing and allow the call — fail-open on precisely the shape surprise this
 * adapter cannot anticipate — so it is denied instead. An EMPTY `tool_input` is a
 * different thing: there is nothing to act on, and it keeps running through the
 * engine. MCP tools are never this: their arguments are the record itself, which
 * the secret guard scans whatever shape it arrived in.
 */
function unreadableInput(input: CodexHookInput, guards: Omit<PreGuards, 'unreadable'>) {
  const bash = isBashTool(input.tool_name);
  const patch = isPatchTool(input.tool_name);
  // The only two high-impact shapes with a command or a patch to lose.
  if (!bash && !patch) return null;
  if (isEmptyToolInput(input.tool_input)) return null;
  const readable = bash ? guards.commands.length > 0 : guards.patchPaths.length > 0;
  return readable ? null : codexUnreadableInput(describeToolInput(input.tool_input));
}

function preGuards(input: CodexHookInput, toolInput: Readonly<Record<string, unknown>>): PreGuards {
  const found = {
    commands: isBashTool(input.tool_name) ? commandCandidates(input.tool_input) : [],
    patchPaths: isPatchTool(input.tool_name) ? asPaths(toolInput['file_paths']) : [],
    // Codex has no fetch tool of its own: hosted tools such as WebSearch and the
    // web fetcher never reach hooks at all (see the README's Codex limits).
    urls: [],
  };
  return { ...found, unreadable: unreadableInput(input, found) };
}

/** The guard ordering and the engine loop are shared with the Copilot adapter. */
const handlePre = (engine: StroqEngine, event: EngineEvent, guards: PreGuards) =>
  decideWithGuards(
    engine,
    event,
    guards,
    { tooLarge: CODEX_PATCH_TOO_LARGE, unreadableSummary: 'codex: unreadable tool_input' },
    renderDecision,
  );

const handlePost = (engine: StroqEngine, event: EngineEvent, response: unknown) =>
  handlePostResult(engine, event, streamResultText(response), codexContextOutput);

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
  return handlePre(engine, event, preGuards(input, toolInput));
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
