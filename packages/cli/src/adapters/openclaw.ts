import type { Decision, ProvenanceHit, SecretHit, StroqEngine } from '@stroq/core';
import { z } from 'zod';
import { withEvidence, type HookOutput } from './claude-code.js';
import { commandCandidates, describeToolInput, isEmptyToolInput } from './codex-input.js';
import {
  isOpenClawHighImpact,
  openclawExecCwd,
  openclawResultText,
  openclawToolInput,
  openclawToolKind,
  openclawToolName,
  type OpenClawKind,
} from './openclaw-input.js';
import {
  MAX_PATCH_PATHS,
  asPaths,
  decideWithGuards,
  scanPostResult,
  type EngineEvent,
  type PreCandidates,
  type PreGuards,
} from './pre-decision.js';

export {
  isOpenClawHighImpact,
  openclawResultText,
  openclawToolInput,
  openclawToolName,
} from './openclaw-input.js';

/**
 * OpenClaw's `before_tool_call` and `after_tool_call` events are the same shape apart
 * from `result`/`error`, and neither carries the event name once the plugin has
 * serialised it. The phase therefore arrives on the command line — `stroq hook
 * openclaw pre` / `… post`, exactly as the plugin spawns it — and is never inferred
 * from the payload: guessing `post` for an event that was really `pre` is a deny that
 * is never printed.
 */
export const OPENCLAW_PHASES = ['pre', 'post'] as const;
export type OpenClawPhase = (typeof OPENCLAW_PHASES)[number];
export const isOpenClawPhase = (value: string): value is OpenClawPhase =>
  (OPENCLAW_PHASES as readonly string[]).includes(value);

/**
 * Loose on purpose: a shape surprise in a field Stroq does not read must not fail
 * validation and discard the whole event. On `post` a discarded event is a scan that
 * never runs and a taint that is never set, and the follow-up action then sails
 * through. `sessionId` and `toolName` stay required — an event missing either is
 * malformed, and malformed input is fail-closed, not ignored. The plugin guarantees a
 * non-empty `sessionId` by falling back to a fixed string when OpenClaw's `ctx`
 * carries neither `sessionKey` nor `sessionId`.
 */
export const OpenClawHookInputSchema = z.looseObject({
  sessionId: z.string().min(1),
  toolName: z.string(),
  params: z.unknown().optional(),
  cwd: z.string().default(''),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
  // Carried for the audit trail and for future rules; never read today.
  agentId: z.unknown().optional(),
  runId: z.unknown().optional(),
  toolCallId: z.unknown().optional(),
  toolKind: z.unknown().optional(),
  requester: z.unknown().optional(),
  durationMs: z.unknown().optional(),
});
export type OpenClawHookInput = z.infer<typeof OpenClawHookInputSchema>;

/**
 * Stroq's own JSON, not an imitation of a foreign hook envelope. The only consumer is
 * the plugin in this repository, so there is nothing to imitate — and a machine-
 * readable `ruleId` beside a bare `reason` is what lets the plugin compose the block
 * sentence and the approval title without parsing one apart again.
 */
const asJson = (value: unknown): HookOutput => ({ stdout: JSON.stringify(value), exitCode: 0 });

/** Said out loud, unlike the other adapters' silence: the plugin reads a reply, not an absence. */
export const openclawAllowOutput = (): HookOutput => asJson({ decision: 'allow' });

/** `ruleId` is omitted rather than printed as `null` when the policy had no rule to name. */
export const openclawDecisionOutput = (
  decision: 'deny' | 'ask',
  ruleId: string | null,
  reason: string,
): HookOutput => asJson(ruleId === null ? { decision, reason } : { decision, ruleId, reason });

/**
 * What a `post` scan concluded. `scanned: false` is core declining to scan this tool
 * at all, which the plugin logs differently from a scan that came back clean.
 */
export const openclawScanOutput = (
  scanned: boolean,
  verdict: 'clean' | 'suspect',
  warning: string | null,
): HookOutput => {
  if (!scanned) return asJson({ scanned: false });
  return asJson(
    warning === null ? { scanned: true, verdict } : { scanned: true, verdict, warning },
  );
};

/** A `post` that failed inside Stroq. Exit 0: the tool has already run, there is nothing to block. */
export const openclawPostErrorOutput = (error: string): HookOutput =>
  asJson({ scanned: false, error });

/**
 * The block the plugin honours without parsing stdout: exit code 2, reason on stderr.
 * Used for internal errors on a high-impact `pre`, where the failure is often *why*
 * the JSON path cannot be trusted in the first place.
 */
