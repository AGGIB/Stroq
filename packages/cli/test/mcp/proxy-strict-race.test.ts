import { describe, expect, it } from 'vitest';
import { errorText, eventually, startRig, withSlowPre } from './strict-rig.js';

/**
 * A client request that is in the proxy's hands (being judged) while the server is ended
 * must not be forwarded when the judgement is done. The check at the top of the client
 * path is not enough: judging is asynchronous, and the server can be ended during it.
 */

const ENDED = 'ended this server';
const SLOW_MS = 1500;

describe('a tools/call being judged when the server is ended', () => {
  it('is answered as the later requests are, and is never sent to the server', async () => {
    const rig = startRig({
      strict: true,
      strictMaxWithheld: 1,
      shutdownGraceMs: 6000,
      // The server ignores the first signal, so it is still there to be sent the call.
      env: { STRICT_SERVER_IGNORE_TERM: '1' },
      engine: withSlowPre('benign', SLOW_MS),
    });
    await rig.handshake();
    rig.call(3, 'notif');
    // Sent at once behind 3: its judgement is under way when the server is ended.
    rig.call(9, 'benign');
    expect(errorText(await rig.answerFor(3))).toContain('more than 1 withheld');
    const late = await rig.answerFor(9, 30_000);
    expect(errorText(late)).toContain(ENDED);
    // Let the judgement have finished, then look at what the server was sent.
    await eventually(() => expect(rig.lines().length).toBeGreaterThan(0));
    expect(rig.serverLog().some((line) => line.includes('"id":9'))).toBe(false);
    expect(await rig.done).toBe(1);
  }, 90_000);

  it('is answered exactly once', async () => {
    const rig = startRig({
      strict: true,
      strictMaxWithheld: 1,
      shutdownGraceMs: 6000,
      env: { STRICT_SERVER_IGNORE_TERM: '1' },
      engine: withSlowPre('benign', SLOW_MS),
    });
    await rig.handshake();
    rig.call(3, 'notif');
    rig.call(9, 'benign');
    await rig.answerFor(9, 30_000);
    await rig.done;
    expect(rig.messages().filter((message) => message['id'] === 9)).toHaveLength(1);
  }, 90_000);

  it('is forwarded as usual when the server is not ended', async () => {
    const rig = startRig({ strict: true, engine: withSlowPre('benign', 300) });
    await rig.handshake();
    rig.call(9, 'benign');
    const answer = await rig.answerFor(9);
    expect(JSON.stringify(answer)).toContain('hello world');
    expect(await rig.finish()).toBe(0);
  });
});
