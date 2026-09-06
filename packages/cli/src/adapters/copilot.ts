import type { Decision, ProvenanceHit, SecretHit, StroqEngine } from '@stroq/core';
import { z } from 'zod';
import { NO_OUTPUT, withEvidence, type HookOutput } from './claude-code.js';
import {
  copilotResultText,
  copilotToolInput,
  copilotToolKind,
  copilotToolName,
  isCopilotHighImpact,
} from './copilot-input.js';
import { preCandidatesFor, unreadableGuard } from './kind-input.js';
import {
  MAX_PATCH_PATHS,
  decideWithGuards,
  handlePostResult,
  type EngineEvent,
  type PreGuards,
} from './pre-decision.js';

export {
  copilotResultText,
  copilotToolInput,
  copilotToolName,
  isCopilotHighImpact,
} from './copilot-input.js';

/**
 * Copilot's `preToolUse` and `postToolUse` payloads are identical apart from
 * `toolResult`, and neither carries the event name. The phase therefore arrives on
 * the command line — `stroq hook copilot pre` / `… post`, exactly as `init` writes it
 * — and is never inferred from the payload: guessing `post` for an event that was
 * really `pre` is a deny that is never printed.
 */
export const COPILOT_PHASES = ['pre', 'post'] as const;
export type CopilotPhase = (typeof COPILOT_PHASES)[number];
export const isCopilotPhase = (value: string): value is CopilotPhase =>
  (COPILOT_PHASES as readonly string[]).includes(value);

/**
 * Loose on purpose: a shape surprise in a field Stroq does not read must not fail
 * validation and discard the whole event. On `post` a discarded event is a scan that
 * never runs and a taint that is never set, and the follow-up action then sails
 * through. `sessionId` and `toolName` stay required — an event missing either is
 * malformed, and malformed input is fail-closed, not ignored.
 */
export const CopilotHookInputSchema = z.looseObject({
  sessionId: z.string().min(1),
  toolName: z.string(),
  toolArgs: z.unknown().optional(),
  toolResult: z.unknown().optional(),
  cwd: z.string().default(''),
  // Never read; see the note above.
  timestamp: z.unknown().optional(),
  traceparent: z.unknown().optional(),
  tracestate: z.unknown().optional(),
});
export type CopilotHookInput = z.infer<typeof CopilotHookInputSchema>;

/**
 * A decision, at the TOP LEVEL. Copilot honours Claude Code's `hookSpecificOutput`
 * envelope for nothing that matters here (github/copilot-cli#2013), and an
 * unrecognised payload is a hook that produced no decision, i.e. fail open.
 */
const decisionOutput = (decision: 'deny' | 'ask', reason: string): HookOutput => ({
  stdout: JSON.stringify({ permissionDecision: decision, permissionDecisionReason: reason }),
  exitCode: 0,
});

export const copilotDenyOutput = (reason: string): HookOutput => decisionOutput('deny', reason);
/** A real prompt in the interactive CLI; the cloud coding agent turns it into a deny. */
export const copilotAskOutput = (reason: string): HookOutput => decisionOutput('ask', reason);

/** A `postToolUse` warning. No `classifierContext`: that is Claude-only, and an unknown field is noise. */
const copilotContextOutput = (context: string): HookOutput => ({
  stdout: JSON.stringify({ additionalContext: context }),
  exitCode: 0,
});

/**
 * The block Copilot honours without parsing stdout: exit code 2, reason on stderr.
 * Used for internal errors on a high-impact `pre`, where the failure is often *why*
 * the JSON path cannot be trusted in the first place.
 */
export const copilotBlockOutput = (reason: string): HookOutput => ({
  stdout: '',
  stderr: reason,
  exitCode: 2,
});

/**
 * `stroq hook copilot` without a usable phase. The event does not name itself, so
 * there is no way to tell a `pre` that must be answered from a `post` that must not,
 * and answering either way would be a decision made on no information. Exit 2 is a
 * deny on `preToolUse` and harmless anywhere else, so it is the one safe answer.
 */
export const copilotBadPhaseOutput = (arg: string): HookOutput =>
  copilotBlockOutput(
    `Stroq internal error (fail-closed): "stroq hook copilot" needs a phase argument, ` +
      `"pre" or "post" (got "${arg}"). Re-run "stroq init --agent copilot" to reinstall the hook.`,
  );

/** `NO_OUTPUT` for an allow: Copilot treats empty stdout as the default flow, the smallest surface. */
export function renderDecision(
  decision: Decision,
  provenance: readonly ProvenanceHit[],
  secrets: readonly SecretHit[],
  now: Date = new Date(),
): HookOutput {
  if (decision.effect === 'allow') return NO_OUTPUT;
  const verb = decision.effect === 'deny' ? 'blocked this action' : 'asks before this action';
  const reason = withEvidence(
    `Stroq ${verb} (${decision.ruleId}): ${decision.reason}`,
    provenance,
    now,
    secrets,
  );
  return decision.effect === 'deny' ? copilotDenyOutput(reason) : copilotAskOutput(reason);
}