export const openclawBlockOutput = (reason: string): HookOutput => ({
  stdout: '',
  stderr: reason,
  exitCode: 2,
});

/**
 * `stroq hook openclaw` without a usable phase. Once serialised the event does not
 * name itself, so there is no way to tell a `pre` that must be answered from a `post`
 * that must not, and answering either way would be a decision made on no information.
 */
export const openclawBadPhaseOutput = (arg: string): HookOutput =>
  openclawBlockOutput(
    `Stroq internal error (fail-closed): "stroq hook openclaw" needs a phase argument, ` +
      `"pre" or "post" (got "${arg}"). Re-run "stroq init --agent openclaw" to reinstall the plugin.`,
  );

/**
 * The decision as data. The user-facing sentence ("Stroq blocked this action (rule):
 * …") is composed by the plugin, which is the only thing that knows whether it is
 * writing a `blockReason` or an approval description; the CLI ships the rule id, the
 * policy's own reason and the evidence sentences that explain it.
 */
export function renderDecision(
  decision: Decision,
  provenance: readonly ProvenanceHit[],
  secrets: readonly SecretHit[],
  now: Date = new Date(),
): HookOutput {
  // Narrowed through a local `const` rather than through `decision.effect` directly,
  // so the `'deny' | 'ask'` the output helper wants is a fact the compiler can see.
  const effect = decision.effect;
  if (effect === 'allow') return openclawAllowOutput();
  return openclawDecisionOutput(
    effect,
    decision.ruleId,
    withEvidence(decision.reason, provenance, now, secrets),
  );
}

/**
 * Recorded (and enforced) when a call names more targets than Stroq can classify
 * inside the plugin's hook timeout — the files an `apply_patch` declares or the URLs a
 * `web_fetch` carries, both of which fan out to one `engine.pre` each. A timed-out
 * `before_tool_call` blocks the call on OpenClaw, so this deny is what the timeout
 * would have produced anyway, with a reason attached.
 */
export const OPENCLAW_TOO_MANY_TARGETS: Decision = {
  effect: 'deny',
  ruleId: 'openclaw-too-many-targets',
  reason: `the call names more than ${MAX_PATCH_PATHS} files or URLs, more than Stroq can classify inside the plugin's hook timeout`,
};

/**
 * Recorded (and enforced) when OpenClaw sent something under a shape the adapter could
 * not read a command, a patch, a path or a URL out of. The reason names the top-level
 * KEYS (or the value's type) and never a value: `params` is exactly where a secret
 * would be, and this reason is printed to the agent, logged and audited.
 */
export const openclawUnreadableInput = (shape: string): Decision => ({
  effect: 'deny',
  ruleId: 'openclaw-unreadable-input',
  reason:
    `Stroq could not read the command, patch, path or URL from OpenClaw's params ` +
    `(keys: ${shape}); denied fail-closed. ` +
    'Report the payload shape at https://github.com/AGGIB/Stroq/issues',
});

/**
 * The four kinds whose `params` the adapter reduces to ONE field, and so the four that
 * can lose it: a shell command, a patch body, a written path and a fetched URL.
 * Everything else is either low impact or an MCP call, whose arguments ARE the record
 * and reach the engine whatever shape they arrived in.
 */
const READABLE: Readonly<
  Partial<
    Record<
      OpenClawKind,
      (toolInput: Readonly<Record<string, unknown>>, found: PreCandidates) => boolean
    >
  >
> = {
  shell: (_toolInput, found) => found.commands.length > 0,
  patch: (_toolInput, found) => found.patchPaths.length > 0,
  write: (toolInput) => toolInput['file_path'] !== '',
  fetch: (toolInput) => toolInput['url'] !== '',
};

/**
 * A high-impact call OpenClaw sent arguments for, whose command, patch, path or URL
 * the adapter could not find. Handing the engine the empty action it extracted would
 * classify nothing and allow the call — a `web_fetch` with an empty `url` classifies
 * to `network.fetch` with no host and no secret candidate, which is exactly the
 * fail-open this rule exists to stop — so it is denied instead. An EMPTY `params` is a
 * different thing: there is nothing to act on, and it keeps running through the
 * engine. MCP tools are never this: their arguments are the record itself, which
 * `toolInputRecord` fills whatever shape they arrived in, and the secret guard scans
 * it as it stands.
 */
function unreadableInput(
  input: OpenClawHookInput,
  kind: OpenClawKind,
  toolInput: Readonly<Record<string, unknown>>,
  found: PreCandidates,
): Decision | null {
  const readable = READABLE[kind];
  if (!readable || isEmptyToolInput(input.params)) return null;
  return readable(toolInput, found)
    ? null
    : openclawUnreadableInput(describeToolInput(input.params));
}

