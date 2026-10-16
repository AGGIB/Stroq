import { describe, expect, it, vi } from 'vitest';
import { NO_MEDIA } from '../../src/mcp/strict-leaves.js';
import type { readStrictResult as ReadStrictResult } from '../../src/mcp/strict-result.js';
import { handlerRig, track } from './strict-handler-rig.js';

/**
 * The handler's last check before anything is scanned or sent: every string of the
 * structure it is about to deliver is in the text that is about to be scanned. The reader
 * makes that true by construction, so to see the check work the reader is replaced by one
 * that is wrong, the way a later edit to it could make it.
 */

const swap = vi.hoisted(() => ({
  reader: null as null | typeof ReadStrictResult,
}));

vi.mock('../../src/mcp/strict-result.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/mcp/strict-result.js')>();
  return {
    ...real,
    readStrictResult: (method: string, result: unknown) =>
      (swap.reader ?? real.readStrictResult)(method, result),
  };
});

const response = (id: number, result: unknown): string =>
  JSON.stringify({ jsonrpc: '2.0', id, result });

describe('the handler’s coverage post-condition', () => {
  it('withholds and answers a result whose reader left a string out of the scan text', async () => {
    swap.reader = () => ({ ok: true, text: 'content\ntype\ntext\nok', media: NO_MEDIA });
    try {
      const rig = handlerRig();
      track(rig, 3);
      await rig.feed(
        response(3, {
          content: [{ type: 'text', text: 'ok', smuggled: 'a string nobody scanned' }],
        }),
      );
      expect(rig.lines).toEqual([]);
      expect(JSON.stringify(rig.sent)).toContain('(unread-content)');
      expect(JSON.stringify(rig.sent)).not.toContain('smuggled');
      expect(rig.ruleIds()).toEqual(['mcp-strict-unread-content']);
    } finally {
      swap.reader = null;
    }
  });

  it('withholds a result whose scan text has a string the structure does not', async () => {
    swap.reader = () => ({ ok: true, text: 'content\ntype\ntext\nok\nextra', media: NO_MEDIA });
    try {
      const rig = handlerRig();
      track(rig, 3);
      await rig.feed(response(3, { content: [{ type: 'text', text: 'ok' }] }));
      expect(JSON.stringify(rig.sent)).toContain('(unread-content)');
    } finally {
      swap.reader = null;
    }
  });

  it('delivers a result whose text is exactly its strings', async () => {
    const rig = handlerRig();
    track(rig, 3);
    await rig.feed(response(3, { content: [{ type: 'text', text: 'ok' }] }));
    expect(rig.sent).toEqual([]);
    expect(rig.lines).toHaveLength(1);
    expect(rig.lines[0]).toContain('"text":"ok"');
  });
});
