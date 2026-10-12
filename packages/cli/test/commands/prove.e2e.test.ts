import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLAUDE_BIN_ENV } from '../../src/live/drivers/index.js';
import { readHostResult } from '../../src/live/store.js';
import { CLI_ENTRY } from '../helpers/cli-entry.js';
import {
  canMakeFakeClaude,
  isAlive,
  makeFakeClaude,
  makeFakeTools,
  type Behaviour,
  type FakeClaude,
  type FakeTools,
} from '../live/drivers/fake-claude.js';
import { STREAMS, replayOf } from '../live/drivers/fixtures.js';

/**
 * `stroq prove` as a person runs it: the built CLI as a process of its own, with `STROQ_CLAUDE_BIN` naming a
 * stand-in for `claude` (a program that runs the hook line it is given and obeys it). What this shows is
 * that the pieces are joined in the artifact: the command is registered, the driver is found by the
 * environment, the hook line is the one the built CLI writes, the exit code and the JSON are what they
 * are said to be, a signal removes the folder and the host, and nothing is left. The real `claude` is
 * never started.
 */
let temp: string;
let fake: FakeClaude;
let tools: FakeTools;

beforeEach(() => {
  // A short path: the commands of the probes hold the path of the folder the check runs in.
  temp = mkdtempSync(join(tmpdir(), 'p-'));
  fake = makeFakeClaude();
  // `curl` fails the way an unresolvable host does, and `git` leaves what `git config --file` leaves.
  tools = canMakeFakeClaude() ? makeFakeTools() : { dir: '', cleanup: () => undefined };
  mkdirSync(join(temp, 'home'));
});

afterEach(() => {
  fake.cleanup();
  rmSync(temp, { recursive: true, force: true });
  tools.cleanup();
});

const envOf = (): NodeJS.ProcessEnv => ({
  ...process.env,
  HOME: join(temp, 'home'),
  USERPROFILE: join(temp, 'home'),
  STROQ_HOME: join(temp, 'stroq-home'),
  TMPDIR: temp,
  PATH: `${tools.dir}:${process.env['PATH'] ?? '/usr/bin:/bin'}`,
  [CLAUDE_BIN_ENV]: fake.bin,
  STROQ_LIVE_LEDGER: '',
});

const prove = (...args: string[]) =>
  spawnSync(process.execPath, [CLI_ENTRY, 'prove', ...args], {
    env: envOf(),
    encoding: 'utf8',
    input: '',
    timeout: 120_000,
  });

const behave = (emulate: NonNullable<Behaviour['emulate']>): void => fake.script([{ emulate }]);

const leftBehind = (): string[] =>
  readdirSync(temp).filter((name) => name.startsWith('stroq-prove-'));