function preGuards(
  input: OpenClawHookInput,
  toolInput: Readonly<Record<string, unknown>>,
): PreGuards {
  const kind = openclawToolKind(input.toolName);
  // `file_paths` is populated by `openclawToolInput` for `patch` always and for
  // `write`/`read` whenever a call's path fields disagreed (see `pathsOf`), and `urls`
  // for a `fetch` whose URL fields disagreed (see `urlsOf`), so the fan-out below
  // applies uniformly: `preInputs` judges every candidate and the worst wins.
  const found: PreCandidates = {
    commands: kind === 'shell' ? commandCandidates(input.params) : [],
    patchPaths:
      kind === 'patch' || kind === 'write' || kind === 'read'
        ? asPaths(toolInput['file_paths'])
        : [],
    urls: kind === 'fetch' ? asPaths(toolInput['urls']) : [],
  };
  return { ...found, unreadable: unreadableInput(input, kind, toolInput, found) };
}

/** The guard ordering and the engine loop are shared with the Codex and Copilot adapters. */
const handlePre = (engine: StroqEngine, event: EngineEvent, guards: PreGuards) =>
  decideWithGuards(
    engine,
    event,
    guards,
    {
      tooLarge: OPENCLAW_TOO_MANY_TARGETS,
      unreadableSummary: 'openclaw: unreadable params',
      tooLargeSummary: (count) => `${count} files or URLs`,
    },
    renderDecision,
  );

async function handlePost(
  engine: StroqEngine,
  event: EngineEvent,
  input: OpenClawHookInput,
): Promise<HookOutput> {
  const outcome = await scanPostResult(
    engine,
    event,
    openclawResultText(input.result, input.error),
  );
  return openclawScanOutput(outcome.scanned, outcome.verdict, outcome.warning);
}

/**
 * Coupling to know about: the two adapter-level denies (too many targets, unreadable
 * input) append their audit entry through `auditFile()` inside `denyDirectly` (the
 * engine keeps its own `AuditLog` private), so an engine built at a different home —
 * `createEngineAt`, used only by `stroq attack`, which never routes OpenClaw events —
 * would see those entries land under `STROQ_HOME` instead.
 */
export async function handleOpenClawHook(
  engine: StroqEngine,
  phase: OpenClawPhase,
  raw: unknown,
): Promise<HookOutput> {
  const input = OpenClawHookInputSchema.parse(raw);
  const toolInput = openclawToolInput(input);
  const event: EngineEvent = {
    sessionId: input.sessionId,
    toolName: openclawToolName(input.toolName),
    toolInput,
    // An `exec`'s own `cwd` first, then the directory the plugin resolved (its
    // configured `workspace`, else the Gateway's), then this process's own.
    cwd: openclawExecCwd(input) || input.cwd || process.cwd(),
  };
  if (phase === 'post') return handlePost(engine, event, input);
  return handlePre(engine, event, preGuards(input, toolInput));
}

/**
 * Exit 2 + stderr for a high-impact `pre`; `allow` for a `pre` on a tool that only
 * looks at things; a scan report for `post`. On `post` the tool has already run, so
 * there is nothing to block and stalling the Gateway buys no safety. A missing or
 * non-string `toolName` is malformed input, which is fail-closed exactly like stdin
 * that was not JSON at all — and on OpenClaw it is doubly so, because an unknown name
 * is treated as an MCP call.
 *
 * Symmetric with `handleOpenClawHook`: both default to `pre` for any phase that is
 * not exactly `'post'`. Task 1 review ruling: this used to check `phase !== 'pre'`,
 * the opposite test, so a phase neither `'pre'` nor `'post'` (a caller that skipped
 * validation, or a future phase name) took the `post` branch here — exit 0, nothing
 * blocked — while `handleOpenClawHook` would have treated that same value as `pre`.
 * An internal error on a high-impact tool then failed OPEN on exactly the input that
 * was too malformed to trust in the first place.
 */
export function openclawFailClosedOutput(
  phase: OpenClawPhase,
  raw: unknown,
  err: unknown,
): HookOutput {
  const message = err instanceof Error ? err.message : String(err);
  if (phase === 'post') return openclawPostErrorOutput(`Stroq internal error: ${message}`);
  const record = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const tool = record['toolName'];
  if (typeof tool === 'string' && !isOpenClawHighImpact(tool)) return openclawAllowOutput();
  return openclawBlockOutput(`Stroq internal error (fail-closed): ${message}`);
}
