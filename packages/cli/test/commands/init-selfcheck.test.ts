import { describe, expect, it } from 'vitest';
import { HOOK_AGENTS, hookCommand } from '../../src/commands/init.js';
import {
  SELF_CHECK_AGENTS,
  eventFor,
  runHook,
  runHookAsCmd,
  selfCheck,
  verdictOf,
} from '../../src/commands/init-selfcheck.js';
import { tmpdir } from 'node:os';
import { CLI_ENTRY } from '../helpers/cli-entry.js';
import { antigravityAnswer, cursorAnswer, envelope, hookRun, said } from '../helpers/hook-runs.js';

describe('eventFor', () => {
  it('writes the event Claude Code sends before a shell command', () => {
    const event = JSON.parse(eventFor('claude-code', 'ls -la', '/proj'));

    expect(event).toEqual({
      session_id: 'stroq-selftest',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls -la' },
      cwd: '/proj',
    });
  });

  it('writes the event Codex sends, with the identifiers it adds', () => {
    const event = JSON.parse(eventFor('codex', 'ls -la', '/proj'));

    expect(event).toEqual({
      session_id: 'stroq-selftest',
      cwd: '/proj',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls -la' },
      tool_use_id: 'stroq-selftest',
      turn_id: 'stroq-selftest',
    });
  });

  it('writes the event Cursor sends before a shell command', () => {
    const event = JSON.parse(eventFor('cursor', 'ls -la', '/proj'));

    expect(event).toEqual({
      conversation_id: 'stroq-selftest',
      generation_id: 'stroq-selftest',
      workspace_roots: ['/proj'],
      cwd: '/proj',
      hook_event_name: 'beforeShellExecution',
      command: 'ls -la',
    });
  });

  it('writes the event Antigravity sends before a shell command', () => {
    const event = JSON.parse(eventFor('antigravity', 'ls -la', '/proj'));

    expect(event).toEqual({
      conversationId: 'stroq-selftest',
      toolCall: { name: 'run_command', args: { CommandLine: 'ls -la', Cwd: '/proj' } },
      workspacePaths: ['/proj'],
    });
  });

  it.each(SELF_CHECK_AGENTS)('is JSON for %s that carries the command and the project', (agent) => {
    const text = eventFor(agent, 'echo hello', '/some/project');

    expect(() => JSON.parse(text)).not.toThrow();
    expect(text).toContain('echo hello');
    expect(text).toContain('/some/project');
  });

  it.each(SELF_CHECK_AGENTS)(
    'keeps a command with quotes, newlines and backslashes for %s',
    (agent) => {
      const command = 'echo "a\\b" \'c\'\n$HOME `x`  ';

      const text = eventFor(agent, command, '/p');

      expect(text).toContain(JSON.stringify(command).slice(1, -1));
      expect(text.includes('\n')).toBe(false);
    },
  );

  it('names its session so that it cannot be mistaken for a real one', () => {
    for (const agent of SELF_CHECK_AGENTS)
      expect(eventFor(agent, 'x', '/p')).toContain('stroq-selftest');
  });

  it('writes a different event for each agent', () => {
    const events = SELF_CHECK_AGENTS.map((agent) => eventFor(agent, 'x', '/p'));

    expect(new Set(events).size).toBe(SELF_CHECK_AGENTS.length);
  });
});

