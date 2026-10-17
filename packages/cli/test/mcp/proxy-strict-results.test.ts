import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  POISON_HOST,
  POISON_OPENING,
  errorText,
  everythingSaid,
  startRig,
  type Rig,
  eventually,
} from './strict-rig.js';

/**
 * Server results the default proxy forwards unscanned, one case each, run twice: with
 * the default proxy (what it does today, unchanged) and with `--strict` (withheld,
 * answered, audited). Every strict case also checks the two properties the mode exists
 * for: the request is ANSWERED (a withheld result never leaves the client waiting), and
 * nothing the server wrote is repeated in what the client is told or in the audit.
 */

/** A strict run of `tool`: the answer for id 3, and the rig for the checks around it. */
async function strictRun(tool: string, rigOptions: Parameters<typeof startRig>[0] = {}) {
  const rig = startRig({ strict: true, ...rigOptions });
  await rig.handshake();
  rig.call(3, tool);
  const answer = await rig.answerFor(3);
  return { rig, answer };
}

async function defaultRun(tool: string) {
  const rig = startRig();
  await rig.handshake();
  rig.call(3, tool);
  return rig;
}

/** The client was given only a fixed error for the request, with the server's words nowhere. */
function expectWithheld(rig: Rig, answer: Record<string, unknown>, reason: string): void {
  expect(errorText(answer)).toContain(`(${reason})`);
  expect(everythingSaid(rig)).not.toContain(POISON_OPENING);
  const audited = JSON.stringify(rig.audit());
  expect(audited).toContain(`mcp-strict-${reason}`);
  expect(audited).not.toContain(POISON_OPENING);
  expect(audited).not.toContain(POISON_HOST);
}

/** Newer V8 versions serialize this fixture iteratively, so its default fallback cannot occur. */
function deepJsonOverflowsSerialisation(): boolean {
  const depth = 60_000; // Match the deepjson fixture in strict-server.mjs.
  const value: unknown = JSON.parse(`${'['.repeat(depth)}${']'.repeat(depth)}`);
  try {
    JSON.stringify(value);
    return false;
  } catch (error) {
    if (error instanceof RangeError) return true;
    throw error;
  }
}

describe('a result larger than the proxy parses (8 MiB)', () => {
  it('is forwarded whole and unscanned by default', async () => {
    const rig = await defaultRun('big');
    const answer = await rig.answerFor(3);
    expect(JSON.stringify(answer)).toContain(POISON_OPENING);
    expect(rig.tainted()).toBe(false);
    await rig.finish();
  }, 60_000);

  it('is withheld under --strict, and the request is answered from the id in its head', async () => {
    const { rig, answer } = await strictRun('big');
    expectWithheld(rig, answer, 'oversize');
    expect(rig.lines().every((line) => line.length < 10_000)).toBe(true);
    await rig.finish();
  }, 60_000);
});

describe('a server line that is not JSON', () => {
  it('is forwarded as it is by default, and the request is never answered', async () => {
    const rig = await defaultRun('badjson');
    await eventually(() => expect(rig.lines().some((l) => l.includes(POISON_OPENING))).toBe(true));
    expect(rig.messages().some((m) => m['id'] === 3 && 'result' in m)).toBe(false);
    await rig.finish();
  });

  it('is withheld under --strict, and the request its head names is answered', async () => {
    const { rig, answer } = await strictRun('badjson');
    expectWithheld(rig, answer, 'unparsable');
    await rig.finish();
  });
});

describe('a response nobody asked for', () => {
  it('reaches the client by default', async () => {
    const rig = await defaultRun('unknownid');
    await rig.answerFor(3);
    expect(rig.messages().some((m) => m['id'] === 987654)).toBe(true);
    await rig.finish();
  });

  it('is withheld and counted under --strict, while the real answer is delivered', async () => {
    const { rig, answer } = await strictRun('unknownid');
    expect(JSON.stringify(answer)).toContain('"ok"');
    expect(rig.messages().some((m) => m['id'] === 987654)).toBe(false);
    expect(rig.ruleIds()).toContain('mcp-strict-unknown-id');
    expect(JSON.stringify(rig.audit())).not.toContain('987654');
    await rig.finish();
  });

  it('is withheld when it is an answer to a request that was already answered', async () => {
    const { rig, answer } = await strictRun('twice');
    expect(JSON.stringify(answer)).toContain('first');
    // The second answer follows the first on the same pipe: wait until it has been dealt with.
    await eventually(() => expect(rig.ruleIds()).toContain('mcp-strict-unknown-id'));
    expect(everythingSaid(rig)).not.toContain(POISON_OPENING);
    await rig.finish();
  });
});

