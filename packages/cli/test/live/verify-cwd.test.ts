import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openLedger } from '../../src/live/budget.js';
import type { HostDriver, HostRun, ProbeContext } from '../../src/live/types.js';
import { FakeHostDriver } from './fake-driver.js';
import { makeRig, type Rig } from './rig.js';
import { marksOf, verify } from './verify-harness.js';

/**
 * The host is started in the project of the check, and the hook it runs judges commands from there (the
 * made-up key is looked for in the project's own `.env`). A host that says it ran somewhere else has had its
 * commands judged in another place, so nothing it did can be held against it or for it, and nothing more is
 * asked of it. A host that does not say where it runs is not held to anything.
 */
let rig: Rig;
beforeEach(() => {
  rig = makeRig(false);
});
afterEach(() => {
  rig.cleanup();
});

/** The stand-in host, saying it ran in whatever `where` makes of the context. */
function inDirectory(where: (ctx: ProbeContext, n: number) => string | undefined): HostDriver & {
  seen: number;
} {
  const inner = new FakeHostDriver({ fault: 'honest' });
  const driver = {
    seen: 0,
    detect: () => inner.detect(),
    run: async (probe: Parameters<HostDriver['run']>[0], ctx: ProbeContext): Promise<HostRun> => {
      driver.seen += 1;
      const run = await inner.run(probe, ctx);
      const cwd = where(ctx, driver.seen);
      const { cwd: _said, ...rest } = run;
      return cwd === undefined ? rest : { ...rest, cwd };
    },
  };
  return driver;
}

describe('a host that says where it ran', () => {
  it('is let go on when it says the project', async () => {
    const driver = inDirectory((ctx) => ctx.project);
    const result = await verify(rig, driver);
    expect(result.state).toBe('verified');
  });

  it.skipIf(process.platform === 'win32')(
    'is let go on when it says the project by another name for the same directory',
    async () => {
      const alias = join(rig.root, 'alias');
      symlinkSync(rig.project, alias);
      const result = await verify(
        rig,
        inDirectory(() => alias),
      );
      expect(result.state).toBe('verified');
    },
  );

  it('is let go on when it says nothing of where it ran', async () => {
    const result = await verify(
      rig,
      inDirectory(() => undefined),
    );
    expect(result.state).toBe('verified');
  });

  it.each([
    ['another directory that is there', (ctx: ProbeContext) => ctx.home],
    ['a directory that is not there', () => join(rig.root, 'not-there')],
    ['the directory above the project', (ctx: ProbeContext) => join(ctx.project, '..')],
    ['an empty path', () => ''],
    ['a path made of escapes', () => '\u001b[2J/etc'],
  ])('is stopped when it says %s, after that one request', async (_name, where) => {
    const driver = inDirectory(where);
    const ledger = openLedger({ memory: true, limit: 30 });
    const result = await verify(rig, driver, { ledger });
    expect(marksOf(result)).toEqual({
      allow: 'inconclusive:cwd-mismatch',
      deny: 'not-attempted:cwd-mismatch',
      'secret-egress': 'not-attempted:cwd-mismatch',
    });
    expect(driver.seen).toBe(1);
    expect(await ledger.peek()).toMatchObject({ used: 1 });
    expect(result.state).toBe('inconclusive');
    for (const probe of result.probes) expect(probe.detail ?? '').toMatch(/^[\x20-\x7e]*$/);
  });

  it('keeps the evidence of the request that was made, and says in a line what was wrong', async () => {
    const result = await verify(
      rig,
      inDirectory((ctx) => ctx.home),
    );
    expect(result.probes[0]).toMatchObject({
      mark: 'inconclusive',
      reason: 'cwd-mismatch',
      evidence: { E1: true, E2: true, E3: true },
    });
    expect(result.probes[0]?.detail).toMatch(/not in the project/);
  });

  it('is stopped at a later request too, and what was found before it is kept', async () => {
    const driver = inDirectory((ctx, n) => (n < 2 ? ctx.project : ctx.home));
    const result = await verify(rig, driver);
    expect(marksOf(result)).toEqual({
      allow: 'passed:ran',
      deny: 'inconclusive:cwd-mismatch',
      'secret-egress': 'not-attempted:cwd-mismatch',
    });
    expect(driver.seen).toBe(2);
  });
});
