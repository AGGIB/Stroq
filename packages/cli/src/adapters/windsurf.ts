import type { Decision, ProvenanceHit, SecretHit, StroqEngine } from '@stroq/core';
import { z } from 'zod';
import { NO_OUTPUT, withEvidence, type HookOutput } from './claude-code.js';
import { preCandidatesFor, unreadableGuard } from './kind-input.js';
import {
  MAX_PATCH_PATHS,
  asPaths,
  decideWithGuards,
  handlePostResult,
  scanPostResult,
  type EngineEvent,
  type PreGuards,
} from './pre-decision.js';
import {
  isWindsurfEvent,
  isWindsurfHighImpact,
  windsurfReadText,
  windsurfResultText,
  windsurfToolArgs,
  windsurfToolInput,
  windsurfToolKind,
  windsurfToolName,
  type WindsurfEvent,
} from './windsurf-input.js';

export {
  WINDSURF_EVENTS,
  WINDSURF_MAX_READ_BYTES,
  isWindsurfEvent,
  isWindsurfHighImpact,
  windsurfReadText,
  windsurfResultText,
  windsurfToolInput,
  windsurfToolName,
  type WindsurfEvent,
} from './windsurf-input.js';

/**
 * Windsurf's payload names its own event in `agent_action_name`, so ONE installed
 * command serves all six events and there is no phase argument — unlike Copilot and
 * OpenClaw, whose events do not name themselves. Everything else about this adapter
 * follows from two lines of Windsurf's contract: there is no stdout contract, and any
 * exit other than 0 or 2 is an allow. So a deny, an ask and a post-scan warning are
 * all exit 2 with a sentence on stderr, and the adapter never exits 1 on purpose.
 */

/**
 * Loose on purpose: a shape surprise in a field Stroq does not read must not fail
 * validation and discard the whole event. On a `post_*` event a discarded event is a
 * scan that never runs and a taint that is never set, and the follow-up action then
 * sails through. `agent_action_name` and `trajectory_id` stay required — an event
 * missing either is malformed, and malformed input is fail-closed, not ignored.
 */
export const WindsurfHookInputSchema = z.looseObject({
  agent_action_name: z.string(),
  trajectory_id: z.string().min(1),
  tool_info: z.unknown().optional(),
  // Carried for the audit trail and for future rules; never read today.
  execution_id: z.unknown().optional(),
  timestamp: z.unknown().optional(),
  model_name: z.unknown().optional(),
});
export type WindsurfHookInput = z.infer<typeof WindsurfHookInputSchema>;

/**
 * The one channel that reaches Cascade: exit code 2 with the message on stderr. There
 * is no stdout contract at all, so nothing is ever printed there — and with
 * `show_output: true` on the installed entry, this stderr is what the user sees in
 * the Cascade UI too.
 */
export const windsurfBlockOutput = (reason: string): HookOutput => ({
  stdout: '',
  stderr: reason,
  exitCode: 2,
});

/**
 * Windsurf's hook contract has no `ask`. Rather than drop the decision to an allow,
 * the adapter denies and says so, naming the rule to relax — lossy on the wire, by
 * design, and never lossy in the audit, which still records the policy's real `ask`.
 * One trailing period is stripped from the policy's own reason first: every default
 * `ask` reason is written without one, but a custom policy's is not Stroq's to
 * assume, and appending this sentence unconditionally would render `..` for a reason
 * that already ends its own.
 */
const askAsDeny = (decision: Decision): string => {
  const reason = decision.reason.endsWith('.') ? decision.reason.slice(0, -1) : decision.reason;
  return (
    `Stroq would ask before this action (${decision.ruleId}): ${reason}. ` +
    'Windsurf hooks cannot prompt, so it is denied; run it yourself or relax the rule in ~/.stroq/policy.yaml.'
  );
};

/** `NO_OUTPUT` for an allow: exit 0 and silence is how a Windsurf hook says "proceed". */
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
  return windsurfBlockOutput(withEvidence(headline, provenance, now, secrets));
}

