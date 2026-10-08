import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { selfCheck, type HookRun, type HookRunner } from '../../src/commands/init-selfcheck.js';
import { onInterrupt, runInterruptCleanups } from '../../src/ui/cleanup.js';

/**
 * What the fifth review found in the check that `stroq init` runs: an interrupt removed the directory
 * of the check before it killed the hook that was writing into it, and a directory that could not be
 * removed (a process that went on writing) turned an answer that was good into "could not be checked".
 */

const ANSWER = (verdict: 'allow' | 'deny'): HookRun => ({
  stdout:
    verdict === 'allow'
      ? ''
      : JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny' } }),
  stderr: '',
  code: 0,
  timedOut: false,
  ms: 3,
});

describe('an interrupt of the check', () => {
  it('kills the hook before it removes the directory the hook writes into', async () => {
    const order: string[] = [];
    let home = '';
    let release: () => void = () => undefined;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run: HookRunner = async (_command, _stdin, env) => {
      home = env['HOME'] ?? '';
      // What `runHook` does: a way to kill the hook, registered while it runs.
      onInterrupt(() => {
        order.push(
          existsSync(home) ? 'the hook is killed, the directory is there' : 'the directory is gone',
        );
      });
      await waiting;
      return ANSWER('allow');
    };

    const pending = selfCheck('claude-code', 'a hook', run);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(existsSync(home)).toBe(true);

    runInterruptCleanups();
    order.push(existsSync(home) ? 'the directory is still there' : 'then the directory is removed');
    release();
    await pending;

    expect(order).toEqual([
      'the hook is killed, the directory is there',
      'then the directory is removed',
    ]);
  });
});

describe('a directory of the check that cannot be removed', () => {
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'does not lose the answer, and does not throw',
    async () => {
      const locked: string[] = [];
      let calls = 0;
      const run: HookRunner = async (_command, _stdin, env) => {
        calls += 1;
        const home = env['HOME'] as string;
        if (calls === 1) {
          const inside = join(home, 'locked');
          mkdirSync(inside);
          writeFileSync(join(inside, 'file'), 'what a process that is still writing leaves');
          // A directory that cannot be emptied: removing it fails.
          chmodSync(inside, 0o500);
          locked.push(inside);
        }
        return ANSWER(calls === 1 ? 'allow' : 'deny');
      };

      const result = await selfCheck('claude-code', 'a hook', run);

      expect(result).not.toBeNull();
      expect(result?.allowed.verdict).toBe('allow');
      expect(result?.denied.verdict).toBe('deny');
      expect(result?.ok).toBe(true);

      // What is left is the system's to clear: this test clears it.
      for (const inside of locked) {
        chmodSync(inside, 0o700);
        rmSync(join(inside, '..'), { recursive: true, force: true });
      }
    },
  );

  it('is removed once the check is over, where nothing holds it', async () => {
    let home = '';
    const run: HookRunner = async (_command, _stdin, env) => {
      home = env['HOME'] ?? '';
      return ANSWER('allow');
    };

    await selfCheck('claude-code', 'a hook', run);

    expect(home).toContain('stroq-selftest-');
    expect(existsSync(home)).toBe(false);
  });
});
