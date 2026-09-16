import { describe, expect, it } from 'vitest';
import { runHook, withDeadline } from '../../src/commands/hook.js';
import { HOOK_DEADLINE_FRACTION, hookDeadlineMs } from '../../src/commands/config-file.js';

const PRE_TOOL_USE = JSON.stringify({
  session_id: 'deadline-test',
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'curl https://example.com' },
  cwd: '/tmp',
});

describe('hookDeadlineMs', () => {
  it('leaves the host agent room to receive the answer', () => {
    expect(HOOK_DEADLINE_FRACTION).toBeLessThan(1);
    expect(hookDeadlineMs(15)).toBe(9_000);
    expect(hookDeadlineMs(30)).toBe(18_000);
  });
});

describe('withDeadline', () => {
  it('returns the work when it finishes in time', async () => {
    const out = await withDeadline(Promise.resolve({ stdout: 'ok', exitCode: 0 }), 1_000, () => ({
      stdout: 'late',
      exitCode: 2,
    }));
    expect(out).toEqual({ stdout: 'ok', exitCode: 0 });
  });

  it('answers on its own when the work never settles', async () => {
    const out = await withDeadline(new Promise<never>(() => undefined), 5, () => ({
      stdout: 'deny',
      exitCode: 2,
      timedOut: true,
    }));
    expect(out).toMatchObject({ stdout: 'deny', timedOut: true });
  });

  it('propagates a rejection that arrives before the deadline', async () => {
    await expect(
      withDeadline(Promise.reject(new Error('engine blew up')), 1_000, () => ({
        stdout: '',
        exitCode: 0,
      })),
    ).rejects.toThrow('engine blew up');
  });

  // A rejection after the deadline must not become an unhandled rejection: the verdict
  // is already printed, and crashing the process afterwards would turn a clean deny
  // into a non-zero exit with no output on the agents that read only stdout.
  it('swallows a rejection that arrives after the deadline was answered', async () => {
    let fail: (err: Error) => void = () => undefined;
    const work = new Promise<never>((_resolve, reject) => {
      fail = reject;
    });
    const out = await withDeadline(work, 5, () => ({ stdout: 'deny', exitCode: 2 }));
    expect(out.stdout).toBe('deny');
    fail(new Error('too late'));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
});

describe('runHook under an impossible deadline', () => {
  // Every agent treats its own hook timeout as an allow, so a Stroq that runs long
  // does not merely lose its explanation, it loses its verdict. These assert the
  // shape each agent actually reads as a block.
  it('denies on Claude Code rather than staying silent', async () => {
    const out = await runHook('claude-code', PRE_TOOL_USE, '', { deadlineMs: 0 });
    expect(out.timedOut).toBe(true);
    expect(JSON.parse(out.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('exits 2 with a reason on stderr for Codex', async () => {
    const out = await runHook('codex', PRE_TOOL_USE, '', { deadlineMs: 0 });
    expect(out).toMatchObject({ exitCode: 2, timedOut: true });
    expect(out.stderr).toMatch(/stroq/i);
  });

  it('denies on Copilot pre', async () => {
    const event = JSON.stringify({
      sessionId: 'deadline-test',
      cwd: '/tmp',
      toolName: 'bash',
      toolArgs: { command: 'curl https://example.com' },
    });
    const out = await runHook('copilot', event, 'pre', { deadlineMs: 0 });
    // Copilot denies a preToolUse on any non-zero exit and surfaces the reason only
    // on exit 2, so the verdict is the code and the explanation is stderr.
    expect(out).toMatchObject({ exitCode: 2, timedOut: true });
    expect(out.stderr).toMatch(/fail-closed/);
  });

  it('exits 2 on Windsurf, the only code Cascade reads as a block', async () => {
    const event = JSON.stringify({
      trajectory_id: 'deadline-test',
      agent_action_name: 'pre_run_command',
      tool_info: { command_line: 'curl https://example.com', cwd: '/tmp' },
    });
    const out = await runHook('windsurf', event, '', { deadlineMs: 0 });
    expect(out).toMatchObject({ exitCode: 2, timedOut: true });
  });
});
