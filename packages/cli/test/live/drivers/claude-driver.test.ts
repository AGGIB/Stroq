import { realpathSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { claudeArgv } from '../../../src/live/drivers/claude-argv.js';
import { controlOf } from '../../../src/live/probes.js';
import { runProblem } from '../../../src/live/run-problem.js';
import { REASONS } from '../../../src/live/types.js';
import { NONCE } from '../helpers.js';
import { probe } from '../probe-helpers.js';
import { canMakeFakeClaude } from './fake-claude.js';
import {
  ctxFor,
  driverOf,
  fake,
  HOOK_LINE,
  INIT_WITH_KEY,
  lines,
  rig,
  untilDead,
} from './claude-driver-world.js';

/** The Claude driver in an ordinary request: what it asks, what it hands over, and what it stops a host for. */
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
      fake.script([{ lines: lines('noProvider') }]);
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
      fake.script([{ lines: lines('denyBlocked') }]);
      const run = await driverOf().run(probe('deny', NONCE, rig.project), ctxFor());
      const result = run.stream.find((event) => event.type === 'tool_result');
      expect(result).toMatchObject({ isError: true });
      expect(result?.text).toContain('Stroq blocked this action (deny-git-exec)');
    });

    it("hands over the host's own words for a call its permission step stopped, which are not the hook's", async () => {
      fake.script([{ lines: lines('denyControlUnarmed') }]);
      const run = await driverOf().run(
        controlOf(probe('deny', NONCE, rig.project)),
        ctxFor({ hookMode: 'noop' }),
      );
      const result = run.stream.find((event) => event.type === 'tool_result');
      expect(result).toMatchObject({ isError: true });
      expect(result?.text).toBe('This command requires approval');
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
});
