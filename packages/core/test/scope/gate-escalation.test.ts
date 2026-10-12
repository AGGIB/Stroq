import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_ESCALATION_TTL_MS } from '../../src/scope/escalation.js';
import { fingerprintOf } from '../../src/scope/fingerprint.js';
import { wholeCallFingerprint } from '../../src/scope/scope-check.js';
import { generateKeyPair } from '../../src/scope/keys.js';
import { ALLOW, ASK, DENY, callOf, gateFixture, resourcesOf, verdictOf } from './gate-fixture.js';
import { MINUTE, NOW, NONCE, iso } from './helpers.js';

const README = '/work/project/README.md';
const writeReadme = () =>
  callOf('Write', { file_path: README }, { resources: resourcesOf([['write', README]]) });
const WRITE_FP = fingerprintOf('Write', 'file:write', README);

describe('escalation: a signed extension lifts one refusal, once', () => {
  it('lifts a path refusal for exactly the fingerprint it was signed for', async () => {
    const f = gateFixture();
    expect((await verdictOf(f, writeReadme())).decision.ruleId).toBe('task-scope-path');
    f.escalate(WRITE_FP);
    const lifted = await verdictOf(f, writeReadme());
    expect(lifted.decision.effect).toBe('allow');
    expect(lifted.decision.ruleId).toBe('task-escalation');
    expect(lifted.evidence.kind).toBe('escalated');
    expect(lifted.taskId).toBe(f.taskId);
  });

  it('is used up by the first call it lifts: the same call a second time is refused again', async () => {
    const f = gateFixture();
    f.escalate(WRITE_FP);
    expect((await verdictOf(f, writeReadme())).decision.effect).toBe('allow');
    const again = await verdictOf(f, writeReadme());
    expect(again.decision.effect).toBe('deny');
    expect(again.decision.ruleId).toBe('task-scope-path');
  });

  it('is used once even when two calls race for it', async () => {
    const f = gateFixture();
    f.escalate(WRITE_FP);
    const results = await Promise.all([1, 2, 3, 4].map(() => verdictOf(f, writeReadme())));
    expect(results.filter((v) => v.decision.effect === 'allow')).toHaveLength(1);
  });

  it('cannot be reused by reformatting the same signed escalation', async () => {
    const f = gateFixture();
    f.escalate(WRITE_FP);
    const file = join(f.home, 'tasks', f.taskId, 'extensions', `${WRITE_FP}.json`);
    const signed = JSON.parse(readFileSync(file, 'utf8'));
    expect((await verdictOf(f, writeReadme())).decision.effect).toBe('allow');
    writeFileSync(
      file,
      JSON.stringify({ sig: signed.sig, keyId: signed.keyId, body: signed.body }, null, 2),
    );
    expect((await verdictOf(f, writeReadme())).decision.effect).toBe('deny');
  });

  it('can be issued again for the same operation after it was used', async () => {
    const f = gateFixture();
    f.escalate(WRITE_FP);
    await verdictOf(f, writeReadme());
    f.clock.now = new Date(NOW.getTime() + MINUTE);
    f.escalate(WRITE_FP);
    expect((await verdictOf(f, writeReadme())).decision.effect).toBe('allow');
  });

  it('does not lift a different path, a different operation on the same path, or another tool', async () => {
    const f = gateFixture();
    f.escalate(WRITE_FP);
    const other = '/work/project/CHANGELOG.md';
    const otherPath = callOf(
      'Write',
      { file_path: other },
      { resources: resourcesOf([['write', other]]) },
    );
    expect((await verdictOf(f, otherPath)).decision.effect).toBe('deny');
    const asEdit = callOf(
      'Edit',
      { file_path: README },
      { resources: resourcesOf([['write', README]]) },
    );
    expect((await verdictOf(f, asEdit)).decision.effect).toBe('deny');
    const asRead = callOf('Read', {}, { resources: resourcesOf([['read', '/etc/hosts']]) });
    expect((await verdictOf(f, asRead)).decision.effect).toBe('deny');
    // None of those used it up.
    expect((await verdictOf(f, writeReadme())).decision.effect).toBe('allow');
  });

  it('names a file by its real path: an escalation for the target does not lift the link, and the reverse', async () => {
    const f = gateFixture();
    const link = '/work/project/src/link';
    const call = callOf('Read', {}, { resources: resourcesOf([['read', link, '/etc/hosts']]) });
    f.escalate(fingerprintOf('Read', 'file:read', link));
    expect((await verdictOf(f, call)).decision.effect).toBe('deny');
    f.escalate(fingerprintOf('Read', 'file:read', '/etc/hosts'));
    expect((await verdictOf(f, call)).decision.effect).toBe('allow');
  });

  it('lifts a command refusal for those exact bytes and no other command', async () => {
    const f = gateFixture({ scope: { shell: 'denied' } });
    f.escalate(wholeCallFingerprint(callOf('Bash', { command: 'npm test' })));
    expect((await verdictOf(f, callOf('Bash', { command: 'npm   test' }))).decision.effect).toBe(
      'deny',
    );
    expect((await verdictOf(f, callOf('Bash', { command: 'npm test' }))).decision.effect).toBe(
      'allow',
    );
    f.escalate(wholeCallFingerprint(callOf('Bash', { command: 'npm test' })));
    expect(
      (await verdictOf(f, callOf('Bash', { command: 'npm test --silent' }))).decision.effect,
    ).toBe('deny');
  });

  it('lifts an MCP refusal for those arguments and not for other arguments to the same tool', async () => {
    const f = gateFixture();
    const call = (args: Record<string, unknown>) =>
      callOf('mcp__docs__search', args, {
        classes: ['mcp.call'],
        mcp: { server: 'docs', tool: 'search' },
      });
    f.escalate(wholeCallFingerprint(call({ q: 'a' })));
    expect((await verdictOf(f, call({ q: 'b' }))).decision.effect).toBe('deny');
    expect((await verdictOf(f, call({ q: 'a' }))).decision.effect).toBe('allow');
  });

  it('lifts a policy ask for that operation, once', async () => {
    const f = gateFixture();
    const ask = callOf('Bash', { command: 'make release' }, { decision: ASK });
    const refused = await verdictOf(f, ask);
    expect(refused.decision.ruleId).toBe('task-ask:ask-destructive');
    f.escalate(wholeCallFingerprint(callOf('Bash', { command: 'make release' })));
    expect((await verdictOf(f, ask)).decision.effect).toBe('allow');
    expect((await verdictOf(f, ask)).decision.effect).toBe('deny');
  });

  it('needs an escalation for every refused path of a call, and uses them all up together', async () => {
    const f = gateFixture();
    const a = '/work/project/a.md';
    const b = '/work/project/b.md';
    const call = callOf(
      'Edit',
      {},
      {
        resources: resourcesOf([
          ['write', a],
          ['write', b],
        ]),
      },
    );
    f.escalate(fingerprintOf('Edit', 'file:edit', a));
    expect((await verdictOf(f, call)).decision.effect).toBe('deny');
    f.escalate(fingerprintOf('Edit', 'file:edit', b));
    expect((await verdictOf(f, call)).decision.effect).toBe('allow');
    expect((await verdictOf(f, call)).decision.effect).toBe('deny');
  });

  it('offers the fingerprint that, once signed, lifts exactly this call', async () => {
    const f = gateFixture();
    const call = callOf('WebSearch', { query: 'x' });
    const refused = await verdictOf(f, call);
    const fingerprint = refused.evidence.fingerprint as string;
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    f.escalate(fingerprint);
    expect((await verdictOf(f, call)).decision.effect).toBe('allow');
    expect((await verdictOf(f, callOf('WebSearch', { query: 'y' }))).decision.effect).toBe('deny');
  });
});

