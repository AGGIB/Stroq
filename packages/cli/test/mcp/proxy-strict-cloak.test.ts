import { describe, expect, it } from 'vitest';
import { errorText, startRig, eventually } from './strict-rig.js';

/**
 * `--strict --cloak`: the cloak is applied only to a result strict mode has read and
 * scanned whole, and whatever the cloak drops is now answered. The default `--cloak`
 * drops an oversize or unreadable result and leaves the client's request unanswered;
 * those cases are pinned here as they are, next to what strict mode does with them.
 */

describe('--strict --cloak', () => {
  it('scans a result, then cloaks it', async () => {
    const rig = startRig({ strict: true, cloak: true });
    await rig.handshake();
    rig.call(3, 'customer');
    const answer = await rig.answerFor(3);
    const delivered = JSON.stringify(answer);
    expect(delivered).not.toContain('peter@bugle.example');
    expect(delivered).toContain('STROQ_EMAIL');
    const audit = JSON.stringify(rig.audit());
    expect(audit).toContain('"phase":"post"');
    expect(audit).toContain('"cloak"');
    await rig.finish();
  });

  it('answers a result the cloak refuses, where --cloak alone leaves the request unanswered', async () => {
    const plain = startRig({ cloak: true });
    await plain.handshake();
    plain.call(3, 'bigimage');
    // The cloak drops the result and audits that it did; only then is "no answer" an answer.
    await eventually(() => expect(plain.ruleIds()).toContain('mcp-cloak-unscannable-result'));
    expect(plain.messages().some((m) => m['id'] === 3)).toBe(false);
    await plain.finish();

    const rig = startRig({ strict: true, cloak: true });
    await rig.handshake();
    rig.call(3, 'bigimage');
    const answer = await rig.answerFor(3);
    expect(errorText(answer)).toContain('(cloak-refused)');
    expect(rig.ruleIds()).toContain('mcp-strict-cloak-refused');
    await rig.finish();
  }, 60_000);

  it('answers an oversize result, where --cloak alone drops it silently', async () => {
    const plain = startRig({ cloak: true });
    await plain.handshake();
    plain.call(3, 'big');
    await eventually(() => expect(plain.ruleIds()).toContain('mcp-cloak-unscannable-result'));
    expect(plain.messages().some((m) => m['id'] === 3)).toBe(false);
    await plain.finish();

    const rig = startRig({ strict: true, cloak: true });
    await rig.handshake();
    rig.call(3, 'big');
    expect(errorText(await rig.answerFor(3))).toContain('(oversize)');
    await rig.finish();
  }, 60_000);

  it('never reaches the cloak with a result it withheld', async () => {
    const rig = startRig({ strict: true, cloak: true });
    await rig.handshake();
    rig.call(3, 'dotpad');
    expect(errorText(await rig.answerFor(3))).toContain('(oversize-text)');
    expect(rig.audit().some((entry) => 'cloak' in entry)).toBe(false);
    await rig.finish();
  });
});
