import { warningFor, type StroqEngine } from '@stroq/core';
import { z } from 'zod';

export const ClaudeHookInputSchema = z.looseObject({
  session_id: z.string().min(1),
  hook_event_name: z.enum(['PreToolUse', 'PostToolUse']),
  tool_name: z.string().min(1),
  tool_input: z.record(z.string(), z.unknown()).default({}),
  cwd: z.string().default(''),
  tool_result: z.unknown().optional(),
});
export type ClaudeHookInput = z.infer<typeof ClaudeHookInputSchema>;

export const HIGH_IMPACT_TOOL = /^(Bash|Write|Edit|MultiEdit|NotebookEdit|mcp__)/;
const MAX_RESULT_CHARS = 200_000;

export interface HookOutput {
  readonly stdout: string;
  readonly exitCode: number;
}

export const NO_OUTPUT: HookOutput = { stdout: '', exitCode: 0 };

export function toolResultToText(result: unknown): string {
  if (typeof result === 'string') return result.slice(0, MAX_RESULT_CHARS);
  if (Array.isArray(result))
    return result.map(toolResultToText).join('\n').slice(0, MAX_RESULT_CHARS);
  if (result && typeof result === 'object') {
    const obj = result as Record<string, unknown>;
    if (typeof obj['text'] === 'string') return obj['text'].slice(0, MAX_RESULT_CHARS);
    if (Array.isArray(obj['content'])) return toolResultToText(obj['content']);
    return JSON.stringify(obj).slice(0, MAX_RESULT_CHARS);
  }
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
    toolResultText: toolResultToText(input.tool_result),
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
