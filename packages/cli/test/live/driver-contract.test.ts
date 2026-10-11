import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { controlBreaches, type Invocation } from './driver-contract.js';
import { FakeHostDriver, type FakeCall } from './fake-driver.js';
import { makeRig, type Rig } from './rig.js';
import { marksOf, verify } from './verify-harness.js';

/**
 * The control of a deny is worth something only if the host is the same one, in everything but the hook,
 * as in the real run. That is written down in `types.ts` as the contract of a driver, and here is how a
 * driver (the stand-in host now, the Claude Code driver when there is one) is held to it: the invocations
 * it made for a probe and for its control are compared, and whatever differs besides the hook is named.
 */
let rig: Rig;
beforeEach(() => {
  rig = makeRig(false);
});
afterEach(() => {
  rig.cleanup();
});

const callOf = (
  calls: readonly FakeCall[],
  probeId: string,
  hookMode: 'real' | 'noop',
): FakeCall => {
  const found = calls.find((call) => call.probeId === probeId && call.hookMode === hookMode);
  if (found === undefined) throw new Error(`no ${hookMode} request for ${probeId}`);
  return found;
};

/** A control as a driver that keeps the contract makes it from the real run: the hook and the ids differ. */
const controlFrom = (real: Invocation, over: Partial<Invocation> = {}): Invocation => ({
  ...real,
  nonce: 'stroq-live-ffffffffffffffff',
  prompt: real.prompt.replaceAll(real.nonce, 'stroq-live-ffffffffffffffff'),
  sessionId: 'another-session',
  hook: { command: 'true', decides: 'nothing' },
  ...over,
});

describe('what the stand-in host does with a control', () => {
  it('starts it as the real run is started, but for the hook, for each deny', async () => {
    const driver = new FakeHostDriver({ fault: 'honest' });
    await verify(rig, driver, { control: true });
    for (const probeId of ['deny', 'secret-egress']) {
      const real = callOf(driver.calls, probeId, 'real').invocation;
      const control = callOf(driver.calls, probeId, 'noop').invocation;
      expect(controlBreaches(real, control), probeId).toEqual([]);
    }
  });

  it('gives the control a hook that is not the real one and that says nothing', async () => {
    const driver = new FakeHostDriver({ fault: 'honest' });
    await verify(rig, driver, { control: true });
    const real = callOf(driver.calls, 'deny', 'real').invocation;
    const control = callOf(driver.calls, 'deny', 'noop').invocation;
    expect(real.hook.command).toMatch(/stroq hook claude-code/);
    expect(real.hook.command).toContain(rig.stroqHome);
    expect(control.hook).toEqual({ command: 'true', decides: 'nothing' });
  });

  it('tells each request apart by its nonce and its session and by nothing else', async () => {
    const driver = new FakeHostDriver({ fault: 'honest' });
    await verify(rig, driver, { control: true });
    const real = callOf(driver.calls, 'deny', 'real').invocation;
    const control = callOf(driver.calls, 'deny', 'noop').invocation;
    expect(control.nonce).not.toBe(real.nonce);
    expect(control.sessionId).not.toBe(real.sessionId);
    expect(control.prompt).not.toBe(real.prompt);
  });
});

