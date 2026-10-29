import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMcpCallControlsStore } from '../../src/mcp/call-control-store.js';
import { createMcpCallControlGuard } from '../../src/mcp/call-control-guard.js';
import type { McpCallControlAction } from '../../src/mcp/call-control-types.js';

/**
 * The call-control history is signed, so it cannot be forged without the key, but an older history this
 * home signed can be put back: one from before a pause, which would resume calls. The history only grows
 * (no event is ever removed), so its event count, inside the signed body, is its sequence. A running
 * connection remembers the longest history it has accepted and refuses one that is shorter or no longer
 * starts with it, and like any other verification loss that refusal holds until the connection
 * restarts. A new connection accepts the first valid history it reads, older or not: the limit.
 */

let home: string;
const id = '11111111-2222-4333-8444-555555555555';
const sha = 'a'.repeat(64);
beforeEach(async () => {
  home = join(await mkdtemp(join(tmpdir(), 'stroq-call-rollback-')), 'home');
});
afterEach(async () => {
  await rm(join(home, '..'), { recursive: true, force: true });
});
const history = () => join(home, 'mcp-call-controls', 'history.json');
const store = () => createMcpCallControlsStore({ home, lockTimeoutMs: 20 });
async function decide(action: McpCallControlAction) {
  const state = await store().read();
  return store().decide({
    controlId: id,
    invocationSha256: sha,
    action,
    operationId: randomUUID(),
    expectedRevision: state.revision,
    expectedEventId: state.controls.find((c) => c.controlId === id)?.eventId ?? null,
  });
}
const guard = () =>
  createMcpCallControlGuard({ home, controlId: id, invocationSha256: sha }, { lockTimeoutMs: 10 });
/** One call through `g`: the reason it was refused, or 'sent'. */
async function call(g: ReturnType<typeof guard>): Promise<string> {
  const result = await g.run((check, mark) => {
    if (check() !== null) return false;
    mark();
    return true;
  });
  return result.written ? 'sent' : (result.refusal?.reason ?? 'none');
}

describe('a running connection and an older, genuinely signed call-control history', () => {
  it('accepts n, refuses a replayed n-1 and stays refused until restart', async () => {
    await decide('configure-paused');
    await decide('resume');
    const resumed = await readFile(history());
    const g = guard();
    expect(await call(g)).toBe('sent');
    await decide('pause');
    expect(await call(g)).toBe('paused');
    // The resume it kept, put back: signed by this home, and one event shorter than what was seen.
    await writeFile(history(), resumed, { mode: 0o600 });
    expect(await call(g)).toBe('unavailable');
    // Later decisions on that history do not bring this connection back: only a restart does.
    await decide('pause');
    await decide('resume');
    expect(await call(g)).toBe('unavailable');
  });

  it('accepts n and then n+1 on the same connection', async () => {
    await decide('configure-paused');
    await decide('resume');
    const g = guard();
    expect(await call(g)).toBe('sent');
    await decide('pause');
    expect(await call(g)).toBe('paused');
    await decide('resume');
    expect(await call(g)).toBe('sent');
  });

  it('a new connection accepts whatever valid history it first reads, even an older one (the limit)', async () => {
    await decide('configure-paused');
    await decide('resume');
    const resumed = await readFile(history());
    await decide('pause');
    await writeFile(history(), resumed, { mode: 0o600 });
    expect(await call(guard())).toBe('sent');
  });
});