describe('escalation: when it does not count', () => {
  it('ignores an escalation past its expiry, to the millisecond', async () => {
    const f = gateFixture();
    const made = f.escalate(WRITE_FP);
    f.clock.now = new Date(Date.parse(made.expiresAt));
    expect((await verdictOf(f, writeReadme())).decision.effect).toBe('deny');
    f.clock.now = new Date(Date.parse(made.expiresAt) - 1);
    expect((await verdictOf(f, writeReadme())).decision.effect).toBe('allow');
  });

  it('ignores an escalation that lasts more than ten minutes, however it was signed', async () => {
    const f = gateFixture();
    f.escalate(WRITE_FP, { expiresAt: iso(NOW.getTime() + MAX_ESCALATION_TTL_MS + 1) });
    expect((await verdictOf(f, writeReadme())).decision.effect).toBe('deny');
    f.escalate(WRITE_FP, { expiresAt: iso(NOW.getTime() + MAX_ESCALATION_TTL_MS) });
    expect((await verdictOf(f, writeReadme())).decision.effect).toBe('allow');
  });

  it('ignores one signed by another key, one for another launch, one for another task', async () => {
    const f = gateFixture();
    f.escalate(WRITE_FP, {}, generateKeyPair().privateKey);
    expect((await verdictOf(f, writeReadme())).decision.effect).toBe('deny');
    f.escalate(WRITE_FP, { nonce: `${NONCE}-other` });
    expect((await verdictOf(f, writeReadme())).decision.effect).toBe('deny');
    f.escalate(WRITE_FP, { taskId: 'someone-else' });
    expect((await verdictOf(f, writeReadme())).decision.effect).toBe('deny');
  });

  it('ignores an escalation filed under a fingerprint that is not the one inside it', async () => {
    const f = gateFixture();
    const other = fingerprintOf('Write', 'file:write', '/work/project/other.md');
    f.escalate(WRITE_FP, { fingerprint: other });
    expect((await verdictOf(f, writeReadme())).decision.effect).toBe('deny');
  });

  it('ignores garbage, an empty file and a truncated one, without failing', async () => {
    const f = gateFixture();
    const file = join(f.home, 'tasks', f.taskId, 'extensions', `${WRITE_FP}.json`);
    for (const text of ['garbage', '', '{"body":', '{}', 'null']) {
      f.escalate(WRITE_FP);
      writeFileSync(file, text);
      expect((await verdictOf(f, writeReadme())).decision.effect, text).toBe('deny');
    }
  });

  it('ignores an escalation once the task is revoked or ended (the permit is void then)', async () => {
    const f = gateFixture();
    f.escalate(WRITE_FP);
    f.store.revoke(f.taskId);
    const verdict = await verdictOf(f, writeReadme());
    expect(verdict.decision.ruleId).toBe('task-void:revoked');
  });
});

