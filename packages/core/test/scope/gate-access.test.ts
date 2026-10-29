import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { digestOf } from '../../src/scope/canonical.js';
import { keyIdOf } from '../../src/scope/keys.js';
import { signPermit } from '../../src/scope/permit.js';
import { wholeCallFingerprint } from '../../src/scope/scope-check.js';
import { callOf, gateFixture, resourcesOf, ASK, DENY, verdictOf } from './gate-fixture.js';

describe('the gate exposes verified one-use refusal binding without granting access', () => {
  it('describes a Read target independently from an exact-call policy question', async () => {
    const f = gateFixture();
    const read = callOf(
      'Read',
      { file_path: '/outside/a' },
      { resources: resourcesOf([['read', '/outside/a']]) },
    );
    const result = await verdictOf(f, read);
    expect(result.decision.effect).toBe('deny');
    expect(result.access).toEqual({
      permitBodySha256: digestOf(f.body),
      keyId: keyIdOf(f.pair.publicKey),
      permitExpiresAt: f.body.expiresAt,
      fingerprint: result.evidence.fingerprint,
      fingerprintKind: 'read-target',
      requiredFingerprints: [result.evidence.fingerprint],
      target: { op: 'read', path: '/outside/a' },
    });
    const ask = callOf(
      'Read',
      { file_path: '/work/project/a' },
      { decision: ASK, resources: resourcesOf([['read', '/work/project/a']]) },
    );
    expect((await verdictOf(f, ask)).access).toMatchObject({
      fingerprintKind: 'whole-call',
      fingerprint: wholeCallFingerprint(ask),
    });
    expect((await verdictOf(f, ask)).access).not.toHaveProperty('target');
  });

  it('keeps all requirements and identifies the next missing family after a target extension', async () => {
    const f = gateFixture();
    const call = callOf(
      'Read',
      { file_path: '/outside/a' },
      { decision: ASK, resources: resourcesOf([['read', '/outside/a']]) },
    );
    const first = await verdictOf(f, call);
    expect(first.access?.requiredFingerprints).toEqual([
      first.evidence.fingerprint,
      wholeCallFingerprint(call),
    ]);
    f.escalate(first.evidence.fingerprint!);
    const second = await verdictOf(f, call);
    expect(second.access?.fingerprintKind).toBe('whole-call');
    expect(second.access?.requiredFingerprints).toEqual(first.access?.requiredFingerprints);
    expect(second.evidence.fingerprint).toBe(wholeCallFingerprint(call));
  });

  it('never offers a request for unliftable denials or more than sixteen requirements', async () => {
    const f = gateFixture();
    const denied = callOf(
      'Read',
      {},
      { decision: DENY, resources: resourcesOf([['read', '/outside/a']]) },
    );
    expect((await verdictOf(f, denied)).access).toBeUndefined();
    expect(
      (await verdictOf(f, callOf('Read', {}, { classes: ['secret.egress'] }))).access,
    ).toBeUndefined();
    const tooMany = callOf(
      'Read',
      {},
      {
        resources: resourcesOf(
          Array.from({ length: 17 }, (_, n) => ['read', `/outside/${n}`] as const),
        ),
      },
    );
    expect((await verdictOf(f, tooMany)).access).toBeUndefined();
    f.store.revoke(f.taskId);
    expect((await verdictOf(f, callOf('Read'))).access).toBeUndefined();
  });

  it('retains legacy permit gate semantics but withholds signing authority without a signed session', async () => {
    const f = gateFixture();
    const { sessionId: _removed, ...body } = f.body;
    writeFileSync(
      join(f.home, 'tasks', f.taskId, 'permit.json'),
      JSON.stringify(signPermit(body, f.pair.privateKey)),
    );
    const result = await verdictOf(
      f,
      callOf('Read', {}, { resources: resourcesOf([['read', '/outside/a']]) }),
    );
    expect(result.decision.effect).toBe('deny');
    expect(result.evidence.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(result.access).toBeUndefined();
  });
});
