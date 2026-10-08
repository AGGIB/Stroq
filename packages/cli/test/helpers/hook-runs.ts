import type { HookRun } from '../../src/commands/init-selfcheck.js';

/** What a hook run came to: by default, it printed nothing and exited 0, in 7 ms. */
export const hookRun = (overrides: Partial<HookRun> = {}): HookRun => ({
  stdout: '',
  stderr: '',
  code: 0,
  timedOut: false,
  ms: 7,
  ...overrides,
});

/** What Claude Code and Codex read: the decision inside the envelope. */
export const envelope = (decision: string): string =>
  JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision },
  });

/** What Cursor reads: the permission at the top. */
export const cursorAnswer = (permission: string): string => JSON.stringify({ permission });

/** What Antigravity reads: a decision at the top for a deny and an ask, and nothing at all for an allow. */
export const antigravityAnswer = (decision: string): string =>
  decision === 'allow'
    ? ''
    : JSON.stringify({ decision: decision === 'ask' ? 'force_ask' : decision, reason: 'Stroq' });

/** The words a hook says `decision` in, for `agent`. */
export const said = (agent: string, decision: string): string =>
  agent === 'cursor'
    ? cursorAnswer(decision)
    : agent === 'antigravity'
      ? antigravityAnswer(decision)
      : envelope(decision);
