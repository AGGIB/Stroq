import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMcpCallControlsStore } from '../../src/mcp/call-control-store.js';
import { createMcpCallControlGuard } from '../../src/mcp/call-control-guard.js';
import { withCallControlLease } from '../../src/mcp/call-control-files.js';
import type { McpCallControlAction } from '../../src/mcp/call-control-types.js';

let home: string;
const id = '11111111-2222-4333-8444-555555555555';
const sha = 'a'.repeat(64);
beforeEach(async () => {
  home = join(await mkdtemp(join(tmpdir(), 'stroq-call-guard-')), 'home');
});
afterEach(async () => {
  await rm(join(home, '..'), { recursive: true, force: true });
});
const store = () => createMcpCallControlsStore({ home, lockTimeoutMs: 20 });
async function decide(action: McpCallControlAction, invocationSha256 = sha) {
  const state = await store().read();
  return store().decide({
    controlId: id,
    invocationSha256,
    action,
    operationId: randomUUID(),
    expectedRevision: state.revision,
    expectedEventId: state.controls.find((c) => c.controlId === id)?.eventId ?? null,
  });
}
const guard = () =>
  createMcpCallControlGuard({ home, controlId: id, invocationSha256: sha }, { lockTimeoutMs: 10 });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
describe('MCP physical dispatch call-control guard', () => {
  it('supports pause then resume on the same compatible connection and captures exact evidence', async () => {
    const configured = await decide('configure-paused');
    const g = guard();
    let writes = 0;
    expect(
      await g.run(() => {
        writes++;
        return true;
      }),
    ).toEqual({
      written: false,
      refusal: {
        controlId: id,
        eventId: configured.event.id,
        invocationSha256: sha,
        authoritySha256: configured.state.revision,
        reason: 'paused',
      },
    });
    await decide('resume');
    expect(
      await g.run((check, mark) => {
        expect(check()).toBeNull();
        writes++;
        mark();
        return true;
      }),
    ).toEqual({ written: true, refusal: null });
    expect(writes).toBe(1);
    await decide('pause');
    expect((await g.run(() => true)).refusal?.reason).toBe('paused');
  });
  it('rereads synchronously after async approval wait and latches verification loss through later repair', async () => {
    await decide('configure-paused');
    await decide('resume');
    const g = guard();
    const path = join(home, 'mcp-call-controls', 'history.json');
    const original = await readFile(path);
    let release!: () => void;
    let entered = false;
    const held = g.run(async (check) => {
      entered = true;
      await new Promise<void>((r) => {
        release = r;
      });
      expect(check()?.reason).toBe('unavailable');
      return false;
    });
    while (!entered) await tick();
    await writeFile(path, 'bad', { mode: 0o600 });
    release();
    expect((await held).refusal?.reason).toBe('unavailable');
    await writeFile(path, original, { mode: 0o600 });
    expect((await g.run(() => true)).refusal?.reason).toBe('unavailable');
    expect(
      (
        await guard().run((check, mark) => {
          expect(check()).toBeNull();
          mark();
          return true;
        })
      ).written,
    ).toBe(true);
  });
  it('serializes pause with admission, releases before drain, and treats live contention as per-call busy', async () => {
    await decide('configure-paused');
    await decide('resume');
    const g = guard();
    let release!: () => void;
    let entered = false;
    const locked = withCallControlLease(home, false, async () => {
      entered = true;
      await new Promise<void>((r) => {
        release = r;
      });
    });
    while (!entered) await tick();
    expect((await g.run(() => true)).refusal?.reason).toBe('busy');
    release();
    await locked;
    let pauseFinished = false;
    const dispatch = await g.run((check, mark) => {
      expect(check()).toBeNull();
      mark();
      return true;
    });
    await decide('pause');
    pauseFinished = true;
    expect(dispatch.written && pauseFinished).toBe(true);
  });
  it('preserves written precedence when approval release fails, then latches future dispatch', async () => {
    await decide('configure-paused');
    await decide('resume');
    const g = guard();
    expect(
      await g.run((check, mark) => {
        expect(check()).toBeNull();
        mark();
        throw Error('approval lock release');
      }),
    ).toEqual({ written: true, refusal: null });
    expect((await g.run(() => true)).refusal?.reason).toBe('unavailable');
  });
  it('preserves written precedence when the native lease owner disappears after the physical write', async () => {
    await decide('configure-paused');
    await decide('resume');
    const g = guard();
    expect(
      await g.run(async (check, mark) => {
        expect(check()).toBeNull();
        mark();
        await unlink(join(home, 'mcp-call-controls', '.lock', 'owner.json'));
        return true;
      }),
    ).toEqual({ written: true, refusal: null });
    expect((await g.run(() => true)).refusal?.reason).toBe('unavailable');
  });
  it('withholds an old invocation after explicit paused rebind and resume of the replacement', async () => {
    await decide('configure-paused');
    await decide('resume');
    const old = guard();
    await decide('rebind-paused', 'b'.repeat(64));
    await decide('resume', 'b'.repeat(64));
    expect((await old.run(() => true)).refusal?.reason).toBe('unavailable');
  });
  it('never resumes unknown, drifted or missing authority and does not create storage on refusal', async () => {
    const missing = guard();
    expect((await missing.run(() => true)).refusal?.reason).toBe('unavailable');
    await expect(readFile(join(home, 'mcp-call-controls', 'history.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await decide('configure-paused');
    await decide('resume');
    expect((await missing.run(() => true)).refusal?.reason).toBe('unavailable');
    const drift = createMcpCallControlGuard({
      home,
      controlId: id,
      invocationSha256: 'b'.repeat(64),
    });
    expect((await drift.run(() => true)).refusal?.reason).toBe('unavailable');
  });
});
