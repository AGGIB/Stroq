import { describe, expect, it } from 'vitest';
import { POISON_OPENING, everythingSaid, startRig } from './strict-rig.js';

/**
 * An embedded resource whose item also has a non-empty outer `text`. The default scan
 * reads the outer text and stops, so the resource's own text is delivered unscanned; the
 * first version of strict mode treated the resource's text as already read for the same
 * reason. Every string of the message is part of the strict scan text, so neither holds.
 */

describe('an embedded resource behind a non-empty outer text', () => {
  it('in a tools/call result is scanned: the session is tainted and the warning rides on the result', async () => {
    const rig = startRig({ strict: true });
    await rig.handshake();
    rig.call(3, 'hiddenres');
    const answer = await rig.answerFor(3);
    expect(rig.tainted()).toBe(true);
    expect(JSON.stringify(answer)).toContain('Stroq');
    expect(JSON.stringify(answer)).toContain(POISON_OPENING);
    await rig.finish();
  });

  it('in a prompts/get message is scanned too', async () => {
    const rig = startRig({ strict: true });
    await rig.handshake();
    rig.send({ jsonrpc: '2.0', id: 21, method: 'prompts/get', params: { name: 'hidden' } });
    await rig.answerFor(21);
    expect(rig.tainted()).toBe(true);
    await rig.finish();
  });

  it('is not scanned by the default proxy, which is the gap strict mode closes', async () => {
    const rig = startRig();
    await rig.handshake();
    rig.call(3, 'hiddenres');
    const answer = await rig.answerFor(3);
    expect(JSON.stringify(answer)).toContain(POISON_OPENING);
    expect(rig.tainted()).toBe(false);
    expect(everythingSaid(rig)).toContain(POISON_OPENING);
    await rig.finish();
  });
});
