import { AuditLog, type Decision, type StroqEngine } from '@stroq/core';
import { auditFile } from '../paths.js';
import type { HookOutput } from './claude-code.js';

/** The subset of a hook event every adapter hands the engine. */
export interface EngineEvent {
  readonly sessionId: string;
  readonly toolName: string;
  readonly toolInput: Record<string, unknown>;
  readonly cwd: string;
}

/**
 * The most a single call may fan out to before Stroq stops classifying it item by
 * item. Beyond this, the sequential `engine.pre` calls risk running past the agent's
 * hook timeout — and a timed-out hook fails open on both Codex and Copilot, which is
 * exactly the outcome a ten-thousand-file patch would be crafted to produce.
 */
export const MAX_PATCH_PATHS = 64;

/** Everything one `PreToolUse` payload could have to be judged on separately. */
export interface PreCandidates {
  /** Every command spelling a shell call carried; empty for any other tool. */
  readonly commands: readonly string[];
  readonly patchPaths: readonly string[];
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
