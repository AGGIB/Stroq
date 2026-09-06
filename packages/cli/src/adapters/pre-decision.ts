import {
  AuditLog,
  warningFor,
  type Decision,
  type ProvenanceHit,
  type SecretHit,
  type StroqEngine,
} from '@stroq/core';
import { logError } from '../log.js';
import { auditFile } from '../paths.js';
import { NO_OUTPUT, type HookOutput } from './claude-code.js';

/** The subset of a hook event every adapter hands the engine. */
export interface EngineEvent {
  readonly sessionId: string;
  readonly toolName: string;
  readonly toolInput: Record<string, unknown>;
  readonly cwd: string;
}

/**
 * The most a single call may fan out to before Stroq stops classifying it item by
 * item — the files a patch declares, the paths a file tool names, the URLs a fetch
 * carries. Beyond this, the sequential `engine.pre` calls risk running past the
 * agent's hook timeout — and a timed-out hook fails open on both Codex and Copilot,
 * which is exactly the outcome a ten-thousand-target payload would be crafted to
 * produce. The name is historical (patches were the first list); it bounds them all.
 */
export const MAX_PATCH_PATHS = 64;

/** Everything one `PreToolUse` payload could have to be judged on separately. */
export interface PreCandidates {
  /** Every command spelling a shell call carried; empty for any other tool. */
  readonly commands: readonly string[];
  readonly patchPaths: readonly string[];
  /** Every URL a fetch carried when its fields disagreed; empty for any other tool. */
  readonly urls: readonly string[];
}

/** `PreCandidates` plus whatever made the call impossible to classify at all. */
export interface PreGuards extends PreCandidates {
  readonly unreadable: Decision | null;
}

/**
 * Every string in an array-shaped value — the shape a patch's paths, and a file
 * tool's disagreeing path fields, both arrive in under `toolInput['file_paths']`.
 */
export const asPaths = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((p): p is string => typeof p === 'string') : [];

/**
 * One `toolInput` per thing that has to be classified on its own: every file a patch
 * declares, or every field a shell command could have arrived in. The ordinary
 * single-value case is one call with the record untouched, so a normal payload still
 * produces exactly one engine call and one audit entry.
 */
export function preInputs(
  toolInput: Readonly<Record<string, unknown>>,
  candidates: PreCandidates,
): Record<string, unknown>[] {
  if (candidates.commands.length > 1)
    return candidates.commands.map((command) => ({ ...toolInput, command }));
  if (candidates.patchPaths.length > 1)
    return candidates.patchPaths.map((file_path) => ({ ...toolInput, file_path }));
  if (candidates.urls.length > 1) return candidates.urls.map((url) => ({ ...toolInput, url }));
  return [{ ...toolInput }];
}

/** deny beats ask beats allow: a call is only as safe as its worst path or field. */
const SEVERITY: Readonly<Record<Decision['effect'], number>> = { allow: 0, ask: 1, deny: 2 };

/**
 * Sequential on purpose: the session store is file-locked and the audit log is a
 * hash chain, so the calls cannot overlap — and the order they run in is the order
 * `stroq log` will show the patch's paths. `inputs` is always non-empty in practice —
 * `preInputs` never returns `[]` — the guard exists only to give `first` a real
 * (non-`undefined`) type under `noUncheckedIndexedAccess` without a silent fallback.
 */
export async function decidePre(
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

/**
 * An audited deny the engine never made: recorded here so `stroq log`/`why` still
 * explain it. Shared by Codex and Copilot, whose own `renderDecision` differ (Codex's
 * envelope and ask-as-deny wording vs Copilot's top-level object and real `ask`), so
 * the caller supplies its own renderer rather than this module picking one.
 */
export async function denyDirectly(
  event: EngineEvent,
  decision: Decision,
  summary: string,
  render: (decision: Decision) => HookOutput,
): Promise<HookOutput> {
  await new AuditLog(auditFile()).append({
    sessionId: event.sessionId,
    phase: 'pre',
    tool: event.toolName,
    summary,
    classes: [],
    decision,
  });
  return render(decision);
}

/** How one adapter renders a decision; the two differ in envelope and in ask wording. */
export type RenderDecision = (
  decision: Decision,
  provenance: readonly ProvenanceHit[],
  secrets: readonly SecretHit[],
) => HookOutput;

/** The two adapter-level denies, named by the adapter that records them. */
export interface GuardDenials {
  /** The decision an over-long fan-out gets; its rule id names the agent. */
  readonly tooLarge: Decision;
  /** The audit summary for an unreadable payload, e.g. `codex: unreadable tool_input`. */
  readonly unreadableSummary: string;
  /** That deny's audit summary, given the length of the list that tripped the bound. */
  readonly tooLargeSummary: (count: number) => string;
}

/**
 * The longest list this call would fan out over. Every list is bounded, not just a
 * patch's paths: a `web_fetch` carrying an array of URLs fans out exactly the same
 * way, and `{ url: [5000 URLs] }` is 5000 sequential `engine.pre` calls and 5000
 * audit entries — well past any hook timeout, and a timed-out Copilot hook is an
 * ALLOW. (`commands` is bounded by the number of field spellings and can never trip
 * this; it is counted anyway so no future candidate list can be added unbounded.)
 */
const fanOutSize = (guards: PreCandidates): number =>
  Math.max(guards.commands.length, guards.patchPaths.length, guards.urls.length);

/**
 * The whole `pre` answer, in the order it has to happen: a payload the adapter could
 * not read at all is denied before anything else (there is no action to classify), an
 * oversized patch next (classifying it is what would run past the hook timeout), and
 * only then the engine, once per candidate with the worst decision winning.
 *
 * ONE implementation on purpose. Codex and Copilot ran near-identical copies of this
 * ordering, and the two drifting apart is a bypass that reproduces on one agent only —
 * the same reason their command, argv and patch readers are shared rather than copied.
 */
export async function decideWithGuards(
  engine: StroqEngine,
  event: EngineEvent,
  guards: PreGuards,
  denials: GuardDenials,
  render: RenderDecision,
): Promise<HookOutput> {
  const deny = (decision: Decision) => render(decision, [], []);
  if (guards.unreadable)
    return denyDirectly(event, guards.unreadable, denials.unreadableSummary, deny);
  const fanOut = fanOutSize(guards);
  if (fanOut > MAX_PATCH_PATHS)
    return denyDirectly(event, denials.tooLarge, denials.tooLargeSummary(fanOut), deny);
  const { decision, provenance, secrets } = await decidePre(
    engine,
    event,
    preInputs(event.toolInput, guards),
  );
  return render(decision, provenance, secrets);
}

/**
 * The whole `post` answer: scan the result text, then say nothing unless the scan came
 * back suspect. Shared for the same reason as `decideWithGuards`; the adapters differ
 * only in how they read the result text and how they wrap the warning.
 */
export async function handlePostResult(
  engine: StroqEngine,
  event: EngineEvent,
  toolResultText: string,
  wrap: (context: string) => HookOutput,
): Promise<HookOutput> {
  const result = await engine.post({ ...event, toolResultText });
  if (result.provenanceError) logError('provenance', result.provenanceError);
  if (!result.scanned || result.scan.verdict !== 'suspect') return NO_OUTPUT;
  return wrap(warningFor(result.scan, event.toolName));
}