describe('verdictOf', () => {
  describe.each(['claude-code', 'codex'])('for %s', (agent) => {
    it.each(['allow', 'deny', 'ask'] as const)('reads a %s in the envelope', (decision) => {
      expect(verdictOf(agent, hookRun({ stdout: envelope(decision) }))).toBe(decision);
    });

    it('reads an envelope that is newline-terminated, as a hook prints it', () => {
      expect(verdictOf(agent, hookRun({ stdout: `${envelope('deny')}\n` }))).toBe('deny');
    });

    it('does not read a decision it does not know', () => {
      expect(verdictOf(agent, hookRun({ stdout: envelope('maybe') }))).toBe('unreadable');
    });

    it('does not read an envelope with no decision in it', () => {
      expect(verdictOf(agent, hookRun({ stdout: '{"hookSpecificOutput":{}}' }))).toBe('unreadable');
      expect(verdictOf(agent, hookRun({ stdout: '{}' }))).toBe('unreadable');
    });

    it('does not read a decision that is not inside the envelope', () => {
      expect(verdictOf(agent, hookRun({ stdout: '{"permissionDecision":"deny"}' }))).toBe(
        'unreadable',
      );
    });

    it('does not read what Cursor says', () => {
      expect(verdictOf(agent, hookRun({ stdout: cursorAnswer('deny') }))).toBe('unreadable');
    });
  });

  describe('for cursor', () => {
    it.each(['allow', 'deny', 'ask'] as const)('reads a %s in the permission', (decision) => {
      expect(verdictOf('cursor', hookRun({ stdout: cursorAnswer(decision) }))).toBe(decision);
    });

    it('does not read a permission it does not know', () => {
      expect(verdictOf('cursor', hookRun({ stdout: cursorAnswer('maybe') }))).toBe('unreadable');
    });

    it('does not read what Claude Code and Codex are told', () => {
      expect(verdictOf('cursor', hookRun({ stdout: envelope('deny') }))).toBe('unreadable');
    });
  });

  describe('for antigravity', () => {
    it('reads a deny and an ask at the top of what it prints', () => {
      expect(verdictOf('antigravity', hookRun({ stdout: antigravityAnswer('deny') }))).toBe('deny');
      expect(verdictOf('antigravity', hookRun({ stdout: antigravityAnswer('ask') }))).toBe('ask');
    });

    it('takes nothing printed, and exit 0, for an allow, as that agent does', () => {
      expect(verdictOf('antigravity', hookRun({ stdout: antigravityAnswer('allow') }))).toBe(
        'allow',
      );
    });

    it('does not read a decision it does not know, nor the words of another agent', () => {
      expect(verdictOf('antigravity', hookRun({ stdout: '{"decision":"maybe"}' }))).toBe(
        'unreadable',
      );
      expect(verdictOf('antigravity', hookRun({ stdout: '{"decision":"allow"}' }))).toBe(
        'unreadable',
      );
      expect(verdictOf('antigravity', hookRun({ stdout: envelope('deny') }))).toBe('unreadable');
      expect(verdictOf('antigravity', hookRun({ stdout: cursorAnswer('deny') }))).toBe(
        'unreadable',
      );
    });

    it('is not what the other agents read', () => {
      expect(verdictOf('claude-code', hookRun({ stdout: antigravityAnswer('deny') }))).toBe(
        'unreadable',
      );
      expect(verdictOf('cursor', hookRun({ stdout: antigravityAnswer('deny') }))).toBe(
        'unreadable',
      );
    });
  });

  describe.each(SELF_CHECK_AGENTS)('for %s, whatever it says', (agent) => {
    it('takes nothing printed, and exit 0, for an allow', () => {
      expect(verdictOf(agent, hookRun({ stdout: '', code: 0 }))).toBe('allow');
      expect(verdictOf(agent, hookRun({ stdout: '  \n', code: 0 }))).toBe('allow');
    });

    it('does not take nothing printed, and a failing exit, for an answer', () => {
      expect(verdictOf(agent, hookRun({ stdout: '', code: 1 }))).toBe('unreadable');
      expect(verdictOf(agent, hookRun({ stdout: '', code: 2 }))).toBe('unreadable');
      expect(verdictOf(agent, hookRun({ stdout: '', code: 127 }))).toBe('unreadable');
    });

    it('does not read a hook that never exited', () => {
      expect(verdictOf(agent, hookRun({ code: null }))).toBe('unreadable');
    });

    it('does not read a hook that timed out, whatever it had printed', () => {
      expect(verdictOf(agent, hookRun({ timedOut: true, code: null }))).toBe('unreadable');
      expect(verdictOf(agent, hookRun({ timedOut: true, stdout: said(agent, 'allow') }))).toBe(
        'unreadable',
      );
    });

    it('does not read what is not JSON', () => {
      expect(verdictOf(agent, hookRun({ stdout: 'Error: cannot find module', code: 1 }))).toBe(
        'unreadable',
      );
      expect(verdictOf(agent, hookRun({ stdout: '{"permission":' }))).toBe('unreadable');
    });

    it.each(['null', '[]', '"allow"', '42', 'true'])('does not read the JSON %s', (stdout) => {
      expect(verdictOf(agent, hookRun({ stdout }))).toBe('unreadable');
    });
  });
});

describe('selfCheck for antigravity', () => {
  it('runs the line with the phase argument init writes after it, for both events', async () => {
    const lines: string[] = [];

    const result = await selfCheck(
      'antigravity',
      'node entry.js hook antigravity',
      async (line) => {
        lines.push(line);
        return hookRun({ stdout: lines.length === 1 ? '' : antigravityAnswer('deny') });
      },
    );

    expect(lines).toEqual([
      'node entry.js hook antigravity pre',
      'node entry.js hook antigravity pre',
    ]);
    expect(result?.ok).toBe(true);
  });

  it('does not add the phase for an agent that has none', async () => {
    const lines: string[] = [];

    await selfCheck('cursor', 'node entry.js hook cursor', async (line) => {
      lines.push(line);
      return hookRun({ stdout: '' });
    });

    expect(lines[0]).toBe('node entry.js hook cursor');
  });

  it('says a hook that did not start did not start', async () => {
    const result = await selfCheck('antigravity', 'x', async () => hookRun({ code: null }));

    expect(result?.ok).toBe(false);
    expect(result?.allowed.detail).toBe('did not start');
  });
});

describe('runHookAsCmd', () => {
  it.skipIf(process.platform === 'win32')(
    'reports a hook that did not start, and does not throw, where there is no cmd.exe',
    async () => {
      const run = await runHookAsCmd('echo hi', '', process.env, tmpdir());

      expect(run.code).toBeNull();
    },
  );
});

describe('selfCheck against the built CLI', () => {
  const installable = HOOK_AGENTS.filter((agent) => SELF_CHECK_AGENTS.includes(agent));

  it('can check every agent that init can install', () => {
    expect(installable).toHaveLength(SELF_CHECK_AGENTS.length);
  });

  it.each(installable)(
    '%s: the command init writes allows a harmless action and denies a fetch into a shell',
    async (agent) => {
      // Through a shell on every machine: what the adapters answer is the same, and the quoted line is not the
      // line that Windows hosts which go through cmd.exe are given (`hook-command.windows.test.ts` has those).
      const result = await selfCheck(
        agent,
        hookCommand(process.execPath, CLI_ENTRY, agent),
        runHook,
      );

      expect(result?.ok).toBe(true);
      expect(result?.allowed.verdict).toBe('allow');
      expect(result?.denied.verdict).toBe('deny');
      expect(result?.allowed.detail).toBe('');
      expect(result?.denied.detail).toBe('');
    },
    60_000,
  );

  it('says it did not pass, and why, for a command that starts nothing', async () => {
    const result = await selfCheck('claude-code', 'stroq-no-such-command-for-a-test');

    expect(result?.ok).toBe(false);
    expect(result?.allowed.verdict).toBe('unreadable');
    // What the shell said on its error stream goes after it: that is where the reason is.
    expect(result?.allowed.detail).toMatch(
      /^exit \d+, and what it printed was not an answer(?:: .+)?$/,
    );
  }, 60_000);
});