describe('an answer whose id has the wrong type', () => {
  it('is forwarded by default and the request it was for is never answered', async () => {
    const rig = await defaultRun('strid');
    await eventually(() => expect(rig.messages().some((m) => m['id'] === '3')).toBe(true));
    expect(rig.messages().some((m) => m['id'] === 3)).toBe(false);
    await rig.finish();
  });

  it('is withheld under --strict and the request it was evidently for is answered', async () => {
    const { rig, answer } = await strictRun('strid');
    expectWithheld(rig, answer, 'id-mismatch');
    expect(rig.messages().some((m) => m['id'] === '3')).toBe(false);
    await rig.finish();
  });
});

describe('a JSON-RPC error that carries text', () => {
  it('reaches the client unscanned and untainted by default', async () => {
    const rig = await defaultRun('errpoison');
    const answer = await rig.answerFor(3);
    expect(errorText(answer)).toContain(POISON_OPENING);
    expect(rig.tainted()).toBe(false);
    await rig.finish();
  });

  it('is scanned under --strict: the session is tainted and the warning rides on the message', async () => {
    const { rig, answer } = await strictRun('errpoison');
    expect(rig.tainted()).toBe(true);
    expect(errorText(answer)).toContain('Stroq');
    expect(JSON.stringify(rig.audit())).toContain('"phase":"post"');
    await rig.finish();
  });
});

describe('a result Stroq cannot finish reading (nesting that overflows serialisation)', () => {
  it.skipIf(!deepJsonOverflowsSerialisation())('is forwarded unscanned by default', async () => {
    const rig = await defaultRun('deepjson');
    await rig.answerFor(3);
    // The raw line: the parsed value is too deep for the test to serialise either.
    expect(rig.lines().some((line) => line.includes(POISON_OPENING))).toBe(true);
    expect(rig.tainted()).toBe(false);
    await rig.finish();
  });

  it('is withheld under --strict and the request is answered', async () => {
    const { rig, answer } = await strictRun('deepjson');
    expectWithheld(rig, answer, 'scan-failed');
    await rig.finish();
  });
});

describe('binary content the scanner does not read', () => {
  it('image and audio data reaches the client by default', async () => {
    const rig = await defaultRun('imgdata');
    expect(JSON.stringify(await rig.answerFor(3))).toContain('"type":"image"');
    await rig.finish();
  });

  it('image and audio data that is not a picture or a sound is withheld under --strict', async () => {
    const { rig, answer } = await strictRun('imgdata');
    expectWithheld(rig, answer, 'unread-content');
    await rig.finish();
  });

  it('an embedded resource blob reaches the client by default and is withheld under --strict', async () => {
    const normal = await defaultRun('blobres');
    expect(JSON.stringify(await normal.answerFor(3))).toContain('"blob"');
    await normal.finish();
    const { rig, answer } = await strictRun('blobres');
    expectWithheld(rig, answer, 'unread-content');
    await rig.finish();
  });

  it('a real image still gets through under --strict, without its bytes being read as text', async () => {
    const { rig, answer } = await strictRun('pngimage');
    expect(JSON.stringify(answer)).toContain('"mimeType":"image/png"');
    expect(rig.ruleIds()).not.toContain('mcp-strict-unread-content');
    await rig.finish();
  });
});

describe('result keys beyond the protocol’s own', () => {
  it('reach the client unread by default', async () => {
    const rig = await defaultRun('extrakey');
    expect(JSON.stringify(await rig.answerFor(3))).toContain('"extra"');
    await rig.finish();
  });

  it('withhold the result under --strict', async () => {
    const { rig, answer } = await strictRun('extrakey');
    expectWithheld(rig, answer, 'unread-content');
    await rig.finish();
  });
});

describe('text beyond the 200,000 characters the scan reads', () => {
  it('is delivered with its tail unread by default', async () => {
    const rig = await defaultRun('dotpad');
    expect(JSON.stringify(await rig.answerFor(3))).toContain(POISON_OPENING);
    expect(rig.tainted()).toBe(false);
    await rig.finish();
  });

  it('is withheld under --strict, however the padding is arranged', async () => {
    for (const tool of ['dotpad', 'dotfront']) {
      const { rig, answer } = await strictRun(tool);
      expectWithheld(rig, answer, 'oversize-text');
      await rig.finish();
    }
  });
});

