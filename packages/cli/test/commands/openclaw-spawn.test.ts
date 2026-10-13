import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  runOpenClawInstall,
  spawnCommand,
  type RunCommand,
} from '../../src/commands/openclaw-plugin.js';
import { runInterruptCleanups } from '../../src/ui/cleanup.js';

/**
 * The commands of the Gateway's CLI are waited for without holding the process. A fifth review found
 * that waiting for them in a call that does not return (`spawnSync`) kept every signal from the
 * handlers of the screen that was drawn: Ctrl-C and `kill` were dropped at the end of the step, an
 * install that was cut off went on to the next command, and a CLI that never answered held `init` for good.
 */

const node = process.execPath;

afterEach(() => {
  vi.useRealTimers();
});

describe('spawnCommand', () => {
  it('returns the status and what the command printed on both streams', async () => {
    const run = await spawnCommand(node, [
      '-e',
      "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)",
    ]);

    expect(run.status).toBe(3);
    expect(run.output).toContain('out');
    expect(run.output).toContain('err');
  });

  it('gives the command no input to wait for: it is closed', async () => {
    const run = await spawnCommand(node, [
      '-e',
      "process.stdin.on('data', () => {}); process.stdin.on('end', () => console.log('closed'))",
    ]);

    expect(run.output).toContain('closed');
    expect(run.status).toBe(0);
  });

  it('says what could not be started, and is not a success', async () => {
    const run = await spawnCommand('/no/such/openclaw', ['plugins', 'enable', 'stroq']);

    expect(run.status).toBeNull();
    expect(run.output).toContain('ENOENT');
  });

  it('keeps no more of what a command prints than a megabyte', async () => {
    const run = await spawnCommand(node, [
      '-e',
      "process.stdout.write('x'.repeat(3 * 1024 * 1024))",
    ]);

    expect(run.output.length).toBeLessThanOrEqual(1024 * 1024);
    expect(run.output.length).toBeGreaterThan(1000);
  });

  it('returns to the event loop while the command runs, so that a signal can be answered', async () => {
    const ticks: string[] = [];
    const pending = spawnCommand(node, ['-e', 'setTimeout(() => {}, 400)']);
    const timer = setInterval(() => ticks.push('the loop turned'), 20);

    await pending;
    clearInterval(timer);

    expect(ticks.length).toBeGreaterThan(3);
  });

  it('is killed with the process when the process is interrupted', async () => {
    const pending = spawnCommand(node, ['-e', 'setTimeout(() => {}, 60000)']);
    await new Promise((resolve) => setTimeout(resolve, 300));

    runInterruptCleanups();
    const run = await pending;

    expect(run.status).toBeNull();
  }, 20_000);

  it('is ended after two minutes, and does not wait for a command that does not answer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = spawnCommand(node, ['-e', 'setTimeout(() => {}, 600000)']);

    await vi.advanceTimersByTimeAsync(119_000);
    let finished = false;
    void pending.then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);

    await vi.advanceTimersByTimeAsync(2_000);
    const run = await pending;

    expect(run.status).toBeNull();
    expect(run.output).toContain('(stopped after 120 s)');
  });
});

/** Whether a process is there. */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Waits, in real time, for `until` to be true. */
async function waitFor(until: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!until() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 25));
}

// The sixth review: only the command was killed, and what it had started outlived it; a command that
// exited but left a process holding its pipes was waited for to the end of the time it was given; and an
// interrupt gave it no time to finish what it was writing.
describe.skipIf(process.platform === 'win32')('spawnCommand, what the command started', () => {
  it('ends what the command started, with it, where the process is interrupted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stroq-spawn-group-'));
    const file = join(dir, 'pid');
    const pending = spawnCommand(node, [
      '-e',
      `const { spawn } = require('node:child_process');
       const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
       require('node:fs').writeFileSync(${JSON.stringify(file)}, String(g.pid));
       setTimeout(() => {}, 60000);`,
    ]);
    await waitFor(() => existsSync(file));
    const grandchild = Number(readFileSync(file, 'utf8'));
    expect(alive(grandchild)).toBe(true);

    runInterruptCleanups();
    await pending;
    await waitFor(() => !alive(grandchild));

    expect(alive(grandchild)).toBe(false);
  }, 20_000);

  it('lets the command finish what it is writing: it is asked to stop, and not killed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stroq-spawn-term-'));
    const ready = join(dir, 'ready');
    const done = join(dir, 'done');
    const pending = spawnCommand(node, [
      '-e',
      `const fs = require('node:fs');
       process.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(done)}, 'finished'); process.exit(0); });
       fs.writeFileSync(${JSON.stringify(ready)}, 'up');
       setTimeout(() => {}, 60000);`,
    ]);
    await waitFor(() => existsSync(ready));

    runInterruptCleanups();
    const run = await pending;
    await waitFor(() => existsSync(done));

    expect(readFileSync(done, 'utf8')).toBe('finished');
    expect(run.status).toBe(0);
  }, 20_000);

  it('does not wait for a process that a command that has exited left holding its output', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stroq-spawn-drain-'));
    const file = join(dir, 'pid');
    const started = Date.now();

    const run = await spawnCommand(node, [
      '-e',
      `const { spawn } = require('node:child_process');
       const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: ['ignore', 'inherit', 'inherit'], detached: true });
       require('node:fs').writeFileSync(${JSON.stringify(file)}, String(g.pid));
       g.unref();
       console.log('installed');`,
    ]);
    const waited = Date.now() - started;
    const left = Number(readFileSync(file, 'utf8'));
    try {
      expect(run.status).toBe(0);
      expect(run.output).toContain('installed');
      expect(waited).toBeLessThan(8_000);
      expect(run.output).not.toContain('stopped after');
    } finally {
      process.kill(left, 'SIGKILL');
    }
  }, 30_000);
});

describe('runOpenClawInstall', () => {
  it('waits for each command before it starts the next, whatever the first came to', async () => {
    const order: string[] = [];
    const run: RunCommand = async (_file, args) => {
      order.push(`start ${args[1]}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push(`end ${args[1]}`);
      return { status: args[1] === 'install' ? 1 : 0, output: '' };
    };

    const outcomes = await runOpenClawInstall('/usr/bin/openclaw', '/w/plugin', run);

    expect(order).toEqual(['start install', 'end install', 'start enable', 'end enable']);
    expect(outcomes.map((outcome) => outcome.ok)).toEqual([false, true]);
  });
});
