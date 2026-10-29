import { randomUUID } from 'node:crypto';
import { readStateMacKeySync } from '../../src/state-mac.js';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  encodeCallControlState,
  nextCallControlEvent,
  parseCallControlState,
} from '../../src/mcp/call-control-state.js';
import { createMcpCallControlsStore } from '../../src/mcp/call-control-store.js';
import type {
  McpCallControlAction,
  McpCallControlEvent,
  McpCallControlSnapshot,
} from '../../src/mcp/call-control-types.js';

const sha = 'a'.repeat(64),
  other = 'b'.repeat(64),
  homeBinding = 'c'.repeat(64);
const now = new Date('2026-10-26T12:00:00.000Z');
function nearCapacity(
  enabled: number,
  count: number,
  binding = homeBinding,
  key: Buffer | null = null,
) {
  const ids = Array.from({ length: enabled }, () => randomUUID()),
    filler = randomUUID();
  const events: McpCallControlEvent[] = [];
  const add = (controlId: string, action: McpCallControlAction, invocationSha256 = sha) => {
    events.push({
      id: randomUUID(),
      controlId,
      action,
      invocationSha256,
      previousEventId: [...events].reverse().find((e) => e.controlId === controlId)?.id ?? null,
      at: now.toISOString(),
    });
  };
  for (const id of [...ids, filler]) add(id, 'configure-paused');
  while (events.length < count - enabled) {
    const previous = [...events].reverse().find((e) => e.controlId === filler)!;
    add(filler, 'rebind-paused', previous.invocationSha256 === sha ? other : sha);
  }
  for (const id of ids) add(id, 'resume');
  return {
    state: parseCallControlState(encodeCallControlState(events, binding, key), binding, key),
    ids,
    filler,
  };
}
function input(
  state: McpCallControlSnapshot,
  controlId: string,
  action: McpCallControlAction,
  invocationSha256?: string,
) {
  const current = state.controls.find((c) => c.controlId === controlId);
  return {
    controlId,
    action,
    invocationSha256: invocationSha256 ?? current?.invocationSha256 ?? sha,
    operationId: randomUUID(),
    expectedRevision: state.revision,
    expectedEventId: current?.eventId ?? null,
  };
}
function advance(state: McpCallControlSnapshot, controlId: string, action: McpCallControlAction) {
  return parseCallControlState(
    encodeCallControlState(
      [...state.events, nextCallControlEvent(state, input(state, controlId, action), now)],
      state.homeBinding!,
    ),
    state.homeBinding!,
  );
}

describe('MCP event capacity preserves stronger Pause', () => {
  it('refuses a final Resume without its own Pause slot and still reads the historical enabled ledger', () => {
    const paused = nearCapacity(0, 511);
    expect(() =>
      nextCallControlEvent(paused.state, input(paused.state, paused.filler, 'resume'), now),
    ).toThrow('mcp-call-control-limit');
    const old = nearCapacity(1, 512);
    expect(old.state.events).toHaveLength(512);
    expect(old.state.controls.find((c) => c.controlId === old.ids[0])?.mode).toBe('enabled');
  });
  it('lets a single enabled control consume its reserved final event only to Pause', () => {
    const { state, ids, filler } = nearCapacity(1, 511);
    expect(() => nextCallControlEvent(state, input(state, filler, 'resume'), now)).toThrow(
      'mcp-call-control-limit',
    );
    const paused = advance(state, ids[0]!, 'pause');
    expect(paused.events).toHaveLength(512);
    expect(paused.controls.every((c) => c.mode === 'paused')).toBe(true);
    expect(() => nextCallControlEvent(paused, input(paused, ids[0]!, 'resume'), now)).toThrow(
      'mcp-call-control-limit',
    );
  });
  it('preserves each enabled control reserve against setup, paused rebind and another Resume', () => {
    const { state, ids, filler } = nearCapacity(2, 510);
    const fillerSha = state.controls.find((c) => c.controlId === filler)!.invocationSha256;
    for (const decision of [
      input(state, randomUUID(), 'configure-paused'),
      input(state, filler, 'rebind-paused', fillerSha === sha ? other : sha),
      input(state, filler, 'resume'),
    ])
      expect(() => nextCallControlEvent(state, decision, now)).toThrow('mcp-call-control-limit');
    const first = advance(state, ids[0]!, 'pause');
    expect(first.events).toHaveLength(511);
    expect(() => nextCallControlEvent(first, input(first, ids[0]!, 'resume'), now)).toThrow(
      'mcp-call-control-limit',
    );
    const all = advance(first, ids[1]!, 'pause');
    expect(all.events).toHaveLength(512);
    expect(all.controls.every((c) => c.mode === 'paused')).toBe(true);
  });
  it('allows an enabled rebind to use its own Pause reserve while retaining the other reserve', () => {
    const { state, ids } = nearCapacity(2, 510);
    const event = nextCallControlEvent(state, input(state, ids[0]!, 'rebind-paused', other), now);
    const rebound = parseCallControlState(
      encodeCallControlState([...state.events, event], homeBinding),
      homeBinding,
    );
    expect(rebound.controls.find((c) => c.controlId === ids[0])?.mode).toBe('paused');
    expect(advance(rebound, ids[1]!, 'pause').events).toHaveLength(512);
  });
  it('allows an emergency Pause to improve a historical reserve deficit within the hard event cap', () => {
    const { state, ids, filler } = nearCapacity(2, 511);
    expect(() => nextCallControlEvent(state, input(state, filler, 'resume'), now)).toThrow(
      'mcp-call-control-limit',
    );
    expect(() =>
      nextCallControlEvent(state, input(state, ids[0]!, 'rebind-paused', other), now),
    ).toThrow('mcp-call-control-limit');
    const held = advance(state, ids[0]!, 'pause');
    expect(held.events).toHaveLength(512);
    expect(held.controls.find((c) => c.controlId === ids[0])?.mode).toBe('paused');
    expect(held.controls.find((c) => c.controlId === ids[1])?.mode).toBe('enabled');
    expect(() => nextCallControlEvent(held, input(held, ids[1]!, 'pause'), now)).toThrow(
      'mcp-call-control-limit',
    );
  });
  // The native call-control store is POSIX-only and refuses on Windows (`mcp-call-control-unsupported`).
  it.skipIf(process.platform === 'win32')(
    'refuses reserve-consuming writes without changing disk and physically publishes both final Pauses',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'stroq-call-reserve-')),
        home = join(root, 'home');
      try {
        const store = createMcpCallControlsStore({ home, now: () => now });
        const initial = await store.read(),
          id = randomUUID();
        const configured = await store.decide(input(initial, id, 'configure-paused'));
        const near = nearCapacity(2, 510, configured.state.homeBinding!, readStateMacKeySync(home));
        const file = join(home, 'mcp-call-controls', 'history.json');
        // The history is signed with the home's state key, as the store signs it.
        const bytes = encodeCallControlState(
          near.state.events,
          near.state.homeBinding!,
          readStateMacKeySync(home),
        );
        await writeFile(file, bytes, { mode: 0o600 });
        await expect(
          store.decide(input(near.state, randomUUID(), 'configure-paused')),
        ).rejects.toThrow('mcp-call-control-limit');
        expect(await readFile(file)).toEqual(bytes);
        const first = await store.decide(input(near.state, near.ids[0]!, 'pause'));
        const second = await store.decide(input(first.state, near.ids[1]!, 'pause'));
        expect(second.state.events).toHaveLength(512);
        expect((await store.read()).controls.every((c) => c.mode === 'paused')).toBe(true);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
