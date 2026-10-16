import { describe, expect, it } from 'vitest';
import { startRig } from './strict-rig.js';

/**
 * Strict mode's invariant is that every string the client is given was part of the text
 * that was scanned. The first version scanned a field the default scan does not read in
 * its JSON-ESCAPED form, in which a newline or a tab between words is a backslash and a
 * letter, so a sentence written with line breaks between its words read as clean. End to
 * end through the real proxy and the real scanner.
 */

describe('a payload with line breaks between its words', () => {
  it('in the instructions of an initialize result is scanned as the text it is', async () => {
    const rig = startRig({ strict: true, env: { STRICT_SERVER_INSTRUCTIONS: 'split' } });
    await rig.handshake();
    expect(rig.tainted()).toBe(true);
    await rig.finish();
  });

  it('in the description of a tool parameter in an input schema taints the session', async () => {
    const rig = startRig({ strict: true });
    await rig.handshake();
    rig.send({ jsonrpc: '2.0', id: 20, method: 'tools/list', params: { cursor: 'split' } });
    const answer = await rig.answerFor(20);
    expect(JSON.stringify(answer)).toContain('"tools"');
    expect(rig.tainted()).toBe(true);
    await rig.finish();
  });

  it('in the name of a resource link taints the session', async () => {
    const rig = startRig({ strict: true });
    await rig.handshake();
    rig.call(3, 'linkname');
    await rig.answerFor(3);
    expect(rig.tainted()).toBe(true);
    await rig.finish();
  });
});
