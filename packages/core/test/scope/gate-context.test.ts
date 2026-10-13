import { describe, expect, it } from 'vitest';
import type { ScopeGateInput } from '../../src/scope/types.js';
import { callOf, gateFixture, resourcesOf, verdictOf } from './gate-fixture.js';
import { PROJECT } from './helpers.js';

const atCwd = (call: ScopeGateInput, cwd: string): ScopeGateInput => ({
  ...call,
  event: { ...call.event, cwd },
});

describe('an exact-call extension is bound to its execution context', () => {
  it('cannot move a relative recursive search to an excluded directory', async () => {
    const f = gateFixture();
    const input = { path: '.', pattern: 'fixture-marker' };
    const approved = callOf('Grep', input, {
      resources: resourcesOf([['read', PROJECT]]),
    });
    const outside = atCwd(
      callOf('Grep', input, {
        resources: resourcesOf([['read', '/outside']]),
      }),
      '/outside',
    );
    const refusal = await verdictOf(f, approved);
    expect(refusal.decision.effect).toBe('deny');
    expect(refusal.evidence.fingerprint).toBeDefined();
    f.escalate(refusal.evidence.fingerprint!);

    expect((await verdictOf(f, outside)).decision.effect).toBe('deny');
    expect((await verdictOf(f, approved)).decision.effect).toBe('allow');
  });

  it('cannot move an approved shell command to another directory', async () => {
    const f = gateFixture({ scope: { shell: 'denied' } });
    const approved = callOf('Bash', { command: 'cat fixture-marker.txt' });
    const outside = atCwd(approved, '/outside');
    const refusal = await verdictOf(f, approved);
    expect(refusal.decision.effect).toBe('deny');
    expect(refusal.evidence.fingerprint).toBeDefined();
    f.escalate(refusal.evidence.fingerprint!);

    expect((await verdictOf(f, outside)).decision.effect).toBe('deny');
    expect((await verdictOf(f, approved)).decision.effect).toBe('allow');
  });

  it('cannot reuse a traversal approval after its resolved root changes', async () => {
    const f = gateFixture();
    const path = `${PROJECT}/link`;
    const input = { path, pattern: 'fixture-marker' };
    const approved = callOf('Grep', input, {
      resources: resourcesOf([['read', path, `${PROJECT}/src`]]),
    });
    const retargeted = callOf('Grep', input, {
      resources: resourcesOf([['read', path, '/outside']]),
    });
    const refusal = await verdictOf(f, approved);
    f.escalate(refusal.evidence.fingerprint!);
    expect((await verdictOf(f, retargeted)).decision.effect).toBe('deny');
    expect((await verdictOf(f, approved)).decision.effect).toBe('allow');
  });

  it('binds shell approval to execution options as well as command bytes', async () => {
    const f = gateFixture({ scope: { shell: 'denied' } });
    const input = { command: 'echo fixture-marker', dangerouslyDisableSandbox: false };
    const approved = callOf('Bash', input);
    const refusal = await verdictOf(f, approved);
    f.escalate(refusal.evidence.fingerprint!);
    const altered = callOf('Bash', { ...input, dangerouslyDisableSandbox: true });
    expect((await verdictOf(f, altered)).decision.effect).toBe('deny');
    expect((await verdictOf(f, approved)).decision.effect).toBe('allow');
  });
});