/**
 * Recorded (and enforced) when a call names more targets than Stroq can classify
 * inside whatever budget Windsurf gives a hook — which is undocumented, so the bound
 * matters more here rather than less. No Windsurf payload can actually reach it
 * today: a path fans out over at most three field spellings and a command over at
 * most six, and Windsurf has no patch or fetch event. It exists because
 * `decideWithGuards` requires a decision for the case, and because a candidate list
 * added later must be bounded by construction rather than by review.
 */
export const WINDSURF_TOO_MANY_TARGETS: Decision = {
  effect: 'deny',
  ruleId: 'windsurf-too-many-targets',
  reason: `the call names more than ${MAX_PATCH_PATHS} files, more than Stroq can classify inside a Windsurf hook`,
};

/**
 * Recorded (and enforced) when Windsurf sent something under a shape the adapter could
 * not read a command or a path out of. The reason names the top-level KEYS (or the
 * value's type) and never a value: `tool_info` is exactly where a secret would be, and
 * this reason is printed to the agent, logged and audited.
 */
export const windsurfUnreadableInput = (shape: string): Decision => ({
  effect: 'deny',
  ruleId: 'windsurf-unreadable-input',
  reason:
    `Stroq could not read the command or the file path from Windsurf's tool_info ` +
    `(keys: ${shape}); denied fail-closed. ` +
    'Report the payload shape at https://github.com/AGGIB/Stroq/issues',
});

/**
 * The candidate lists and the "could not read it at all" guard are `kind-input.ts`'s,
 * shared with the Copilot and OpenClaw adapters: a copy of a security check is a fix
 * that lands on one agent only. Windsurf's own part is the two lines below — which
 * kind its event maps to, and how the deny is worded. Note that a `pre_read_code`
 * whose path is unreadable is NOT denied: the shared guard covers the shapes that can
 * lose a command, a patch, a written path or a URL, and a read is the same trade-off
 * the fail-closed set makes.
 */
function preGuards(
  event: WindsurfEvent,
  args: unknown,
  toolInput: Readonly<Record<string, unknown>>,
): PreGuards {
  const kind = windsurfToolKind(event);
  const found = preCandidatesFor(kind, args, toolInput);
  return {
    ...found,
    unreadable: unreadableGuard(kind, args, toolInput, found, windsurfUnreadableInput),
  };
}

/** The guard ordering and the engine loop are shared with the other adapters. */
const handlePre = (engine: StroqEngine, event: EngineEvent, guards: PreGuards) =>
  decideWithGuards(
    engine,
    event,
    guards,
    {
      tooLarge: WINDSURF_TOO_MANY_TARGETS,
      unreadableSummary: 'windsurf: unreadable tool_info',
      tooLargeSummary: (count) => `${count} files`,
    },
    renderDecision,
  );

/**
 * A suspect result is exit 2 with the warning on stderr — the documented channel by
 * which "the Cascade agent will see the error message". On a post hook an exit 2
 * blocks nothing, because the action has already happened; it is purely how the
 * warning reaches the model and the user. A clean or unscanned result says nothing.
 */
const handlePost = (engine: StroqEngine, event: EngineEvent, text: string) =>
  handlePostResult(engine, event, text, windsurfBlockOutput);

/**
 * Every distinct path `post_read_code` named: `file_path` (the fan-out's canonical
 * candidate, from the shared `pathsOf`) plus every entry of `file_paths`, which
 * `kindToolInput`/`withCandidates` populates whenever the path fields disagreed.
 * Reading `file_path` alone used to scan only ONE of several disagreeing candidates —
 * `{ path: 'clean.md', file_path: 'poisoned.md' }` scanned `clean.md`, because
 * `file_path` there is `pathsOf`'s `candidates[0]` (`path` sorts first), not
 * necessarily the file Cascade actually read. Deduplicated so a payload whose fields
 * agreed is not scanned twice.
 */
