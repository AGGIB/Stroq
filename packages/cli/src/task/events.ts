import type { ClaudeHookInput, HookOutput } from '../adapters/claude-code.js';

/** A lifetime bound on audit-producing events, independent of connection/request sizes. */
export const MAX_TASK_EVENTS = 65_536;

export const TASK_EVENT_LIMIT_REASON =
  'Task Lock: task audit event limit reached; further tools are refused. Start a new task.';

export class TaskEventLimitError extends Error {
  constructor() {
    super(TASK_EVENT_LIMIT_REASON);
  }
}

/** Hook-shaped input can be forged by the child. Keep it from replacing existing observations. */
export function taskEvents(limit = MAX_TASK_EVENTS) {
  const calls = new Map<
    string,
    { readonly tool: string; state: 'pending' | 'allowed' | 'denied' | 'posted' }
  >();
  let count = 0;
  const cap = Math.max(0, Math.min(MAX_TASK_EVENTS, limit));
  return {
    claim(input: ClaudeHookInput): void {
      const id = input.tool_use_id;
      if (count >= cap) throw new TaskEventLimitError();
      if (id === undefined) throw new Error('missing call id');
      if (input.hook_event_name === 'PreToolUse') {
        if (calls.has(id)) throw new Error('duplicate pre event');
        calls.set(id, { tool: input.tool_name, state: 'pending' });
      } else {
        const pre = calls.get(id);
        if (pre?.state !== 'allowed' || pre.tool !== input.tool_name)
          throw new Error('unmatched post event');
        // Reserve synchronously before the async engine call; racing posts cannot both append.
        pre.state = 'posted';
      }
      count += 1;
    },
    complete(input: ClaudeHookInput, output: HookOutput): void {
      if (input.hook_event_name !== 'PreToolUse' || input.tool_use_id === undefined) return;
      const pre = calls.get(input.tool_use_id);
      if (pre !== undefined)
        pre.state = output.stdout === '' && output.exitCode === 0 ? 'allowed' : 'denied';
    },
  };
}
