import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOOK_TIMEOUT_SECONDS } from '../../src/commands/config-file.js';
import { runHook } from '../../src/commands/init-selfcheck.js';

/**
 * `runHook` is the part of the self-check that starts a process, the way a host does: the command
 * through a shell, the event on its standard input. These start real, small node processes, and
 * stand a fake clock in for the 15 seconds a hook that never answers would take.
 */
const NODE = `"${process.execPath}"`;
/** A command that runs `script` in node. The script holds no double quote, `$` or backtick. */
const node = (script: string): string => `${NODE} -e "${script}"`;

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stroq-runhook-'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('runHook', () => {
  it('returns what the command printed on each stream, and its exit code', async () => {
    const result = await runHook(
      node("process.stdout.write('out');process.stderr.write('err');process.exit(3)"),
      '',
      process.env,
      dir,
    );

    expect(result).toMatchObject({ stdout: 'out', stderr: 'err', code: 3, timedOut: false });
  });

  it('reports how long it took, in whole milliseconds', async () => {
    const result = await runHook(node('process.exit(0)'), '', process.env, dir);

    expect(Number.isInteger(result.ms)).toBe(true);
    expect(result.ms).toBeGreaterThanOrEqual(0);
  });

  it('gives the event to the command on its standard input', async () => {
    const event = JSON.stringify({ hook_event_name: 'PreToolUse', tool_input: { command: 'ls' } });

    const result = await runHook(
      node('process.stdin.pipe(process.stdout)'),
      event,
      process.env,
      dir,
    );

    expect(result.stdout).toBe(event);
    expect(result.code).toBe(0);
  });

  it('runs the command in the directory it is given', async () => {
    const result = await runHook(node('process.stdout.write(process.cwd())'), '', process.env, dir);

    expect(realpathSync(result.stdout)).toBe(realpathSync(dir));
  });

  it('gives the command the environment it is given', async () => {
    const result = await runHook(
      node("process.stdout.write(process.env.STROQ_HOME||'')"),
      '',
      { ...process.env, STROQ_HOME: join(dir, '.stroq') },
      dir,
    );

    expect(result.stdout).toBe(join(dir, '.stroq'));
  });

  it('runs the command through a shell, as a host does', async () => {
    const both = `${node("process.stdout.write('a')")} && ${node("process.stdout.write('b')")}`;

    const result = await runHook(both, '', process.env, dir);

    expect(result.stdout).toBe('ab');
  });

  it('does not fail when the command exits without reading its input', async () => {
    const big = 'x'.repeat(1_000_000);

    const result = await runHook(node('process.exit(0)'), big, process.env, dir);

    expect(result.code).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it('says there was no exit code when the process could not be started', async () => {
    const result = await runHook(node('process.exit(0)'), '{}', process.env, join(dir, 'missing'));

    expect(result).toMatchObject({ code: null, timedOut: false, stdout: '' });
  });

  it.skipIf(process.platform === 'win32')(
    'gives the exit code the shell does for a command it cannot find',
    async () => {
      const result = await runHook('stroq-no-such-command-for-a-test', '', process.env, dir);

      expect(result.code).toBe(127);
      expect(result.stderr).toContain('stroq-no-such-command-for-a-test');
    },
  );

  // A hook that never stops printing is cut at a megabyte: an answer is a line, and the screen must
  // not be taken down by a string that is too long to hold.
  it('keeps no more than a megabyte of what a command prints, and lets it finish', async () => {
    const result = await runHook(
      node("for(let i=0;i<60;i++)process.stdout.write('x'.repeat(100000))"),
      '',
      process.env,
      dir,
    );

    expect(result.code).toBe(0);
    expect(result.stdout.length).toBe(1 << 20);
  });

  it('keeps what came before the megabyte from each stream on its own', async () => {
    const result = await runHook(
      node("process.stderr.write('e'.repeat(2000000));process.stdout.write('ok')"),
      '',
      process.env,
      dir,
    );

    expect(result.stdout).toBe('ok');
    expect(result.stderr.length).toBe(1 << 20);
  });

  // Killing the shell is not killing what it started: a grandchild that holds the pipe open keeps
  // the run from closing, and the check waited for it for as long as it lived.
  it.skipIf(process.platform === 'win32')(
    'ends what a command started, and does not wait for it, when the time is up',
    async () => {
      const started = performance.now();

      const result = await runHook('sleep 30 & echo started', '', process.env, dir, 300);

      expect(result.timedOut).toBe(true);
      expect(result.stdout).toContain('started');
      expect(performance.now() - started).toBeLessThan(10_000);
    },
  );

  describe('a command that never answers', () => {
    it('is killed when the time is up, and is said to have timed out', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

      const pending = runHook(node('setTimeout(function(){},600000)'), '{}', process.env, dir);
      vi.runOnlyPendingTimers();
      const result = await pending;

      expect(result.timedOut).toBe(true);
      expect(result.code).toBeNull();
    });

    it('is given as long as a host gives a hook: the timeout init writes into the config', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const hostMs = HOOK_TIMEOUT_SECONDS * 1000;

      const pending = runHook(node('setTimeout(function(){},600000)'), '{}', process.env, dir);
      vi.advanceTimersByTime(hostMs - 1);
      const waitingJustBefore = vi.getTimerCount();
      vi.advanceTimersByTime(1);
      const result = await pending;

      expect(waitingJustBefore).toBe(1);
      expect(result.timedOut).toBe(true);
    });

    it('leaves no timer behind when the command answers in time', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

      const result = await runHook(node('process.exit(0)'), '{}', process.env, dir);

      expect(result.timedOut).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
