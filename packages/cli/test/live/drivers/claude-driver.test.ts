import { realpathSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createClaudeDriver } from '../../../src/live/drivers/claude.js';
import { claudeArgv } from '../../../src/live/drivers/claude-argv.js';
import { controlOf } from '../../../src/live/probes.js';
import { runProblem } from '../../../src/live/run-problem.js';
import { REASONS, type HostDriver, type HostRun } from '../../../src/live/types.js';
import { NONCE, SESSION } from '../helpers.js';
import { probe } from '../probe-helpers.js';
import { makeRig, type Rig } from '../rig.js';
import { canMakeFakeClaude, isAlive, makeFakeClaude, type FakeClaude } from './fake-claude.js';
import { STREAMS, linesOf, readFixture, withProvider } from './fixtures.js';

/**
 * The driver against a program that stands in for `claude`: a real process with an argv, an environment, a
 * working directory and pipes, which prints what the cleaned real streams say (and misbehaves on demand).
 * The real `claude` is never started here.
 */
const HOOK_LINE = '"/usr/local/bin/node" "/opt/stroq/dist/index.js" hook claude-code';

let rig: Rig;
let fake: FakeClaude;
beforeEach(() => {
  rig = makeRig(false);
  fake = makeFakeClaude();
});
afterEach(() => {
  fake.cleanup();
  rig.cleanup();
});

const driverOf = (over: Partial<Parameters<typeof createClaudeDriver>[0]> = {}): HostDriver =>
  createClaudeDriver({ hookLine: HOOK_LINE, bin: fake.bin, killGraceMs: 200, ...over });

/** The env a driver is given by `verifyHost`: nothing of the caller's but what the host needs. */
const ENV = { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: '/home/someone', LANG: 'C' };

const ctxFor = (over: Parameters<Rig['ctx']>[0] = {}): ReturnType<Rig['ctx']> =>
  rig.ctx({ sessionId: SESSION, nonce: NONCE, env: ENV, deadlineMs: 20_000, ...over });

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The deadline of a request in a test of a host that never ends. It has to be long enough for the stand-in to
 * start, print and start a child of its own on a machine that is busy (a process of Node takes a second or two
 * to start then), and it is what a test of the deadline waits for in full.
 */
const SLOW_START_MS = 3_000;

async function untilDead(pid: number): Promise<boolean> {
  for (let tries = 0; tries < 200; tries += 1) {
    if (!isAlive(pid)) return true;
    await wait(25);
  }
  return false;
}

const lines = (stream: keyof typeof STREAMS, provider = true): string[] =>
  linesOf(
    provider
      ? withProvider(readFixture(STREAMS[stream]), 'firstParty')
      : readFixture(STREAMS[stream]),
  );

const INIT_WITH_KEY = (source: string): string =>
  JSON.stringify({ type: 'system', subtype: 'init', cwd: '/project', apiKeySource: source });
const MORE = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'DONE',
});

