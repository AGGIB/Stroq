import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCodexDriver } from '../../../src/live/drivers/codex.js';
import type {
  HostChild,
  HostSpawn,
  HostSpawnOptions,
} from '../../../src/live/drivers/host-process.js';
import { codexArgv } from '../../../src/live/drivers/codex-argv.js';
import { codexIsolationProblem } from '../../../src/live/drivers/codex-isolation.js';
import { controlBreaches, type Invocation } from '../driver-contract.js';
import { makeRig, type Rig } from '../rig.js';
import { probe } from '../probe-helpers.js';
import { NONCE } from '../helpers.js';

interface Reply {
  out?: string;
  err?: string;
  code?: number;
  hang?: boolean;
}
const rigs: Rig[] = [];
afterEach(() => {
  for (const rig of rigs.splice(0)) rig.cleanup();
});
const setup = (replies: Reply[] = []) => {
  const rig = makeRig();
  rigs.push(rig);
  const calls: { file: string; args: readonly string[]; options: HostSpawnOptions }[] = [];
  const kills = vi.fn();
  const spawn: HostSpawn = (file, args, options) => {
    calls.push({ file, args, options });
    const reply = replies.shift() ?? {
      out: '{"type":"thread.started","thread_id":"a"}\n{"type":"turn.completed","usage":{}}\n',
    };
    const child = new EventEmitter() as EventEmitter & HostChild;
    Object.assign(child, {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => {
        kills();
        queueMicrotask(() => child.emit('close', null, 'SIGKILL'));
        return true;
      },
    });
    queueMicrotask(() => {
      child.stdout?.emit('data', reply.out ?? '');
      child.stderr?.emit('data', reply.err ?? '');
      if (!reply.hang) child.emit('close', reply.code ?? 0, null);
    });
    return child;
  };
  const driver = createCodexDriver({
    hookLine: 'node /hook.js hook codex',
    spawn,
    detectTimeoutMs: 20,
    killGraceMs: 5,
    env: { PATH: '/bin' },
    isolationCheck: () => null,
  });
  return { rig, driver, calls, kills, spawn };
};
const login: Reply = { err: 'Logged in using ChatGPT\n' };

