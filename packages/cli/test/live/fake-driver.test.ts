import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, type Policy } from '@stroq/core';
import { buildProbes } from '../../src/live/probes.js';
import { writePolicy } from '../../src/live/policy-digest.js';
import type { Probe } from '../../src/live/types.js';
import { FakeHostDriver, type Fault } from './fake-driver.js';
import { FAKE, NONCE, SESSION } from './helpers.js';
import { probe } from './probe-helpers.js';
import { makeRig, type Rig } from './rig.js';

/**
 * The double is only as good as it is faithful to the three things it stands in for: the hook (the
 * real engine, through the real adapter), the files the probe commands leave, and the shapes of what
 * a host reports. These say what it does, so that a test built on it can be read without reading it.
 */
let rig: Rig;
beforeEach(() => {
  rig = makeRig();
});
afterEach(() => {
  rig.cleanup();
});

const run = (fault: Fault, kind: Probe['kind'], over: Parameters<Rig['ctx']>[0] = {}) =>
  new FakeHostDriver({ fault }).run(probe(kind), rig.ctx(over));

const exists = (file: string): boolean => existsSync(join(rig.project, file));

describe('what the double is', () => {
  it('says it is a stand-in', () => {
    expect(new FakeHostDriver({ fault: 'honest' }).mode).toBe('stand-in');
  });

  it('never shells out: it does the file effects of the probes itself', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./fake-driver.ts', import.meta.url)),
      'utf8',
    );
    expect(source).not.toMatch(/child_process|\bspawn\b|\bexecSync\b|\bexecFile\b|\bexec\(/);
  });

  it('reports itself as found, with a version, unless it is told otherwise', async () => {
    expect(await new FakeHostDriver({ fault: 'honest' }).detect()).toEqual({
      available: true,
      version: '9.9.9-fake',
    });
    expect(
      await new FakeHostDriver({
        fault: 'honest',
        available: false,
        version: null,
        note: 'not on the path',
      }).detect(),
    ).toEqual({ available: false, version: null, note: 'not on the path' });
  });

  it('remembers every request, with the fault that answered it', async () => {
    const driver = new FakeHostDriver({
      fault: (p) => (p.kind === 'allow' ? 'honest' : 'refusal'),
    });
    await driver.run(probe('allow'), rig.ctx());
    await driver.run(
      probe('deny'),
      rig.ctx({ sessionId: 'second', nonce: 'stroq-live-aaaaaaaaaaaaaaaa' }),
    );
    expect(driver.calls).toEqual([
      { probeId: 'allow', hookMode: 'real', sessionId: SESSION, nonce: NONCE, fault: 'honest' },
      {
        probeId: 'deny',
        hookMode: 'real',
        sessionId: 'second',
        nonce: 'stroq-live-aaaaaaaaaaaaaaaa',
        fault: 'refusal',
      },
    ]);
  });
});

describe('an honest host', () => {
  it('runs the allowed command, and the real hook wrote an allow to the audit log', async () => {
    const result = await run('honest', 'allow');
    expect(readFileSync(join(rig.project, 'stroq-live-allow.txt'), 'utf8')).toBe(`${NONCE}\n`);
    expect(result.stream.filter((e) => e.type === 'tool_use')).toEqual([
      { type: 'tool_use', name: 'Bash', input: { command: probe('allow').command } },
    ]);
    const [entry, ...rest] = await rig.audit();
    expect(rest).toEqual([]);
    expect(entry).toMatchObject({
      sessionId: SESSION,
      phase: 'pre',
      decision: { effect: 'allow', ruleId: null },
    });
    expect(entry?.summary).toContain(NONCE);
  });

  it.each([
    ['deny', '.git/hooks/pre-commit', 'deny-git-exec'],
    ['secret-egress', 'stroq-live-egress.txt', 'deny-secret-egress'],
  ] as const)(
    'stops the %s probe: nothing is made, and the host passes on the hook words',
    async (kind, file, rule) => {
      const result = await run('honest', kind);
      expect(exists(file)).toBe(false);
      const [entry] = await rig.audit();
      expect(entry?.decision).toMatchObject({ effect: 'deny', ruleId: rule });
      const refusal = result.stream.find((e) => e.type === 'tool_result');
      expect(refusal).toMatchObject({ isError: true });
      expect(refusal?.text?.startsWith(`Stroq blocked this action (${rule})`)).toBe(true);
      expect(result).toMatchObject({ exitCode: 0, timedOut: false, apiKeySource: 'none' });
    },
  );

  it.skipIf(process.platform === 'win32')(
    'leaves the hook file it makes without the right to run',
    async () => {
      await run('honest', 'deny', { hookMode: 'noop' });
      expect(statSync(join(rig.project, '.git', 'hooks', 'pre-commit')).mode & 0o111).toBe(0);
    },
  );

  it('judges under the policy.yaml in the home it is given, as the hook does', async () => {
    const lax: Policy = {
      ...DEFAULT_POLICY,
      rules: DEFAULT_POLICY.rules.filter((rule) => rule.id !== 'deny-git-exec'),
    };
    writePolicy(rig.stroqHome, lax);
    await run('honest', 'deny');
    expect(exists('.git/hooks/pre-commit')).toBe(true);
    expect((await rig.audit())[0]?.decision).toMatchObject({ effect: 'allow', ruleId: null });
  });

  it('judges under the policy it is told to, when it is told', async () => {
    const driver = new FakeHostDriver({
      fault: 'honest',
      hookPolicy: { ...DEFAULT_POLICY, rules: [] },
    });
    await driver.run(probe('deny'), rig.ctx());
    expect(exists('.git/hooks/pre-commit')).toBe(true);
  });
});

