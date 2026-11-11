import { describe, expect, it } from 'vitest';
import {
  CLAUDE_CODE_FAIL_CLOSED as CLI_FAIL_CLOSED,
  hookCommand,
} from '../../packages/cli/src/commands/hook-command';
import { CLAUDE_CODE_FAIL_CLOSED, hookLine } from '../scripts/hook-line.mjs';

// The console writes and compares the line `stroq init` writes; the two must be one line.
describe('the hook line the console writes', () => {
  it('is the line stroq init writes, for every agent the console connects', () => {
    expect(CLAUDE_CODE_FAIL_CLOSED).toBe(CLI_FAIL_CLOSED);
    for (const agent of ['claude-code', 'cursor', 'codex'])
      expect(hookLine('/usr/bin/node', '/opt/stroq/dist/index.js', agent), agent).toBe(
        hookCommand('/usr/bin/node', '/opt/stroq/dist/index.js', agent),
      );
  });
});