/**
 * Recorded (and enforced) when a call names more targets than Stroq can classify
 * inside the hook timeout — the files an `apply_patch` declares or the URLs a
 * `web_fetch` carries, both of which fan out to one `engine.pre` each.
 */
export const COPILOT_TOO_MANY_TARGETS: Decision = {
  effect: 'deny',
  ruleId: 'copilot-too-many-targets',
  reason: `the call names more than ${MAX_PATCH_PATHS} files or URLs, more than Stroq can classify inside Copilot's hook timeout — and a timed-out Copilot hook is treated as an allow`,
};

/**
 * Recorded (and enforced) when Copilot sent something under a shape the adapter could
 * not read a command, a patch, a path or a URL out of. The reason names the top-level
 * KEYS (or the value's type) and never a value: `toolArgs` is exactly where a secret
 * would be, and this reason is printed to the agent, logged and audited.
 */
export const copilotUnreadableInput = (shape: string): Decision => ({
  effect: 'deny',
  ruleId: 'copilot-unreadable-input',
  reason:
    `Stroq could not read the command, patch, path or URL from Copilot's toolArgs ` +
    `(keys: ${shape}); denied fail-closed. ` +
    'Report the payload shape at https://github.com/AGGIB/Stroq/issues',
});

/**
 * The candidate lists and the "could not read it at all" guard are `kind-input.ts`'s,
 * shared with the OpenClaw adapter: both ran line-for-line copies of them, and a copy
 * of a security check is a fix that lands on one agent only. Copilot's own part is
 * the two lines below — which kind its tool name maps to, and how the deny is worded.
 */
function preGuards(
  input: CopilotHookInput,
  toolInput: Readonly<Record<string, unknown>>,
): PreGuards {
  const kind = copilotToolKind(input.toolName, input.toolArgs);
  const found = preCandidatesFor(kind, input.toolArgs, toolInput);
  return {
    ...found,
    unreadable: unreadableGuard(kind, input.toolArgs, toolInput, found, copilotUnreadableInput),
  };
}

/** The guard ordering and the engine loop are shared with the Codex adapter. */
const handlePre = (engine: StroqEngine, event: EngineEvent, guards: PreGuards) =>
  decideWithGuards(
    engine,
    event,
    guards,
    {
      tooLarge: COPILOT_TOO_MANY_TARGETS,
      unreadableSummary: 'copilot: unreadable toolArgs',
      tooLargeSummary: (count) => `${count} files or URLs`,
    },
    renderDecision,
  );

const handlePost = (engine: StroqEngine, event: EngineEvent, result: unknown) =>
  handlePostResult(engine, event, copilotResultText(result), copilotContextOutput);

/**
 * Coupling to know about: the two adapter-level denies (oversized patch, unreadable
 * input) append their audit entry through `auditFile()` (the engine keeps its own
 * `AuditLog` private), so an engine built at a different home — `createEngineAt`,
 * used only by `stroq attack`, which never routes Copilot events — would see those
 * entries land under `STROQ_HOME` instead.
 */
export async function handleCopilotHook(
  engine: StroqEngine,
  phase: CopilotPhase,
  raw: unknown,
): Promise<HookOutput> {
  const input = CopilotHookInputSchema.parse(raw);
  const toolInput = copilotToolInput(input);
  const event: EngineEvent = {
    sessionId: input.sessionId,
    toolName: copilotToolName(input.toolName, input.toolArgs),
    toolInput,
    cwd: input.cwd || process.cwd(),
  };
  if (phase === 'post') return handlePost(engine, event, input.toolResult);
  return handlePre(engine, event, preGuards(input, toolInput));
}

/**
 * Exit 2 + stderr for a high-impact `pre`, nothing anywhere else. On `post` there is
 * nothing to block and stalling the agent buys no safety; on a `pre` for a tool that
 * only looks at things, the same. A missing or non-string `toolName` is malformed
 * input, which is fail-closed exactly like stdin that was not JSON at all — and on
 * Copilot it is doubly so, because an unknown name is treated as an MCP call.
 */
export function copilotFailClosedOutput(
  phase: CopilotPhase,
  raw: unknown,
  err: unknown,
): HookOutput {
  if (phase !== 'pre') return NO_OUTPUT;
  const record = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const tool = record['toolName'];
  if (typeof tool === 'string' && !isCopilotHighImpact(tool)) return NO_OUTPUT;
  const message = err instanceof Error ? err.message : String(err);
  return copilotBlockOutput(`Stroq internal error (fail-closed): ${message}`);
}
