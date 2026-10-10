import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openLedger } from '../../src/live/budget.js';
import { scrubbedEnv } from '../../src/live/verify-input.js';
import type { HostDriver, HostRun, ProbeContext } from '../../src/live/types.js';
import { FakeHostDriver } from './fake-driver.js';
import { finished } from './helpers.js';
import { makeRig, type Rig } from './rig.js';
import { marksOf, verify, verifyOptions } from './verify-harness.js';
import { verifyHost } from '../../src/live/verify.js';

/**
 * The owner's account is the budget, and a request billed to an API key is money the owner did not agree
 * to spend. A run must not go on with a host that has not said how it is paid for, and must not hand a
 * host the means to be paid for by an API key by accident.
 */
let rig: Rig;
beforeEach(() => {
  rig = makeRig(false);
});
afterEach(() => {
  rig.cleanup();
});

const driverOf = (
  run: (ctx: ProbeContext, n: number) => HostRun,
): HostDriver & { seen: number } => {
  const driver = {
    seen: 0,
    detect: () => Promise.resolve({ available: true, version: '1.0.0' }),
    run: (_probe: unknown, ctx: ProbeContext) => {
      driver.seen += 1;
      return Promise.resolve(run(ctx, driver.seen));
    },
  };
  return driver;
};

/** A run that ended well and said nothing at all about how it is paid for. */
const silent = (): HostRun => {
  const { apiProvider: _p, apiKeySource: _k, ...rest } = finished([]);
  return rest;
};

describe('a host that does not say how it is paid for', () => {
  it('is stopped after the first request: the probe is inconclusive and the rest are not attempted', async () => {
    const driver = driverOf(() => silent());
    const ledger = openLedger({ memory: true, limit: 30 });
    const result = await verify(rig, driver, { ledger });
    expect(marksOf(result)).toEqual({
      allow: 'inconclusive:billing-unknown',
      deny: 'not-attempted:billing-unknown',
      'secret-egress': 'not-attempted:billing-unknown',
    });
    expect(result.state).toBe('inconclusive');
    expect(driver.seen).toBe(1);
    expect(await ledger.peek()).toMatchObject({ used: 1 });
    expect(result.probes[0]?.detail).toMatch(/how it is paid for/);
  });

  it('keeps the evidence it found, which was good, beside the mark', async () => {
    const fake = new FakeHostDriver({ fault: 'honest' });
    const quiet: HostDriver = {
      detect: () => fake.detect(),
      run: async (probe, ctx) => {
        const run = await fake.run(probe, ctx);
        const { apiProvider: _p, apiKeySource: _k, ...rest } = run;
        return rest;
      },
    };
    const result = await verify(rig, quiet, { maxRequests: 5 });
    expect(result.probes[0]).toMatchObject({
      mark: 'inconclusive',
      reason: 'billing-unknown',
      evidence: { E1: true, E2: true, E3: true },
    });
  });

  it.each([
    ['only the provider', { apiProvider: 'firstParty' }],
    ['only the key source', { apiKeySource: 'none' }],
    ['a login', { apiKeySource: 'oauth' }],
  ])('is let go on when it says %s', async (_name, say) => {
    const driver = driverOf(() => ({ ...silent(), ...say }));
    const result = await verify(rig, driver);
    expect(result.probes[0]?.reason).not.toBe('billing-unknown');
    expect(driver.seen).toBeGreaterThan(1);
  });

  it('is judged on the first request only: a later one that says nothing is not a reason to stop', async () => {
    const driver = driverOf((_ctx, n) => (n === 1 ? finished([]) : silent()));
    const result = await verify(rig, driver);
    expect(driver.seen).toBe(3);
    expect(Object.values(marksOf(result)).some((m) => m.includes('billing-unknown'))).toBe(false);
  });

  it('is stopped by the specific problem when there is one: a limit is a limit', async () => {
    const driver = driverOf(() => ({ ...silent(), limitHit: 'usage limit reached' }));
    const result = await verify(rig, driver);
    expect(marksOf(result)).toEqual({
      allow: 'inconclusive:limit',
      deny: 'not-attempted:limit',
      'secret-egress': 'not-attempted:limit',
    });
  });

  it('is stopped, and its stream is called unreadable, when the stream could not be read at all', async () => {
    const driver = driverOf(() => ({
      stream: [],
      exitCode: 0,
      timedOut: false,
      stderrTail: '',
      unparsedLines: 9,
    }));
    const result = await verify(rig, driver);
    expect(marksOf(result)).toEqual({
      allow: 'inconclusive:unparsable-stream',
      deny: 'not-attempted:billing-unknown',
      'secret-egress': 'not-attempted:billing-unknown',
    });
    expect(driver.seen).toBe(1);
  });

  it('is stopped when what it says of its billing is not text', async () => {
    const driver = driverOf(() => ({ ...silent(), apiKeySource: 7 }) as unknown as HostRun);
    const result = await verify(rig, driver);
    expect(marksOf(result).allow).toBe('inconclusive:unparsable-stream');
    expect(marksOf(result).deny).toBe('not-attempted:billing-unknown');
    expect(driver.seen).toBe(1);
  });

  it('is billed to a key, still, when it says so: that is a bill, and not a silence', async () => {
    const driver = driverOf(() => ({ ...silent(), apiKeySource: 'ANTHROPIC_API_KEY' }));
    const result = await verify(rig, driver);
    expect(marksOf(result).allow).toBe('inconclusive:api-billing');
    expect(marksOf(result).deny).toBe('not-attempted:api-billing');
  });
});

