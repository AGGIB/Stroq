import { warningFor, type StroqEngine } from '@stroq/core';
import { z } from 'zod';

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

export const HIGH_IMPACT_TOOL = /^(Bash|Write|Edit|MultiEdit|NotebookEdit|mcp__)/;
const MAX_RESULT_CHARS = 200_000;

export interface HookOutput {
  readonly stdout: string;
  readonly exitCode: number;
}

export const NO_OUTPUT: HookOutput = { stdout: '', exitCode: 0 };

const clip = (s: string): string => s.slice(0, MAX_RESULT_CHARS);

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
    const { decision } = await engine.pre(base);
    if (decision.effect === 'deny')
      return denyOutput(`Stroq blocked this action (${decision.ruleId}): ${decision.reason}`);
    if (decision.effect === 'ask')
      return askOutput(`Stroq: ${decision.reason} (${decision.ruleId})`);
    return NO_OUTPUT;
  }
  const result = await engine.post({
    ...base,
    toolResultText: toolResultToText(input.tool_response ?? input.tool_result),
  });
  if (!result.scanned || result.scan.verdict !== 'suspect') return NO_OUTPUT;
  const ruleIds = [...new Set(result.scan.matches.map((m) => m.ruleId))];
  return {
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: warningFor(result.scan, input.tool_name),
        classifierContext: {
          stroq: { verdict: result.scan.verdict, score: result.scan.score, ruleIds },
        },
      },
    }),
    exitCode: 0,
  };
}

export function failClosedOutput(raw: unknown, err: unknown): HookOutput {
  const record = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const toolName = typeof record['tool_name'] === 'string' ? record['tool_name'] : '';
  if (record['hook_event_name'] !== 'PreToolUse' || !HIGH_IMPACT_TOOL.test(toolName))
    return NO_OUTPUT;
  const message = err instanceof Error ? err.message : String(err);
  return denyOutput(`Stroq internal error (fail-closed): ${message}`);
}