describe('escalation never lifts the things it must not', () => {
  it('never lifts a hard class, even with a valid escalation for that very call', async () => {
    const f = gateFixture();
    const hard = callOf(
      'Write',
      { file_path: README },
      {
        classes: ['secret.egress'],
        resources: resourcesOf([['write', README]]),
      },
    );
    f.escalate(WRITE_FP);
    const verdict = await verdictOf(f, hard);
    expect(verdict.decision.ruleId).toBe('task-hard:secret.egress');
    // It was not spent either: the same escalation still lifts the ordinary call.
    expect((await verdictOf(f, writeReadme())).decision.effect).toBe('allow');
  });

  it('never lifts a void permit', async () => {
    const f = gateFixture();
    f.escalate(WRITE_FP);
    f.clock.now = new Date(Date.parse(f.body.expiresAt) + 1);
    f.escalate(WRITE_FP, {
      issuedAt: iso(f.clock.now.getTime()),
      expiresAt: iso(f.clock.now.getTime() + MINUTE),
    });
    expect((await verdictOf(f, writeReadme())).decision.ruleId).toBe('task-void:expired');
  });

  it('never lifts a policy deny, and does not spend the escalation on it', async () => {
    const f = gateFixture();
    f.escalate(WRITE_FP);
    const denied = callOf(
      'Write',
      { file_path: README },
      {
        resources: resourcesOf([['write', README]]),
        decision: DENY,
      },
    );
    const verdict = await verdictOf(f, denied);
    expect(verdict.decision.effect).toBe('deny');
    expect(verdict.decision.reason).not.toContain('to extend');
    expect((await verdictOf(f, writeReadme())).decision.effect).toBe('allow');
  });

  it('never lifts a policy deny on a call that is inside the scope', async () => {
    const f = gateFixture();
    const bash = callOf('Bash', { command: 'echo hi' }, { decision: DENY });
    f.escalate(wholeCallFingerprint(callOf('Bash', { command: 'echo hi' })));
    expect((await verdictOf(f, bash)).decision).toEqual(DENY);
  });

  it('does not make an allow out of an escalation: an in-scope allow is untouched and the escalation unspent', async () => {
    const f = gateFixture();
    const inScope = callOf('Bash', { command: 'echo hi' }, { decision: ALLOW });
    f.escalate(wholeCallFingerprint(callOf('Bash', { command: 'echo hi' })));
    expect((await verdictOf(f, inScope)).evidence.kind).toBe('in-scope');
    expect(
      f.store.readEscalation(f.taskId, wholeCallFingerprint(callOf('Bash', { command: 'echo hi' })))
        .kind,
    ).toBe('present');
  });

  it('is not made by the agent: the gate never writes an escalation, only a used marker', async () => {
    const f = gateFixture();
    await verdictOf(f, writeReadme());
    expect(f.store.readEscalation(f.taskId, WRITE_FP)).toEqual({ kind: 'absent' });
  });
});
