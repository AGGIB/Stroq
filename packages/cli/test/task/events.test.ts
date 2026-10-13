import { expect, it } from 'vitest';
import { taskEvents } from '../../src/task/events.js';

it('admits more than 512 complete tool calls with the default lifetime bound', () => {
  const events = taskEvents();
  for (let i = 0; i < 600; i += 1) {
    const pre = {
      hook_event_name: 'PreToolUse' as const,
      session_id: 'event-capacity',
      cwd: '/project',
      tool_name: 'Read',
      tool_use_id: `call-${i}`,
      tool_input: { file_path: 'src/a.ts' },
    };
    expect(() => events.claim(pre)).not.toThrow();
    events.complete(pre, { stdout: '', exitCode: 0 });
    expect(() =>
      events.claim({ ...pre, hook_event_name: 'PostToolUse', tool_response: 'ok' }),
    ).not.toThrow();
  }
});