describe('a result the scanner is slow on', () => {
  it('is withheld at the deadline, not after the 12 to 18 seconds the scan takes', async () => {
    // 100 KB of ordinary prose takes the real scanner several seconds; a 400 ms deadline
    // has to stop it. With the deadline taken out this answer is a delivered result (or
    // arrives much later), and the reason check below fails.
    const started = Date.now();
    const { rig, answer } = await strictRun('heavy', { strictScanMs: 400 });
    const took = Date.now() - started;
    expectWithheld(rig, answer, 'scan-timeout');
    // Generous on purpose: this machine may be loaded; the scan alone takes several times this.
    expect(took).toBeLessThan(12_000);
    await rig.finish();
  }, 60_000);
});

describe('a message with two `result` keys', () => {
  it('is forwarded byte for byte by default, both keys included', async () => {
    const rig = await defaultRun('dupkey');
    await rig.answerFor(3);
    const line = rig.lines().find((l) => l.includes('the benign one')) ?? '';
    expect(line.split('"result"').length - 1).toBe(2);
    await rig.finish();
  });

  it('is delivered as the one structure that was scanned under --strict', async () => {
    const { rig } = await strictRun('dupkey');
    const line = rig.lines().find((l) => l.includes('the benign one')) ?? '';
    expect(line.split('"result"').length - 1).toBe(1);
    expect(everythingSaid(rig)).not.toContain(POISON_OPENING);
    await rig.finish();
  });
});

describe('a withheld request whose audit cannot be written', () => {
  it('is still answered: a failing audit is a thing to log, never a reason to wait forever', async () => {
    const rig = startRig({ strict: true });
    await rig.handshake();
    const file = join(rig.home, 'audit.jsonl');
    rmSync(file);
    mkdirSync(file);
    // Not a tools/call: the request itself is not audited, so only the withhold meets the broken audit.
    rig.send({ jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri: 'file:///extra' } });
    const answer = await rig.answerFor(3);
    expect(errorText(answer)).toContain('(unread-content)');
    expect(everythingSaid(rig)).not.toContain(POISON_OPENING);
    await rig.finish();
  });
});

describe('the other scanned methods under --strict', () => {
  it('withholds a tool listing, a resource and a prompt with a field it does not read, and answers each', async () => {
    const rig = startRig({ strict: true });
    await rig.handshake();
    rig.send({ jsonrpc: '2.0', id: 20, method: 'tools/list', params: { cursor: 'bad' } });
    rig.send({
      jsonrpc: '2.0',
      id: 21,
      method: 'resources/read',
      params: { uri: 'file:///extra' },
    });
    rig.send({ jsonrpc: '2.0', id: 22, method: 'prompts/get', params: { name: 'bad' } });
    for (const id of [20, 21, 22]) {
      expect(errorText(await rig.answerFor(id))).toContain('(unread-content)');
    }
    expect(everythingSaid(rig)).not.toContain(POISON_OPENING);
    expect(rig.ruleIds().filter((rule) => rule === 'mcp-strict-unread-content')).toHaveLength(3);
    await rig.finish();
  });
});

describe('every other method under --strict', () => {
  it('lets the handshake, a ping, a listing, a resource and a prompt through', async () => {
    const rig = startRig({ strict: true });
    await rig.handshake();
    rig.send({ jsonrpc: '2.0', id: 10, method: 'ping' });
    rig.send({ jsonrpc: '2.0', id: 11, method: 'resources/read', params: { uri: 'file:///a' } });
    rig.send({ jsonrpc: '2.0', id: 12, method: 'prompts/get', params: { name: 'p' } });
    expect((await rig.answerFor(10))['result']).toEqual({});
    expect(JSON.stringify(await rig.answerFor(11))).toContain('resource text');
    expect(JSON.stringify(await rig.answerFor(12))).toContain('prompt text');
    expect(rig.ruleIds()).toEqual([]);
    expect(await rig.finish()).toBe(0);
  });

  it('delivers a benign result and records it like the default proxy does', async () => {
    const { rig, answer } = await strictRun('benign');
    expect(JSON.stringify(answer)).toContain('hello world');
    expect(rig.tainted()).toBe(false);
    expect(JSON.stringify(rig.audit())).toContain('"phase":"post"');
    await rig.finish();
  });

  it('delivers a poisoned result with the warning block and the taint, as the default does', async () => {
    const { rig, answer } = await strictRun('poison');
    expect(JSON.stringify(answer)).toContain(POISON_OPENING);
    expect(JSON.stringify(answer)).toContain('Stroq');
    expect(rig.tainted()).toBe(true);
    await rig.finish();
  });

  it('scans the whole of an initialize result, instructions included', async () => {
    const rig = startRig({ strict: true, env: { STRICT_SERVER_INSTRUCTIONS: '1' } });
    await rig.handshake();
    expect(rig.tainted()).toBe(true);
    expect(rig.audit().some((e) => String(e['tool']).endsWith('__initialize'))).toBe(true);
    await rig.finish();
  });
});
