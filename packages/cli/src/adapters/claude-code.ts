import {
  describeEvidence,
  describeSecretHit,
  toEvidence,
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
  session_id: z.string().min(1),
  hook_event_name: z.enum(['PreToolUse', 'PostToolUse']),
  tool_name: z.string().min(1),
  tool_input: z.record(z.string(), z.unknown()).default({}),
  cwd: z.string().default(''),
  tool_result: z.unknown().optional(),
  // Real Claude Code (v2.1.226) sends the tool output as `tool_response`;
  // `tool_result` is kept as a fallback for other agents/older payloads.
  tool_response: z.unknown().optional(),
});
export type ClaudeHookInput = z.infer<typeof ClaudeHookInputSchema>;
/** The shape a recorded event has before parsing (defaults still optional); used by `stroq attack` scenarios. */
export type ClaudeHookEvent = z.input<typeof ClaudeHookInputSchema>;

export const HIGH_IMPACT_TOOL = /^(Bash|Write|Edit|MultiEdit|NotebookEdit|WebFetch|mcp__)/;
const MAX_RESULT_CHARS = 200_000;

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

function postOutput(fields: Readonly<Record<string, unknown>>): HookOutput {
  return {
    stdout: JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PostToolUse', ...fields },
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

function objectToText(obj: Record<string, unknown>): string {
  if (typeof obj['text'] === 'string') return obj['text'];
  const file = fileContentOf(obj);
  if (file !== null) return file;
  const streams = streamsOf(obj);
  if (streams !== null) return streams;
  if (Array.isArray(obj['content'])) return toolResultToText(obj['content']);
  return JSON.stringify(obj);
}

export function toolResultToText(result: unknown): string {
  if (typeof result === 'string') return clip(result);
  if (Array.isArray(result)) return clip(result.map(toolResultToText).join('\n'));
  if (result && typeof result === 'object')
    return clip(objectToText(result as Record<string, unknown>));
  return result === undefined || result === null ? '' : String(result);
}

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

export async function handleClaudeHook(engine: StroqEngine, raw: unknown): Promise<HookOutput> {
  const input = ClaudeHookInputSchema.parse(raw);
  const cwd = input.cwd || process.cwd();
  const base = {
    sessionId: input.session_id,
    toolName: input.tool_name,
    toolInput: input.tool_input,
    cwd,
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
  const result = await engine.post({
    ...base,
    toolResultText: toolResultToText(input.tool_response ?? input.tool_result),
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
  if (result.scan.verdict !== 'suspect') {
    return Object.keys(atoms).length === 0
      ? NO_OUTPUT
      : postOutput({ classifierContext: { stroq } });
  }
  return postOutput({
    additionalContext: warningFor(result.scan, input.tool_name),
    classifierContext: { stroq },
  });
}

export function failClosedOutput(raw: unknown, err: unknown): HookOutput {
  const record = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const toolName = typeof record['tool_name'] === 'string' ? record['tool_name'] : '';
  if (record['hook_event_name'] !== 'PreToolUse' || !HIGH_IMPACT_TOOL.test(toolName))
    return NO_OUTPUT;
  const message = err instanceof Error ? err.message : String(err);
  return denyOutput(`Stroq internal error (fail-closed): ${message}`);
}