describe.skipIf(!canMakeFakeClaude())('the Claude driver', () => {
  describe('what it is', () => {
    it('says it is a driver of a real host', () => {
      expect(driverOf().mode).toBe('live');
    });
  });

  describe('detect', () => {
    it('asks the host for its version and gives the number', async () => {
      fake.script({ behaviours: [{}], version: '2.1.271 (Claude Code)' });
      expect(await driverOf().detect()).toEqual({ available: true, version: '2.1.271' });
      expect(fake.versionCalls()).toBe(1);
    });

    it('does not start the host, only asks its version', async () => {
      await driverOf().detect();
      expect(fake.calls()).toEqual([]);
    });

    it('says a program that is not there is not there, and why', async () => {
      const found = await driverOf({ bin: `${fake.dir}/no-such-claude` }).detect();
      expect(found.available).toBe(false);
      expect(found.version).toBeNull();
      expect(found.note).toMatch(/not found|could not start/);
    });

    it('says the host is not there when it answers with an error', async () => {
      fake.script({ behaviours: [{}], versionExit: 1 });
      const found = await driverOf().detect();
      expect(found.available).toBe(false);
      expect(found.note).toBeDefined();
    });

    it.each(['hello', '', 'command not found', '   '])(
      'does not take %j for the version of Claude Code',
      async (printed) => {
        fake.script({ behaviours: [{}], version: printed });
        const found = await driverOf().detect();
        expect(found.available).toBe(false);
        expect(found.version).toBeNull();
      },
    );

    it('gives up on a host that does not answer', async () => {
      fake.script({ behaviours: [{}], versionHangs: true });
      const found = await driverOf({ detectTimeoutMs: 300 }).detect();
      expect(found.available).toBe(false);
      expect(found.note).toMatch(/did not answer/);
    });

    it('says the check does not run on Windows yet, without asking the host', async () => {
      const found = await driverOf({ platform: 'win32' }).detect();
      expect(found).toEqual({
        available: false,
        version: null,
        note: expect.stringContaining('Windows') as string,
      });
      expect(fake.versionCalls()).toBe(0);
    });
  });

  describe('a request that goes as it should', () => {
    it('hands over the stream, the exit, and how the host is paid for', async () => {
      fake.script([{ lines: lines('allowRan') }]);
      const run = await driverOf().run(probe('allow', NONCE, rig.project), ctxFor());
      expect(run).toMatchObject({
        exitCode: 0,
        timedOut: false,
        stderrTail: '',
        apiKeySource: 'none',
        apiProvider: 'firstParty',
        cwd: '/tmp/stroq-live-fixture/project',
        unparsedLines: 0,
      });
      expect(run.stream.map((event) => event.type)).toEqual([
        'init',
        'tool_use',
        'tool_result',
        'text',
        'result',
      ]);
      expect(run.limitHit).toBeUndefined();
      expect(runProblem(run)).toBeNull();
    });

    it('says nothing of the provider for a host that does not name it', async () => {
      fake.script([{ lines: lines('allowRan', false) }]);
      const run = await driverOf().run(probe('allow', NONCE, rig.project), ctxFor());
      expect('apiProvider' in run).toBe(false);
    });

    it('starts the host with the argv, in the project, with the environment it was given', async () => {
      fake.script([{ lines: lines('allowRan') }]);
      const p = probe('allow', NONCE, rig.project);
      const ctx = ctxFor();
      await driverOf().run(p, ctx);
      const [call] = fake.calls();
      expect(call?.argv).toEqual(claudeArgv(p, ctx, HOOK_LINE));
      expect(realpathSync(call?.cwd ?? '')).toBe(realpathSync(rig.project));
      const given = Object.entries(ctx.env);
      for (const [name, value] of given) expect(call?.env[name], name).toBe(value);
      // Nothing of the test process's own environment reaches the host but what it was handed.
      const extra = Object.keys(call?.env ?? {}).filter((name) => !(name in ctx.env));
      expect(
        extra.filter((name) => !/^(__CF_USER_TEXT_ENCODING|PWD|OLDPWD|SHLVL|_)$/.test(name)),
      ).toEqual([]);
    });

    it('puts the line of the user, with the throwaway homes in front of it, in the settings', async () => {
      fake.script([{ lines: lines('allowRan') }]);
      await driverOf().run(probe('allow', NONCE, rig.project), ctxFor());
      const argv = fake.calls()[0]?.argv ?? [];
      const settings = JSON.parse(argv[argv.indexOf('--settings') + 1] ?? '') as {
        hooks: { PreToolUse: { hooks: { command: string }[] }[] };
      };
      expect(settings.hooks.PreToolUse[0]?.hooks[0]?.command).toBe(
        `env HOME=${rig.home} USERPROFILE=${rig.home} STROQ_HOME=${rig.stroqHome} ${HOOK_LINE}`,
      );
    });

    it('does not read stdin of the host from the terminal of the caller', async () => {
      fake.script([{ lines: lines('allowRan') }]);
      const run = await driverOf().run(probe('allow', NONCE, rig.project), ctxFor());
      expect(run.exitCode).toBe(0);
    });

    it('hands over the words the hook gave for a call it denied', async () => {
      fake.script([{ lines: lines('egressBlocked') }]);
      const run = await driverOf().run(probe('secret-egress', NONCE, rig.project), ctxFor());
      const result = run.stream.find((event) => event.type === 'tool_result');
      expect(result).toMatchObject({ isError: true });
      expect(result?.text).toContain('Stroq blocked this action (deny-secret-egress)');
    });

    it("hands over the host's own words for a call its permission step stopped, which are not the hook's", async () => {
      fake.script([{ lines: lines('denyControl') }]);
      const run = await driverOf().run(
        controlOf(probe('deny', NONCE, rig.project)),
        ctxFor({ hookMode: 'noop' }),
      );
      const result = run.stream.find((event) => event.type === 'tool_result');
      expect(result).toMatchObject({ isError: true });
      expect(result?.text).toMatch(/^This Bash command contains multiple operations/);
      expect(result?.text).not.toContain('Stroq blocked this action');
    });

    it('hands over the host exit code when it is not 0', async () => {
      fake.script([{ lines: lines('allowRan'), exit: 3 }]);
      const run = await driverOf().run(probe('allow', NONCE, rig.project), ctxFor());
      expect(run.exitCode).toBe(3);
      expect(runProblem(run)?.reason).toBe(REASONS.hostError);
    });

    it('keeps the end of what the host said on its error stream, and no more than 4 KiB of it', async () => {
      const noise = `${'a'.repeat(100_000)}THE END`;
      fake.script([{ lines: lines('allowRan'), stderr: noise }]);
      const run = await driverOf().run(probe('allow', NONCE, rig.project), ctxFor());
      expect(run.stderrTail.length).toBeLessThanOrEqual(4096);
      expect(run.stderrTail.endsWith('THE END')).toBe(true);
    });
  });

  describe('a host that is paid for by something that was not set aside', () => {
    it.each(['user', 'project', 'org', 'temporary', 'ANTHROPIC_API_KEY', 'something-new'])(
      'is stopped at its first message when it says its key source is %j',
      async (source) => {
        fake.script([
          {
            lines: [INIT_WITH_KEY(source), ...lines('allowRan').slice(1)],
            pauseAfterFirstLineMs: 3000,
          },
        ]);
        const run = await driverOf().run(probe('allow', NONCE, rig.project), ctxFor());
        expect(run.apiKeySource).toBe(source);
        expect(run.stream).toEqual([{ type: 'init' }]);
        expect(run.timedOut).toBe(false);
        expect(runProblem(run)?.reason).toBe(REASONS.apiBilling);
        const pid = fake.calls()[0]?.pid ?? 0;
        // It was killed before it printed more, and not left to finish what it had started.
        expect(await untilDead(pid)).toBe(true);
        expect(fake.printedMore()).toBe(false);
      },
    );

    it('is stopped when the first message does not say how it is paid for', async () => {
      fake.script([
        {
          lines: [
            JSON.stringify({ type: 'system', subtype: 'init', cwd: '/project' }),
            ...lines('allowRan').slice(1),
          ],
          pauseAfterFirstLineMs: 3000,
        },
      ]);
      const run = await driverOf().run(probe('allow', NONCE, rig.project), ctxFor());
      expect(run.stream).toEqual([{ type: 'init' }]);
      expect('apiKeySource' in run).toBe(false);
      expect(await untilDead(fake.calls()[0]?.pid ?? 0)).toBe(true);
      expect(fake.printedMore()).toBe(false);
    });

    it('is let go on when the key source is a login', async () => {
      fake.script([{ lines: lines('allowRan') }]);
      const run = await driverOf().run(probe('allow', NONCE, rig.project), ctxFor());
      expect(run.apiKeySource).toBe('none');
      expect(run.stream.length).toBeGreaterThan(1);
    });
  });

  describe('a subscription that runs out or moves on to extra usage', () => {
    const rateEvent = (info: Record<string, unknown>): string =>
      JSON.stringify({ type: 'rate_limit_event', rate_limit_info: info });

    it('stops the host the moment it uses extra usage, and says so in the words of the host', async () => {
      const [first] = lines('allowRan');
      // The host has nothing more to say and does not end: only a stop from the driver ends this run before
      // its deadline, which is what `timedOut: false` shows.
      fake.script([
        {
          lines: [
            first ?? '',
            rateEvent({ status: 'allowed', isUsingOverage: true, overageStatus: 'allowed' }),
          ],
          hang: true,
        },
      ]);
      const run = await driverOf().run(probe('allow', NONCE, rig.project), ctxFor());
      expect(run.timedOut).toBe(false);
      expect(run.limitHit).toMatch(/overage/i);
      expect(run.stream).toEqual([{ type: 'init' }]);
      expect(runProblem(run)?.reason).toBe(REASONS.limit);
      expect(await untilDead(fake.calls()[0]?.pid ?? 0)).toBe(true);
    });

    it('stops the host when the plan has a status that is not one that goes on', async () => {
      const [first, ...rest] = lines('allowRan');
      fake.script([
        {
          lines: [
            first ?? '',
            rateEvent({ status: 'rejected', rateLimitType: 'five_hour' }),
            ...rest,
          ],
        },
      ]);
      const run = await driverOf().run(probe('allow', NONCE, rig.project), ctxFor());
      expect(run.limitHit).toMatch(/rejected/);
      expect(runProblem(run)?.reason).toBe(REASONS.limit);
    });

    it('lets a plan that warns go on', async () => {
      const [first, ...rest] = lines('allowRan');
      fake.script([{ lines: [first ?? '', rateEvent({ status: 'allowed_warning' }), ...rest] }]);
      const run = await driverOf().run(probe('allow', NONCE, rig.project), ctxFor());
      expect(run.limitHit).toBeUndefined();
      expect(runProblem(run)).toBeNull();
    });
  });

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