describe('controlBreaches', () => {
  /** The real run of a probe, as a driver for a host like Claude Code would start it. */
  const REAL: Invocation = {
    nonce: 'stroq-live-0123456789abcdef',
    prompt: 'Run it: echo stroq-live-0123456789abcdef',
    model: 'haiku',
    sessionId: 'session-one',
    flags: ['--output-format', 'stream-json', '--tools', 'Bash'],
    settings: { sandbox: false },
    permissions: { mode: 'dontAsk', allow: ['Bash(echo:*)'] },
    hook: { command: 'stroq hook claude-code', decides: 'nothing' },
    cwd: '/project',
    env: { PATH: '/usr/bin' },
  };

  it('finds nothing in a control made from the real run with its own hook, nonce and session', () => {
    expect(controlBreaches(REAL, controlFrom(REAL))).toEqual([]);
  });

  // Each of these is a thing a driver could change between the two runs, and the control then shows
  // something about another host than the one the real run was.
  it.each<readonly [string, string, Partial<Invocation>]>([
    ['the model', 'model', { model: 'opus' }],
    ['a flag', 'flags', { flags: ['--output-format', 'stream-json', '--tools', 'Bash,Write'] }],
    ['a flag taken out', 'flags', { flags: ['--output-format', 'stream-json'] }],
    ['the settings', 'settings', { settings: { sandbox: true } }],
    [
      'the permission mode',
      'permissions',
      { permissions: { mode: 'bypassPermissions', allow: ['Bash(echo:*)'] } },
    ],
    [
      'an allow rule only it has',
      'permissions',
      { permissions: { mode: 'dontAsk', allow: ['Bash(echo:*)', 'Bash(mkdir:*)'] } },
    ],
    ['the working directory', 'cwd', { cwd: '/elsewhere' }],
    ['the environment', 'env', { env: { PATH: '/usr/bin', EXTRA: '1' } }],
    ['what the model is asked', 'prompt', { prompt: 'Run something else' }],
  ])('names %s when the control changes it', (_name, part, over) => {
    expect(controlBreaches(REAL, controlFrom(REAL, over))).toEqual([part]);
  });

  it('names every part that changed, and no other', () => {
    const control = controlFrom(REAL, { model: 'opus', cwd: '/elsewhere' });
    expect(controlBreaches(REAL, control)).toEqual(['model', 'cwd']);
  });

  it('names a control whose hook is the real one: it is not a control', () => {
    const control = controlFrom(REAL, { hook: REAL.hook });
    expect(controlBreaches(REAL, control)).toEqual(['hook-command']);
  });

  it("names a hook that says allow, which skips the host's own permission step", () => {
    const control = controlFrom(REAL, { hook: { command: 'true', decides: 'allow' } });
    expect(controlBreaches(REAL, control)).toEqual(['hook-decides']);
  });
});

describe('a driver that breaks the contract', () => {
  it('is named by the check: the stand-in whose no-op hook says allow', async () => {
    const driver = new FakeHostDriver({ fault: 'noop-explicit-allow' });
    await verify(rig, driver, { control: true });
    const real = callOf(driver.calls, 'deny', 'real').invocation;
    const control = callOf(driver.calls, 'deny', 'noop').invocation;
    expect(controlBreaches(real, control)).toEqual(['hook-decides']);
  });

  // The stop of the deny was the host's own, the control skipped the host's permission step and ran the
  // command, and the pair looks like a deny that was stopped by a hook and shown armed. It is not that.
  it('does not verify a host whose own rules stopped the deny, however armed its control looks', async () => {
    const driver = new FakeHostDriver({ fault: 'noop-explicit-allow' });
    const result = await verify(rig, driver, { control: true });
    expect(marksOf(result)).toEqual({
      allow: 'passed:ran',
      deny: 'passed:blocked',
      'deny:control': 'passed:armed',
      'secret-egress': 'passed:blocked',
      'secret-egress:control': 'passed:armed',
    });
    // The words of the hook were not the ones the host passed on, for either deny.
    expect(result.probes.find((p) => p.id === 'deny')?.evidence.E4).toBe(false);
    expect(result.probes.find((p) => p.id === 'secret-egress')?.evidence.E4).toBe(false);
    expect(result.state).toBe('inconclusive');
    expect(result.caveats).toEqual(
      expect.arrayContaining(['deny-text-not-seen:deny', 'deny-text-not-seen:secret-egress']),
    );
  });

  it('does not verify a host that only looks as if it honoured the hook, whose own rules stop the denies', async () => {
    const driver = new FakeHostDriver({ fault: 'host-ignores-hook-but-blocks' });
    const result = await verify(rig, driver, { control: true });
    // The control keeps the contract here, so the host's own rules stop it too and nothing is armed.
    expect(marksOf(result)).toEqual({
      allow: 'passed:ran',
      deny: 'inconclusive:probe-not-armed',
      'deny:control': 'inconclusive:probe-not-armed',
      'secret-egress': 'inconclusive:probe-not-armed',
      'secret-egress:control': 'inconclusive:probe-not-armed',
    });
    expect(result.state).toBe('inconclusive');
    for (const call of driver.calls.filter((c) => c.hookMode === 'noop')) {
      const real = callOf(driver.calls, call.probeId, 'real').invocation;
      expect(controlBreaches(real, call.invocation)).toEqual([]);
    }
  });
});
