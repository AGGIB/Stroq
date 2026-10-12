import { describe, expect, it } from 'vitest';
import { runProblem } from '../../../src/live/run-problem.js';
import { type HostRun, REASONS } from '../../../src/live/types.js';
import { NONCE } from '../helpers.js';
import { probe } from '../probe-helpers.js';
import { canMakeFakeClaude } from './fake-claude.js';
import {
  ctxFor,
  driverOf,
  fake,
  lines,
  rig,
  SLOW_START_MS,
  untilDead,
  wait,
} from './claude-driver-world.js';

/** The Claude driver and the process of the host: one that never ends, one that cannot be trusted or started, one that is interrupted. */
describe.skipIf(!canMakeFakeClaude())('the Claude driver', () => {
  describe('a host that does not finish', () => {
    it('is ended at the deadline, with everything it started, and the run says it timed out', async () => {
      fake.script([{ lines: lines('allowRan').slice(0, 4), hang: true }]);
      const run = await driverOf().run(
        probe('allow', NONCE, rig.project),
        ctxFor({ deadlineMs: SLOW_START_MS }),
      );
      expect(run.timedOut).toBe(true);
      expect(run.exitCode).toBeNull();
      expect(runProblem(run)?.reason).toBe(REASONS.timeout);
      const [call] = fake.calls();
      expect(await untilDead(call?.pid ?? 0)).toBe(true);
      const child = fake.grandchildPid();
      expect(child).not.toBeNull();
      expect(await untilDead(child ?? 0)).toBe(true);
    });

    it('is ended with SIGKILL when it will not die of SIGTERM, children included', async () => {
      fake.script([{ lines: lines('allowRan').slice(0, 4), hang: true, ignoreTerm: true }]);
      const run = await driverOf().run(
        probe('allow', NONCE, rig.project),
        ctxFor({ deadlineMs: SLOW_START_MS }),
      );
      expect(run.timedOut).toBe(true);
      expect(await untilDead(fake.calls()[0]?.pid ?? 0)).toBe(true);
      expect(await untilDead(fake.grandchildPid() ?? 0)).toBe(true);
    });

    it('keeps what the host said before the deadline', async () => {
      fake.script([{ lines: lines('allowRan').slice(0, 4), hang: true }]);
      const run = await driverOf().run(
        probe('allow', NONCE, rig.project),
        ctxFor({ deadlineMs: SLOW_START_MS }),
      );
      expect(run.stream.map((event) => event.type)).toEqual(['init', 'tool_use']);
    });
  });

  describe('a stream that cannot be trusted', () => {
    it('counts a line that is not JSON, and the run is not readable', async () => {
      fake.script([
        {
          lines: [
            ...lines('allowRan').slice(0, 2),
            'Segmentation fault',
            ...lines('allowRan').slice(2),
          ],
        },
      ]);
      const run = await driverOf().run(probe('allow', NONCE, rig.project), ctxFor());
      expect(run.unparsedLines).toBe(1);
      expect(runProblem(run)?.reason).toBe(REASONS.unparsableStream);
    });

    it('reads a last line that has no newline', async () => {
      const all = lines('allowRan');
      fake.script([{ lines: all.slice(0, -1), raw: [all[all.length - 1] ?? ''] }]);
      const run = await driverOf().run(probe('allow', NONCE, rig.project), ctxFor());
      expect(run.stream[run.stream.length - 1]?.type).toBe('result');
      expect(run.unparsedLines).toBe(0);
    });

    it('stops a host that prints without end, and does not trust what it printed', async () => {
      fake.script([{ flood: true }]);
      const run = await driverOf({ limits: { maxChars: 500_000, maxLineChars: 200_000 } }).run(
        probe('allow', NONCE, rig.project),
        ctxFor(),
      );
      expect(run.unparsedLines).toBeGreaterThan(0);
      expect(run.exitCode).toBeNull();
      expect(await untilDead(fake.calls()[0]?.pid ?? 0)).toBe(true);
    });
  });

  describe('a host that cannot be started', () => {
    it('is a run that did not get to the end, with the reason, and not a throw', async () => {
      const run = await driverOf({ bin: `${fake.dir}/no-such-claude` }).run(
        probe('allow', NONCE, rig.project),
        ctxFor(),
      );
      expect(run).toMatchObject({ exitCode: null, timedOut: false, stream: [] });
      expect(run.stderrTail).toMatch(/could not start/);
      expect(runProblem(run)?.reason).toBe(REASONS.hostError);
    });

    it('is the same when the directory to run in is not there', async () => {
      const run = await driverOf().run(
        probe('allow', NONCE, rig.project),
        ctxFor({ project: `${rig.root}/gone` }),
      );
      expect(run.exitCode).toBeNull();
      expect(run.stderrTail).toMatch(/could not start/);
    });

    it('is the same when starting the program throws', async () => {
      const run = await driverOf({
        spawn: () => {
          throw new Error('EMFILE: too many open files');
        },
      }).run(probe('allow', NONCE, rig.project), ctxFor());
      expect(run).toMatchObject({ exitCode: null, timedOut: false, stream: [] });
      expect(run.stderrTail).toMatch(/could not start/);
    });

    it('does not start the host on Windows', async () => {
      const run = await driverOf({ platform: 'win32' }).run(
        probe('allow', NONCE, rig.project),
        ctxFor(),
      );
      expect(run.exitCode).toBeNull();
      expect(run.stderrTail).toMatch(/Windows/);
      expect(fake.calls()).toEqual([]);
    });
  });

  describe('a check that is interrupted', () => {
    it('kills the host and everything it started, at once, and returns the run', async () => {
      fake.script([{ lines: lines('allowRan').slice(0, 4), hang: true }]);
      const controller = new AbortController();
      const pending = driverOf({ signal: controller.signal }).run(
        probe('allow', NONCE, rig.project),
        ctxFor({ deadlineMs: 60_000 }),
      );
      // The host has started, and has a child of its own, when the check is interrupted.
      for (let tries = 0; tries < 400 && fake.grandchildPid() === null; tries += 1) await wait(25);
      controller.abort();
      const run: HostRun = await pending;
      expect(run.timedOut).toBe(false);
      expect(run.exitCode).toBeNull();
      expect(await untilDead(fake.calls()[0]?.pid ?? 0)).toBe(true);
      expect(await untilDead(fake.grandchildPid() ?? 0)).toBe(true);
    });

    it('does not start the host at all when the check was interrupted before the request', async () => {
      const controller = new AbortController();
      controller.abort();
      const run = await driverOf({ signal: controller.signal }).run(
        probe('allow', NONCE, rig.project),
        ctxFor(),
      );
      expect(run.exitCode).toBeNull();
      expect(fake.calls()).toEqual([]);
    });
  });

  describe('a control run', () => {
    it('is started as the real run is started, but for the command of the hook', async () => {
      fake.script([{ lines: lines('egressBlocked') }, { lines: lines('egressControl') }]);
      const driver = driverOf();
      await driver.run(probe('secret-egress', NONCE, rig.project), ctxFor());
      await driver.run(
        probe('secret-egress', NONCE, rig.project),
        ctxFor({ hookMode: 'noop', sessionId: '99999999-2222-4333-8444-555555555555' }),
      );
      const [real, control] = fake.calls();
      const settingsOf = (argv: readonly string[] | undefined): string =>
        argv?.[(argv ?? []).indexOf('--settings') + 1] ?? '';
      expect(JSON.parse(settingsOf(control?.argv)) as unknown).toEqual({
        hooks: {
          PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'node -e 0' }] }],
        },
      });
      expect(real?.env).toEqual(control?.env);
      expect(real?.cwd).toBe(control?.cwd);
    });
  });
});