describe('Codex driver', () => {
  it('detects the version without making an inference request', async () => {
    const { driver, calls } = setup([{ out: 'codex-cli 0.162.1\n' }]);
    expect(await driver.detect()).toEqual({ available: true, version: '0.162.1' });
    expect(calls[0]?.args).toEqual(['--version']);
  });
  it.each([{ out: 'wrong' }, { out: 'codex-cli 0.162.1', code: 1 }, { hang: true }])(
    'refuses an unavailable or unreadable host: %j',
    async (reply) => {
      expect((await setup([reply]).driver.detect()).available).toBe(false);
    },
  );
  it('does not start inference unless the host confirms ChatGPT login', async () => {
    const { rig, driver, calls } = setup([{ err: 'Logged in using an API key' }]);
    expect((await driver.run(probe('allow', NONCE, rig.project), rig.ctx())).apiKeySource).toBe(
      'api-key',
    );
    expect(calls).toHaveLength(1);
  });
  it('refuses a user hooks.json even though the base user config is ignored', async () => {
    const { rig, spawn, calls } = setup([login]);
    const driver = createCodexDriver({
      hookLine: 'hook',
      spawn,
      isolationCheck: codexIsolationProblem,
    });
    writeFileSync(join(rig.home, 'hooks.json'), '{}');
    const run = await driver.run(
      probe('allow', NONCE, rig.project),
      rig.ctx({ env: { CODEX_HOME: rig.home } }),
    );
    expect(run.stderrTail).toContain('cannot be isolated safely');
    expect(calls).toHaveLength(0);
  });
  it.each([{ err: 'Not logged in', code: 1 }, { err: 'unknown login' }])(
    'refuses unknown authentication: %j',
    async (reply) => {
      const { rig, driver, calls } = setup([reply]);
      const run = await driver.run(probe('allow', NONCE, rig.project), rig.ctx());
      expect(run.apiKeySource).toBeUndefined();
      expect(run.exitCode).toBeNull();
      expect(calls).toHaveLength(1);
    },
  );
  it('uses the scrubbed environment for login and exec, and reports the preflight billing evidence', async () => {
    const { rig, driver, calls } = setup([login]);
    const run = await driver.run(
      probe('allow', NONCE, rig.project),
      rig.ctx({
        env: {
          PATH: '/bin',
          CODEX_API_KEY: 'not-a-real-key',
          OPENAI_BASE_URL: 'https://invalid',
          CODEX_ACCESS_TOKEN: 'not-a-token',
        },
      }),
    );
    expect(run).toMatchObject({
      apiKeySource: 'oauth',
      apiProvider: 'firstParty',
      cwd: rig.project,
      exitCode: 0,
    });
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.options.env)).toEqual([{ PATH: '/bin' }, { PATH: '/bin' }]);
    expect(calls[1]?.options.cwd).toBe(rig.project);
  });
  it('aborts before starting a host when interrupted', async () => {
    const { rig, spawn, calls } = setup();
    const controller = new AbortController();
    controller.abort();
    const driver = createCodexDriver({ hookLine: 'hook', spawn, signal: controller.signal });
    expect((await driver.run(probe('allow', NONCE, rig.project), rig.ctx())).stderrTail).toContain(
      'interrupted',
    );
    expect(calls).toEqual([]);
  });
  it('stops an API billing signal in stdout immediately', async () => {
    const { rig, driver, kills } = setup([
      login,
      { out: '{"type":"error","message":"API key billing"}\n', hang: true },
    ]);
    const run = await driver.run(probe('allow', NONCE, rig.project), rig.ctx());
    expect(run.apiKeySource).toBe('api-key');
    expect(kills).toHaveBeenCalled();
  });
  it('does not start inference if interrupted while login is being checked', async () => {
    const { rig, spawn, calls } = setup([login]);
    const controller = new AbortController();
    const interrupting: HostSpawn = (file, args, options) => {
      const child = spawn(file, args, options);
      queueMicrotask(() => controller.abort());
      return child;
    };
    const driver = createCodexDriver({
      hookLine: 'hook',
      spawn: interrupting,
      signal: controller.signal,
      isolationCheck: () => null,
    });
    const run = await driver.run(probe('allow', NONCE, rig.project), rig.ctx());
    expect(run.stderrTail).toContain('interrupted');
    expect(calls).toHaveLength(1);
  });
  it('stops an API billing signal in the host stderr immediately', async () => {
    const { rig, driver, kills } = setup([
      login,
      { err: '2026-10-13T00:00:00Z ERROR codex_core::auth: API key billing\n', hang: true },
    ]);
    const run = await driver.run(probe('allow', NONCE, rig.project), rig.ctx());
    expect(run.apiKeySource).toBe('api-key');
    expect(kills).toHaveBeenCalled();
  });
  it('returns a refused throwaway directory as a run, never a thrown exception', async () => {
    const { rig, driver } = setup([login]);
    expect(
      (await driver.run(probe('allow', NONCE, rig.project), rig.ctx({ home: process.cwd() })))
        .stderrTail,
    ).toContain('could not run Codex');
  });
  it('starts a real probe and its control with identical settings except the hook command', async () => {
    const { rig, driver, calls } = setup([login, {}, login, {}]);
    const p = probe('deny', NONCE, rig.project);
    await driver.run(p, rig.ctx());
    await driver.run(p, rig.ctx({ hookMode: 'noop' }));
    const invocation = (call: (typeof calls)[number]): Invocation => {
      const hook = call.args.find((word) => word.startsWith('hooks.PreToolUse='))!;
      return {
        nonce: NONCE,
        prompt: call.args.at(-1)!,
        model: call.args[call.args.indexOf('--model') + 1]!,
        sessionId: 'fresh',
        flags: call.args.slice(0, -1).map((word) => (word === hook ? '<hook>' : word)),
        settings: {},
        permissions: { mode: 'danger-full-access', allow: [] },
        hook: { command: hook, decides: 'nothing' },
        cwd: call.options.cwd,
        env: call.options.env,
      };
    };
    expect(controlBreaches(invocation(calls[1]!), invocation(calls[3]!))).toEqual([]);
    expect(calls[3]?.args).toEqual(codexArgv(p, 'node -e 0'));
  });
});
