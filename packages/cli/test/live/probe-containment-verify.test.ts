import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openLedger } from '../../src/live/budget.js';
import type { HostDriver } from '../../src/live/types.js';
import { FakeHostDriver } from './fake-driver.js';
import { makeRig, type Rig } from './rig.js';
import { marksOf, verify } from './verify-harness.js';

/**
 * A whole run when the file of the deny probe has a directory in front of it. The real probes keep their
 * files in the root of the project, so there is no such run today; this one gives the deny probe a nested
 * file (the only thing changed) to keep proof that a run which finds a link in the way ends there, with
 * the reason, keeps what the requests before it found, and never lets a control write through the link.
 * Nothing else about the probes is changed, so the command the hook judges is the real one.
 */
const NESTED = vi.hoisted(() => 'sub/dir/marker.txt');
vi.mock('../../src/live/probes.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/live/probes.js')>();
  return {
    ...real,
    buildProbes: (...args: Parameters<typeof real.buildProbes>) =>
      real.buildProbes(...args).map((p) =>
        p.kind === 'deny' ? { ...p, sentinel: { ...p.sentinel, file: NESTED } } : p,
      ),
  };
});

let rig: Rig;
let elsewhere: string;
beforeEach(() => {
  rig = makeRig();
  elsewhere = mkdtempSync(join(tmpdir(), 'stroq-live-nested-'));
});
afterEach(() => {
  rig.cleanup();
  rmSync(elsewhere, { recursive: true, force: true });
});

/** A driver that is the stand-in host, and plants a link at `sub` once the request `after` has been made. */
function planting(inner: FakeHostDriver, after: (kind: string, hook: string) => boolean): HostDriver {
  return {
    detect: () => inner.detect(),
    run: async (probe, ctx) => {
      const run = await inner.run(probe, ctx);
      if (after(probe.kind, ctx.hookMode)) symlinkSync(elsewhere, join(ctx.project, 'sub'));
      return run;
    },
  };
}

describe.skipIf(process.platform === 'win32')('a run that finds a link in the way of a probe file', () => {
  // The model has the run of the project while a request is made. A link left where a directory of the next
  // probe's way should be makes the file unsafe to clear, and that is a thing for the result to say: the
  // requests before it are paid for and kept, and the run ends there, not with an exception.
  it('stops before a request that would clear through it, and keeps the earlier evidence', async () => {
    const inner = new FakeHostDriver({ fault: 'honest' });
    const ledger = openLedger({ memory: true, limit: 30 });
    const result = await verify(rig, planting(inner, (kind) => kind === 'allow'), {
      ledger,
      maxRequests: 3,
    });
    expect(result.state).toBe('inconclusive');
    expect(marksOf(result)).toEqual({
      allow: 'passed:ran',
      deny: 'not-attempted:unsafe-directory',
      'secret-egress': 'not-attempted:unsafe-directory',
    });
    expect(inner.calls).toHaveLength(1);
    expect(await ledger.peek()).toMatchObject({ used: 1 });
    expect(existsSync(join(elsewhere, 'dir'))).toBe(false);
  });

  it('ends the run at the control, and keeps what the requests before it found', async () => {
    mkdirSync(join(elsewhere, 'dir'));
    const inner = new FakeHostDriver({ fault: 'honest' });
    const ledger = openLedger({ memory: true, limit: 30 });
    const driver = planting(inner, (kind, hook) => kind === 'deny' && hook === 'real');
    const result = await verify(rig, driver, { ledger });
    expect(marksOf(result)).toEqual({
      allow: 'passed:ran',
      deny: 'inconclusive:control-inconclusive',
      'deny:control': 'not-attempted:unsafe-directory',
      'secret-egress': 'not-attempted:unsafe-directory',
    });
    expect(result.state).toBe('inconclusive');
    // Two requests were made and paid for; the third was never taken from the ledger.
    expect(await ledger.peek()).toMatchObject({ used: 2 });
    expect(existsSync(join(elsewhere, 'dir', 'marker.txt'))).toBe(false);
  });
});