describe('a host that does not do what the hook says', () => {
  it('ignores a deny: the hook says deny and the command runs', async () => {
    const result = await run('ignore-deny', 'deny');
    expect(exists('.git/hooks/pre-commit')).toBe(true);
    expect((await rig.audit())[0]?.decision).toMatchObject({
      effect: 'deny',
      ruleId: 'deny-git-exec',
    });
    expect(result.stream.find((e) => e.type === 'tool_result')).toMatchObject({ isError: false });
  });

  it.each(['never-call-hook', 'crash-fail-open', 'noop-hook'] as const)(
    'with %s the command runs and the audit log has nothing',
    async (fault) => {
      await run(fault, 'secret-egress');
      expect(exists('stroq-live-egress.txt')).toBe(true);
      expect(await rig.audit()).toEqual([]);
    },
  );

  it('says a crashed hook was not fatal, in the host words', async () => {
    const result = await run('crash-fail-open', 'allow');
    expect(result.stderrTail).toMatch(/non-blocking/);
    expect(result.exitCode).toBe(0);
  });

  it('blocks the command itself when its own permissions say so, hook or no hook', async () => {
    const result = await run('host-blocks-all', 'allow');
    expect(exists('stroq-live-allow.txt')).toBe(false);
    expect((await rig.audit())[0]?.decision).toMatchObject({ effect: 'allow' });
    expect(result.stream.find((e) => e.type === 'tool_result')?.text).toBe(
      'Permission to use Bash has been denied.',
    );
  });
});

describe('a control run, where the hook allows everything', () => {
  it.each(['honest', 'ignore-deny', 'never-call-hook', 'crash-fail-open', 'noop-hook'] as const)(
    'lets the command run whatever the hook faults are (%s), and records nothing',
    async (fault) => {
      await run(fault, 'deny', { hookMode: 'noop' });
      expect(exists('.git/hooks/pre-commit')).toBe(true);
      expect(await rig.audit()).toEqual([]);
    },
  );

  it('is still blocked by a host that blocks everything, and still refused by a model that refuses', async () => {
    await run('host-blocks-all', 'deny', { hookMode: 'noop' });
    expect(exists('.git/hooks/pre-commit')).toBe(false);
    expect(await rig.audit()).toEqual([]);
    const refused = await run('refusal', 'deny', { hookMode: 'noop' });
    expect(refused.stream.some((e) => e.type === 'tool_use')).toBe(false);
  });
});

describe('a host or a model in trouble', () => {
  it('refuses: the model says no and issues nothing', async () => {
    const result = await run('refusal', 'allow');
    expect(result.stream.some((e) => e.type === 'tool_use')).toBe(false);
    expect(exists('stroq-live-allow.txt')).toBe(false);
    expect(await rig.audit()).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  it('runs into a limit, in words', async () => {
    const result = await run('limit', 'allow');
    expect(result.exitCode).toBe(1);
    expect(result.limitHit).toBeUndefined();
    expect(result.stream.at(-1)).toMatchObject({ type: 'result', isError: true });
  });

  it('runs into a limit, and the driver says so', async () => {
    const result = await run('limit-flagged', 'allow');
    expect(result.limitHit).toBe('usage limit reached');
  });

  it('writes a stream that cannot be read', async () => {
    expect(await run('garbage', 'allow')).toMatchObject({
      stream: [],
      exitCode: 0,
      unparsedLines: 9,
    });
  });

  it('does not answer in time', async () => {
    expect(await run('timeout', 'allow')).toMatchObject({ timedOut: true, exitCode: null });
  });

  it('exits with an error and no explanation', async () => {
    expect(await run('host-error', 'allow')).toMatchObject({ exitCode: 1, timedOut: false });
  });

  it('is billed to an API key, and otherwise honest', async () => {
    const result = await run('api-billing', 'allow');
    expect(result.apiKeySource).toBe('ANTHROPIC_API_KEY');
    expect(exists('stroq-live-allow.txt')).toBe(true);
  });

  it('does not know a probe it was not built for', async () => {
    const odd: Probe = { ...buildProbes(NONCE, FAKE, rig.project)[0]!, id: 'unknown' };
    await expect(
      new FakeHostDriver({ fault: 'never-call-hook' }).run(odd, rig.ctx()),
    ).rejects.toThrow(/does not know/);
  });
});
