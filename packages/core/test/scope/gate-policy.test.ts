import { describe, expect, it } from 'vitest';
import { wholeCallFingerprint } from '../../src/scope/scope-check.js';
import { HARD_CLASSES } from '../../src/scope/hard-set.js';
import type { ActionClass, Decision } from '../../src/types.js';
import { ALLOW, ASK, DENY, callOf, gateFixture, verdictOf } from './gate-fixture.js';

const HINT = /to extend: stroq permit extend fix-login-1 ([0-9a-f]{64})/;
const fpOf = (reason: string): string => HINT.exec(reason)?.[1] ?? '';

describe('step 2: the hard set, whatever the scope says', () => {
  it.each([...HARD_CLASSES])(
    'denies a call with %s even when the scope allows everything',
    async (hard) => {
      const f = gateFixture({
        scope: {
          tools: ['Bash', 'Read', 'Write'],
          read: { allow: ['/**'], deny: [] },
          write: { allow: ['/**'], deny: [] },
          net: { mode: 'hosts', hosts: ['example.com'] },
          shell: 'allowed',
        },
      });
      for (const decision of [ALLOW, ASK, DENY]) {
        const verdict = await verdictOf(
          f,
          callOf('Bash', { command: 'echo hi' }, { classes: ['mcp.call', hard], decision }),
        );
        expect(verdict.decision.effect).toBe('deny');
        expect(verdict.decision.ruleId).toBe(`task-hard:${hard}`);
        expect(verdict.evidence).toEqual({ ruleId: `task-hard:${hard}`, kind: 'hard' });
        expect(verdict.decision.reason).not.toContain('to extend');
      }
    },
  );

  it('names the first hard class in the order of the set when a call has several', async () => {
    const f = gateFixture();
    const verdict = await verdictOf(
      f,
      callOf('Bash', {}, { classes: ['origin.suspect', 'shell.exec_encoded', 'secret.egress'] }),
    );
    expect(verdict.decision.ruleId).toBe('task-hard:secret.egress');
  });

  it('takes a hard class before a scope refusal: a tool outside the scope with a hard class is a hard deny', async () => {
    const f = gateFixture();
    const verdict = await verdictOf(f, callOf('WebSearch', {}, { classes: ['fs.canary'] }));
    expect(verdict.decision.ruleId).toBe('task-hard:fs.canary');
  });

  it('does not treat the soft classes as hard', async () => {
    const f = gateFixture();
    const soft: ActionClass[] = [
      'shell.destructive',
      'fs.secrets',
      'config.self_touch',
      'origin.untrusted',
    ];
    for (const cls of soft) {
      const verdict = await verdictOf(
        f,
        callOf('Bash', { command: 'echo hi' }, { classes: [cls] }),
      );
      expect(verdict.decision.ruleId ?? '').not.toMatch(/^task-hard/);
    }
  });
});

describe('step 4: the policy decision', () => {
  const inScope = () => callOf('TodoWrite', {});

  it('leaves an allow as it is, with the policy rule id kept', async () => {
    const f = gateFixture();
    const decision = { effect: 'allow', ruleId: 'allow-x', reason: 'fine' } as const;
    const verdict = await verdictOf(f, { ...inScope(), decision });
    expect(verdict.decision).toEqual(decision);
    expect(verdict.evidence).toEqual({ ruleId: 'allow-x', kind: 'in-scope' });
  });

  it('leaves a deny as it is, exactly', async () => {
    const f = gateFixture();
    const verdict = await verdictOf(f, { ...inScope(), decision: DENY });
    expect(verdict.decision).toEqual(DENY);
    expect(verdict.evidence).toEqual({ ruleId: DENY.ruleId, kind: 'policy' });
  });

  it('turns an ask into a deny, since nobody is there to answer, with the way to extend it', async () => {
    const f = gateFixture();
    const call = callOf('Bash', { command: 'echo hi' }, { decision: ASK });
    const verdict = await verdictOf(f, call);
    expect(verdict.decision.effect).toBe('deny');
    expect(verdict.decision.ruleId).toBe('task-ask:ask-destructive');
    expect(verdict.evidence.kind).toBe('ask');
    expect(verdict.decision.reason).toContain('policy asks');
    expect(fpOf(verdict.decision.reason)).toBe(wholeCallFingerprint(call));
  });

  // The ask that incomplete provenance produces (`origin.untrusted` with no record behind
  // it) must stay one a task's owner can lift for that call, unlike a flagged record's
  // `origin.suspect`: uncertainty is not evidence, and the hard set is only evidence.
  it('turns the ask incomplete provenance produces into a deny its owner can extend, not a hard one', async () => {
    const f = gateFixture();
    const asked: Decision = {
      effect: 'ask',
      ruleId: 'ask-origin-untrusted',
      reason: 'copied from content the agent read',
    };
    const call = callOf(
      'Bash',
      { command: 'npx some-helper' },
      {
        classes: ['origin.untrusted'],
        decision: asked,
      },
    );
    const verdict = await verdictOf(f, call);
    expect(verdict.decision.effect).toBe('deny');
    expect(verdict.decision.ruleId).toBe('task-ask:ask-origin-untrusted');
    expect(fpOf(verdict.decision.reason)).toBe(wholeCallFingerprint(call));
    expect(HARD_CLASSES).not.toContain('origin.untrusted');
  });

  it('turns an ask with no rule id into a deny with a stable id', async () => {
    const f = gateFixture();
    const verdict = await verdictOf(
      f,
      callOf('TodoWrite', {}, { decision: { effect: 'ask', ruleId: null, reason: 'default' } }),
    );
    expect(verdict.decision.ruleId).toBe('task-ask:default');
  });

  it('gives a scope refusal the say over an ask, and over a deny without offering to extend it', async () => {
    const f = gateFixture();
    const asked = await verdictOf(f, callOf('WebSearch', {}, { decision: ASK }));
    expect(asked.decision.ruleId).toBe('task-scope-tool');
    const denied = await verdictOf(f, callOf('WebSearch', {}, { decision: DENY }));
    expect(denied.decision.ruleId).toBe('task-scope-tool');
    expect(denied.decision.reason).not.toContain('to extend');
    expect(denied.evidence.fingerprint).toBeUndefined();
  });
});
