import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DENIED_COMMAND,
  SAFE_COMMAND,
  SELF_CHECK_AGENTS,
  selfCheck,
  type HookRun,
  type HookRunner,
} from '../../src/commands/init-selfcheck.js';
import { runInterruptCleanups } from '../../src/ui/cleanup.js';
import { envelope, hookRun, said } from '../helpers/hook-runs.js';

describe('selfCheck', () => {
  /** A hook that does what a hook must: allows the harmless action, denies the fetch into a shell. */
  const goodHook =
    (agent: string, ms: [number, number] = [7, 7]): HookRunner =>
    async (_command, stdin) =>
      stdin.includes('curl')
        ? hookRun({ stdout: said(agent, 'deny'), ms: ms[1] })
        : hookRun({ ms: ms[0] });
  /** What the hook is run with, as it is called. */
  interface Call {
    readonly command: string;
    readonly stdin: string;
    readonly env: NodeJS.ProcessEnv;
    readonly cwd: string;
    readonly existedThen: boolean;
  }
  const recording = (inner: HookRunner): { run: HookRunner; calls: Call[] } => {
    const calls: Call[] = [];
    const run: HookRunner = async (command, stdin, env, cwd) => {
      calls.push({ command, stdin, env, cwd, existedThen: existsSync(cwd) });
      return inner(command, stdin, env, cwd);
    };
    return { run, calls };
  };

  describe.each(SELF_CHECK_AGENTS)('for %s', (agent) => {
    it('is ok when the hook allows the harmless action and denies the fetch', async () => {
      const result = await selfCheck(agent, 'the-command', goodHook(agent, [12, 34]));

      expect(result).toEqual({
        ok: true,
        allowed: { verdict: 'allow', detail: '', ms: 12 },
        denied: { verdict: 'deny', detail: '', ms: 34 },
      });
    });

    it('is not ok, and says "said ask", when the hook asks about the harmless action', async () => {
      const run: HookRunner = async (_c, stdin) =>
        stdin.includes('curl')
          ? hookRun({ stdout: said(agent, 'deny') })
          : hookRun({ stdout: said(agent, 'ask') });

      const result = await selfCheck(agent, 'c', run);

      expect(result?.ok).toBe(false);
      expect(result?.allowed).toMatchObject({ verdict: 'ask', detail: 'said ask' });
      expect(result?.denied).toMatchObject({ verdict: 'deny', detail: '' });
    });

    it('is not ok, and says "said allow", when the hook lets the fetch into a shell through', async () => {
      const result = await selfCheck(agent, 'c', async () => hookRun());

      expect(result?.ok).toBe(false);
      expect(result?.allowed).toMatchObject({ verdict: 'allow', detail: '' });
      expect(result?.denied).toMatchObject({ verdict: 'allow', detail: 'said allow' });
    });

    it('is not ok, and says it did not answer in time, when the hook times out', async () => {
      const result = await selfCheck(agent, 'c', async () =>
        hookRun({ timedOut: true, code: null }),
      );

      expect(result?.ok).toBe(false);
      expect(result?.allowed).toMatchObject({
        verdict: 'unreadable',
        detail: 'did not answer in time',
      });
      expect(result?.denied).toMatchObject({
        verdict: 'unreadable',
        detail: 'did not answer in time',
      });
    });

    it('is not ok, and says it did not start, when there is no exit code', async () => {
      const result = await selfCheck(agent, 'c', async () => hookRun({ code: null }));

      expect(result?.ok).toBe(false);
      expect(result?.allowed).toMatchObject({ verdict: 'unreadable', detail: 'did not start' });
      expect(result?.denied).toMatchObject({ verdict: 'unreadable', detail: 'did not start' });
    });

    it('is not ok, and gives the exit code, when the hook fails with something that is no answer', async () => {
      const result = await selfCheck(agent, 'c', async () =>
        hookRun({ stdout: 'Error: cannot find module', code: 1 }),
      );

      expect(result?.ok).toBe(false);
      expect(result?.allowed.detail).toBe('exit 1, and what it printed was not an answer');
      expect(result?.denied.detail).toBe('exit 1, and what it printed was not an answer');
    });

    it('adds the first line the process said on its error stream, which is where the reason is', async () => {
      const result = await selfCheck(agent, 'c', async () =>
        hookRun({
          code: 1,
          stderr:
            '\'\\"node.exe\\"\' is not recognized as an internal or external command\r\nand a second line\r\n',
        }),
      );

      expect(result?.allowed.detail).toBe(
        'exit 1, and what it printed was not an answer: \'\\"node.exe\\"\' is not recognized as an internal or external command',
      );
    });

    it('writes a control character of the error stream out, and cuts a long line', async () => {
      const result = await selfCheck(agent, 'c', async () =>
        hookRun({ code: 1, stderr: `\u001b[31m${'x'.repeat(500)}` }),
      );

      const detail = result?.allowed.detail ?? '';
      expect(detail).not.toContain('\u001b');
      expect(detail).toContain('\\u001b');
      expect(detail.length).toBeLessThan(260);
    });

    it('says nothing of the error stream when it is empty', async () => {
      const result = await selfCheck(agent, 'c', async () =>
        hookRun({ code: 2, stderr: '\n  \n' }),
      );

      expect(result?.allowed.detail).toBe('exit 2, and what it printed was not an answer');
    });

    it('gives the exit code of a command the shell could not find', async () => {
      const result = await selfCheck(agent, 'c', async () => hookRun({ code: 127 }));

      expect(result?.allowed.detail).toBe('exit 127, and what it printed was not an answer');
    });

    it('is not ok when only the allow is wrong, and not ok when only the deny is wrong', async () => {
      const onlyAllowWrong = await selfCheck(agent, 'c', async (_c, stdin) =>
        stdin.includes('curl') ? hookRun({ stdout: said(agent, 'deny') }) : hookRun({ code: 1 }),
      );
      const onlyDenyWrong = await selfCheck(agent, 'c', async (_c, stdin) =>
        stdin.includes('curl') ? hookRun({ stdout: said(agent, 'ask') }) : hookRun(),
      );

      expect(onlyAllowWrong?.ok).toBe(false);
      expect(onlyDenyWrong?.ok).toBe(false);
    });
  });

  it.each(['windsurf', 'copilot', 'openclaw', 'nonsense', '', 'Claude-Code'])(
    'is null for %j, whose event is not known here, and runs nothing',
    async (agent) => {
      const { run, calls } = recording(async () => hookRun());

      const result = await selfCheck(agent, 'the-command', run);

      expect(result).toBeNull();
      expect(calls).toHaveLength(0);
    },
  );

  describe('how it runs the hook', () => {
    it('runs two events, the harmless action first and the fetch into a shell second', async () => {
      const { run, calls } = recording(goodHook('claude-code'));

      await selfCheck('claude-code', 'the-command', run);

      expect(calls).toHaveLength(2);
      expect(JSON.parse(calls[0]?.stdin ?? '').tool_input.command).toBe(SAFE_COMMAND);
      expect(JSON.parse(calls[1]?.stdin ?? '').tool_input.command).toBe(DENIED_COMMAND);
    });

    it('runs both events through the command it was given, unchanged', async () => {
      const command = '"/usr/bin/node" "/opt/stroq/dist/index.js" hook claude-code';
      const { run, calls } = recording(goodHook('claude-code'));

      await selfCheck('claude-code', command, run);

      expect(calls.map((call) => call.command)).toEqual([command, command]);
    });

    it('waits for the first answer before it asks the second, as they share a home', async () => {
      let release: (value: HookRun) => void = () => undefined;
      const first = new Promise<HookRun>((resolve) => {
        release = resolve;
      });
      const { run, calls } = recording(async (_c, stdin) =>
        stdin.includes('curl') ? hookRun({ stdout: envelope('deny') }) : first,
      );

      const pending = selfCheck('claude-code', 'c', run);
      for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
      const startedBeforeAnswer = calls.length;
      release(hookRun());
      await pending;

      expect(startedBeforeAnswer).toBe(1);
      expect(calls).toHaveLength(2);
    });

    it('gives the hook a home of its own, in a directory made for the check', async () => {
      const { run, calls } = recording(goodHook('claude-code'));

      await selfCheck('claude-code', 'c', run);

      const [first, second] = calls;
      expect(first?.cwd).toBe(second?.cwd);
      expect(first?.env['STROQ_HOME']).toBe(second?.env['STROQ_HOME']);
      expect(first?.env['STROQ_HOME']).toBe(join(first?.cwd ?? '', '.stroq'));
      expect(first?.env['STROQ_HOME']).not.toBe(process.env['STROQ_HOME']);
      expect(dirname(first?.cwd ?? '')).toBe(tmpdir());
      expect(basename(first?.cwd ?? '')).toMatch(/^stroq-selftest-/);
    });

    it('tells the agent that directory is the project', async () => {
      const { run, calls } = recording(goodHook('claude-code'));

      await selfCheck('claude-code', 'c', run);

      expect(JSON.parse(calls[0]?.stdin ?? '').cwd).toBe(calls[0]?.cwd);
      expect(JSON.parse(calls[1]?.stdin ?? '').cwd).toBe(calls[1]?.cwd);
    });

    it('keeps the rest of the environment, so that the hook can find node', async () => {
      const { run, calls } = recording(goodHook('claude-code'));

      await selfCheck('claude-code', 'c', run);

      expect(calls[0]?.env['PATH']).toBe(process.env['PATH']);
    });

    // The hook hashes the credential files of the home it is given into its own state, and a check
    // that is cut short leaves that state behind: it is given a home that has none.
    it('gives the hook a home of its own, so that it reads none of the real one', async () => {
      const { run, calls } = recording(goodHook('claude-code'));

      await selfCheck('claude-code', 'c', run);

      expect(calls[0]?.env['HOME']).toBe(calls[0]?.cwd);
      expect(calls[0]?.env['USERPROFILE']).toBe(calls[0]?.cwd);
      expect(calls[0]?.env['HOME']).not.toBe(process.env['HOME']);
    });

    // A signal ends the process without running a `finally`: what the check made is removed first.
    it('removes its directory when the process is interrupted while the hook runs', async () => {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const seen: string[] = [];
      const run: HookRunner = async (_command, _stdin, _env, cwd) => {
        seen.push(cwd);
        await gate;
        return hookRun();
      };

      const pending = selfCheck('claude-code', 'c', run);
      await new Promise((resolve) => setImmediate(resolve));
      const there = existsSync(seen[0] ?? '');
      runInterruptCleanups();
      const after = existsSync(seen[0] ?? '');
      release();
      await pending;

      expect(there).toBe(true);
      expect(after).toBe(false);
    });

    it('has the directory there while the hook runs, and removes it when it is done', async () => {
      const { run, calls } = recording(goodHook('cursor'));

      await selfCheck('cursor', 'c', run);

      expect(calls.every((call) => call.existedThen)).toBe(true);
      expect(existsSync(calls[0]?.cwd ?? '')).toBe(false);
    });

    it('removes with the directory whatever the hook wrote in its home', async () => {
      const { run, calls } = recording(async (_command, _stdin, env) => {
        const home = env['STROQ_HOME'] ?? '';
        mkdirSync(join(home, 'sessions'), { recursive: true });
        writeFileSync(join(home, 'sessions', 'stroq-selftest.json'), '{}');
        return hookRun();
      });

      await selfCheck('claude-code', 'c', run);

      expect(calls[0]?.env['STROQ_HOME']).toBeDefined();
      expect(existsSync(calls[0]?.cwd ?? '')).toBe(false);
    });

    it('removes the directory when the answer is no, too', async () => {
      const { run, calls } = recording(async () => hookRun({ code: null }));

      await selfCheck('claude-code', 'c', run);

      expect(existsSync(calls[0]?.cwd ?? '')).toBe(false);
    });

    it('removes the directory, and passes the error on, when running the hook throws', async () => {
      const { run, calls } = recording(async () => {
        throw new Error('spawn exploded');
      });

      await expect(selfCheck('claude-code', 'c', run)).rejects.toThrow('spawn exploded');
      expect(existsSync(calls[0]?.cwd ?? '')).toBe(false);
    });

    it('uses a new directory for each check', async () => {
      const a = recording(goodHook('claude-code'));
      const b = recording(goodHook('claude-code'));

      await selfCheck('claude-code', 'c', a.run);
      await selfCheck('claude-code', 'c', b.run);

      expect(a.calls[0]?.cwd).not.toBe(b.calls[0]?.cwd);
    });
  });

  describe('what it asks', () => {
    it('is a command that is nothing, and a fetch piped into a shell', () => {
      expect(SAFE_COMMAND).toMatch(/^echo /);
      expect(DENIED_COMMAND).toMatch(/^curl .*\| sh$/);
    });

    it('knows the events of Antigravity, Claude Code, Codex and Cursor, and no others', () => {
      expect([...SELF_CHECK_AGENTS].sort()).toEqual([
        'antigravity',
        'claude-code',
        'codex',
        'cursor',
      ]);
    });
  });
});