describe('what a driver is handed in its environment', () => {
  const dirty = {
    ANTHROPIC_API_KEY: 'stroq_attack_not_a_key',
    ANTHROPIC_AUTH_TOKEN: 'nothing',
    ANTHROPIC_BASE_URL: 'https://example.invalid',
    ANTHROPIC_MODEL: 'x',
    anthropic_api_key: 'lower case is no different',
    CLAUDE_CODE_USE_BEDROCK: '1',
    CLAUDE_CODE_USE_VERTEX: '1',
    claude_code_use_foundry: '1',
    PATH: '/usr/bin',
    HOME: '/nowhere',
    CLAUDE_CODE_OAUTH_TOKEN: 'the-subscription',
    NOT_ANTHROPIC_KEY: 'kept',
  };

  it('has no ANTHROPIC_ and no CLAUDE_CODE_USE_ variable, whatever the caller put in it', async () => {
    const seen: ProbeContext['env'][] = [];
    const inner = new FakeHostDriver({ fault: 'honest' });
    const driver: HostDriver = {
      detect: () => inner.detect(),
      run: (probe, ctx) => {
        seen.push(ctx.env);
        return inner.run(probe, ctx);
      },
    };
    await verifyHost(driver, rig.ctx({ env: dirty }), verifyOptions({ control: true }));
    // Every request, the controls included.
    expect(seen).toHaveLength(5);
    for (const env of seen)
      expect(env).toEqual({
        PATH: '/usr/bin',
        HOME: '/nowhere',
        CLAUDE_CODE_OAUTH_TOKEN: 'the-subscription',
        NOT_ANTHROPIC_KEY: 'kept',
      });
  });

  it("is a copy: the caller's own environment is left as it was", async () => {
    const mine = { ...dirty };
    await verifyHost(
      new FakeHostDriver({ fault: 'refusal' }),
      rig.ctx({ env: mine }),
      verifyOptions(),
    );
    expect(mine).toEqual(dirty);
  });
});

describe('scrubbedEnv', () => {
  it('takes out what bills an API key or another cloud, whatever the case', () => {
    expect(
      scrubbedEnv({
        ANTHROPIC_API_KEY: 'a',
        Anthropic_Auth_Token: 'b',
        CLAUDE_CODE_USE_BEDROCK: '1',
        Claude_Code_Use_Vertex: '1',
        KEEP: 'c',
      }),
    ).toEqual({ KEEP: 'c' });
  });

  it('keeps variables that only look like them', () => {
    const env = { MY_ANTHROPIC_KEY: 'a', CLAUDE_CODE_USER: 'b', CLAUDE_CODE_: 'c', ANTHROPIC: 'd' };
    expect(scrubbedEnv(env)).toEqual(env);
  });

  it('drops a variable whose value is not text, which a child process cannot be given', () => {
    const env = { A: 'a', B: undefined, C: 3, D: null } as unknown as Record<string, string>;
    expect(scrubbedEnv(env)).toEqual({ A: 'a' });
  });

  it('is empty for an empty environment, and for nothing', () => {
    expect(scrubbedEnv({})).toEqual({});
    expect(scrubbedEnv(undefined as unknown as Record<string, string>)).toEqual({});
  });

  it('does not change what it is given', () => {
    const env = { ANTHROPIC_API_KEY: 'a', KEEP: 'b' };
    const before = JSON.stringify(env);
    scrubbedEnv(env);
    expect(JSON.stringify(env)).toBe(before);
  });
});