describe.skipIf(!canMakeFakeClaude())(
  'stroq prove, the built CLI, against a stand-in for claude',
  () => {
    it('verifies a host that obeys the hook: exit 0, one JSON document, the result kept, nothing left', () => {
      behave({ permissionStep: true });
      const ran = prove('--yes', '--json');
      expect(ran.status, ran.stderr).toBe(0);
      const report = JSON.parse(ran.stdout) as Record<string, unknown>;
      expect(report).toMatchObject({
        version: 1,
        agent: 'claude-code',
        hostVersion: '2.1.271',
        state: 'verified',
        mode: 'live',
        requestsMade: 3,
      });
      expect(fake.calls()).toHaveLength(3);
      const stored = readHostResult(join(temp, 'stroq-home'), 'claude-code');
      expect(stored.result).toMatchObject({ state: 'verified', mode: 'live' });
      expect(leftBehind()).toEqual([]);
    });

    it('says VERIFIED in words, and what that shows and does not show', () => {
      behave({ permissionStep: true });
      const ran = prove('--yes');
      expect(ran.status).toBe(0);
      expect(ran.stdout).toMatch(/VERIFIED/);
      expect(ran.stdout.replace(/\s+/g, ' ')).toMatch(
        /does not show that your own settings file is loaded/,
      );
    });

    it('verifies a host whose real 2.1.271 streams are played back: allow, deny, deny control, in three requests', () => {
      // The shape of the real run: what the host printed is what it printed, and the real hook judges the call.
      fake.script([
        replayOf(STREAMS.allowRan),
        replayOf(STREAMS.denyBlocked),
        replayOf(STREAMS.denyControl),
      ]);
      const ran = prove('--yes');
      expect(ran.status, ran.stderr).toBe(0);
      const text = ran.stdout.replace(/\s+/g, ' ');
      expect(text).toMatch(/VERIFIED/);
      expect(text).toContain('Requests made: 3');
      expect(text).toMatch(/allow \(echo to a file\) passed ran, as the policy allows/);
      expect(text).toMatch(
        /deny \(git config key that runs a program\) passed stopped by the hook/,
      );
      expect(text).toMatch(/same, hook out of the way passed ran with the hook out of the way/);
      expect(text).toMatch(/secret egress \(curl, made-up key\) not attempted/);
      expect(text).toContain(
        'Proved by: allow (echo to a file) and deny (git config key that runs a program) with its control run.',
      );
      expect(fake.calls()).toHaveLength(3);
      expect(leftBehind()).toEqual([]);
    });

    it('fails a host that runs what the hook denied: exit 1', () => {
      behave({ ignoreDeny: true, permissionStep: true });
      const ran = prove('--yes', '--json');
      expect(ran.status).toBe(1);
      expect(JSON.parse(ran.stdout)).toMatchObject({ state: 'failed', mode: 'live' });
      expect(readHostResult(join(temp, 'stroq-home'), 'claude-code').result?.state).toBe('failed');
    });

    it('stops a host that is paid for by an API key before anything is run: exit 3, one request', () => {
      behave({ apiKeySource: 'user', pauseAfterInitMs: 8_000 });
      const ran = prove('--yes', '--json');
      expect(ran.status).toBe(3);
      expect(fake.calls()).toHaveLength(1);
      expect(JSON.parse(ran.stdout)).toMatchObject({ requestsMade: 1 });
      expect(leftBehind()).toEqual([]);
    });

    it('asks nothing of the host on a dry run, and writes nothing', () => {
      const ran = prove('--dry-run');
      expect(ran.status).toBe(0);
      expect(fake.calls()).toEqual([]);
      expect(existsSync(join(temp, 'stroq-home'))).toBe(false);
    });

    it('refuses to spend without --yes where nobody can answer: exit 2', () => {
      const ran = prove();
      expect(ran.status).toBe(2);
      expect(ran.stderr).toContain('--yes');
      expect(fake.calls()).toEqual([]);
    });

    it('says the host is not there when it is not: exit 3', () => {
      const ran = spawnSync(process.execPath, [CLI_ENTRY, 'prove', '--yes'], {
        env: { ...envOf(), [CLAUDE_BIN_ENV]: join(temp, 'no-such-claude') },
        encoding: 'utf8',
        input: '',
      });
      expect(ran.status).toBe(3);
      expect(ran.stdout).toMatch(/NOT RUN/);
    });

    it('is interrupted by Ctrl-C: the host is killed, the folder is gone, and it ends by the signal', async () => {
      behave({ pauseAfterInitMs: 60_000 });
      const child = spawn(process.execPath, [CLI_ENTRY, 'prove', '--yes'], {
        env: envOf(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => {
          child.on('close', (code, signal) => resolve({ code, signal }));
        },
      );
      for (let tries = 0; tries < 600 && fake.calls().length === 0; tries += 1)
        await new Promise((resolve) => setTimeout(resolve, 50));
      expect(fake.calls()).toHaveLength(1);
      expect(leftBehind()).toHaveLength(1);

      child.kill('SIGINT');
      const result = await ended;

      expect(result.signal).toBe('SIGINT');
      expect(leftBehind()).toEqual([]);
      const pid = fake.calls()[0]?.pid ?? 0;
      for (let tries = 0; tries < 200 && isAlive(pid); tries += 1)
        await new Promise((resolve) => setTimeout(resolve, 25));
      expect(isAlive(pid)).toBe(false);
    }, 60_000);
  },
);