function postReadCandidates(toolInput: Readonly<Record<string, unknown>>): readonly string[] {
  const first = toolInput['file_path'];
  const rest = asPaths(toolInput['file_paths']);
  const all = typeof first === 'string' && first !== '' ? [first, ...rest] : rest;
  return [...new Set(all)];
}

/**
 * `post_read_code` carries the path and not the content, so Stroq reads the file(s)
 * itself, capped, and scans each candidate in turn — sequentially, never
 * concurrently, because the session store is file-locked. A read that gave Cascade
 * nothing — a directory, a missing or unreadable file, an empty path, an empty file —
 * contributes no engine call, no audit entry and no output for that candidate. If ANY
 * candidate scans suspect the call answers exit 2 with that warning (the worst wins,
 * the same rule every other fan-out in this adapter uses); only when every candidate
 * came back clean or unscanned does it answer `NO_OUTPUT`.
 */
async function handlePostRead(engine: StroqEngine, event: EngineEvent): Promise<HookOutput> {
  let warning: string | null = null;
  for (const path of postReadCandidates(event.toolInput)) {
    const text = windsurfReadText(path, event.cwd);
    if (text === '') continue;
    const outcome = await scanPostResult(engine, event, text);
    if (outcome.warning !== null && warning === null) warning = outcome.warning;
  }
  return warning === null ? NO_OUTPUT : windsurfBlockOutput(warning);
}

/**
 * Coupling to know about: the two adapter-level denies (too many targets, unreadable
 * input) append their audit entry through `auditFile()` inside `denyDirectly` (the
 * engine keeps its own `AuditLog` private), so an engine built at a different home —
 * `createEngineAt`, used only by `stroq attack`, which never routes Windsurf events —
 * would see those entries land under `STROQ_HOME` instead.
 */
export async function handleWindsurfHook(engine: StroqEngine, raw: unknown): Promise<HookOutput> {
  const input = WindsurfHookInputSchema.parse(raw);
  const action = input.agent_action_name;
  // An event Stroq did not install on, and any future one: silence. Stroq does not
  // block what it does not understand, and blocking `pre_user_prompt` by accident
  // would block the user.
  if (!isWindsurfEvent(action)) return NO_OUTPUT;
  const args = windsurfToolArgs(action, input.tool_info);
  const toolInput = windsurfToolInput(action, args);
  const event: EngineEvent = {
    sessionId: input.trajectory_id,
    toolName: windsurfToolName(action, input.tool_info),
    toolInput,
    // The hook's OWN directory, which Windsurf sets to the workspace root (the
    // default of the `working_directory` Stroq deliberately does not write), and
    // never `tool_info.cwd`: that field is the directory Cascade chose, i.e.
    // model-controlled, and honouring it would let a tool call point the secret
    // index and the path classification at an empty directory — the OpenClaw
    // Critical, corrected before ship. Nothing strips `cwd` out of the payload; only
    // this field stops trusting it.
    cwd: process.cwd(),
  };
  if (action === 'post_read_code') return handlePostRead(engine, event);
  if (action === 'post_mcp_tool_use')
    return handlePost(engine, event, windsurfResultText(input.tool_info));
  return handlePre(engine, event, preGuards(action, args, toolInput));
}

/**
 * Exit 2 + stderr on a high-impact `pre` event, nothing anywhere else. On a `post`
 * there is nothing to block and stalling Cascade buys no safety; on `pre_read_code`
 * the same trade-off every other adapter makes for its read tool; on an event Stroq
 * did not install on, it is not Stroq's to block. A missing or non-string
 * `agent_action_name` is malformed input, which is fail-closed exactly like stdin
 * that was not JSON at all.
 */
export function windsurfFailClosedOutput(raw: unknown, err: unknown): HookOutput {
  const record = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const action = record['agent_action_name'];
  if (typeof action === 'string' && !isWindsurfHighImpact(action)) return NO_OUTPUT;
  const message = err instanceof Error ? err.message : String(err);
  return windsurfBlockOutput(`Stroq internal error (fail-closed): ${message}`);
}
