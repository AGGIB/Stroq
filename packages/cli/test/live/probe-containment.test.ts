import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openLedger } from '../../src/live/budget.js';
import { clearSentinel, prepareProject } from '../../src/live/probes.js';
import { makeRequest } from '../../src/live/request.js';
import type { HostDriver } from '../../src/live/types.js';
import { FakeHostDriver } from './fake-driver.js';
import { FAKE } from './helpers.js';
import { probe } from './probe-helpers.js';
import { makeRig, type Rig } from './rig.js';
import { marksOf, verify } from './verify-harness.js';

let rig: Rig;
let elsewhere: string;
beforeEach(() => {
  rig = makeRig();
  elsewhere = mkdtempSync(join(tmpdir(), 'stroq-live-decoy-'));
});
afterEach(() => {
  rig.cleanup();
  rmSync(elsewhere, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('probe ancestors that are links', () => {
  it.each(['missing-hooks', 'dangling', 'loop'] as const)(
    'refuses a %s ancestor before spending a request or calling the driver',
    async (kind) => {
      const link = join(rig.project, '.git');
      const target =
        kind === 'loop' ? link : kind === 'dangling' ? join(elsewhere, 'missing') : elsewhere;
      symlinkSync(target, link);
      const ledger = openLedger({ memory: true, limit: 30 });
      const driver = new FakeHostDriver({ fault: 'honest' });
      const requested = await makeRequest({
        driver,
        ledger,
        label: 'containment regression',
        probe: probe('deny'),
        ctx: rig.ctx({ hookMode: 'noop' }),
        graceMs: 50,
      });
      expect(requested).toMatchObject({ sent: false, reason: 'unsafe-directory' });
      expect(driver.calls).toEqual([]);
      expect(await ledger.peek()).toMatchObject({ used: 0 });
      expect(existsSync(join(elsewhere, 'hooks'))).toBe(false);
    },
  );

  it.each(['missing-hooks', 'dangling'] as const)(
    'refuses a reused project with a %s ancestor before preparing it',
    (kind) => {
      const target = kind === 'dangling' ? join(elsewhere, 'missing') : elsewhere;
      symlinkSync(target, join(rig.project, '.git'));
      expect(() => prepareProject(rig.project, FAKE)).toThrow(
        expect.objectContaining({ code: 'unsafe-directory' }),
      );
      expect(existsSync(join(elsewhere, 'hooks'))).toBe(false);
    },
  );

  it('allows missing directories below a link whose target stays in the project', () => {
    const target = join(rig.project, 'internal');
    mkdirSync(target);
    symlinkSync(target, join(rig.project, '.git'));
    expect(() => clearSentinel(rig.project, probe('deny'))).not.toThrow();
    expect(() => prepareProject(rig.project, FAKE)).not.toThrow();
  });

  it('keeps earlier evidence and stops before a control can write through a new external link', async () => {
    const fake = new FakeHostDriver({ fault: 'honest' });
    const driver: HostDriver = {
      detect: () => fake.detect(),
      run: async (p, ctx) => {
        const result = await fake.run(p, ctx);
        if (p.kind === 'allow') symlinkSync(elsewhere, join(ctx.project, '.git'));
        return result;
      },
    };
    const ledger = openLedger({ memory: true, limit: 30 });
    const result = await verify(rig, driver, { ledger, maxRequests: 3 });
    expect(result.state).toBe('inconclusive');
    expect(marksOf(result)).toEqual({
      allow: 'passed:ran',
      deny: 'not-attempted:unsafe-directory',
      'secret-egress': 'not-attempted:unsafe-directory',
    });
    expect(fake.calls).toHaveLength(1);
    expect(await ledger.peek()).toMatchObject({ used: 1 });
    expect(existsSync(join(elsewhere, 'hooks'))).toBe(false);
  });
});
