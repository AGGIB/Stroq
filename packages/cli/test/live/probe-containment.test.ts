import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openLedger } from '../../src/live/budget.js';
import {
  ALLOW_FILE,
  DENY_FILE,
  EGRESS_FILE,
  clearSentinel,
  prepareProject,
} from '../../src/live/probes.js';
import { makeRequest } from '../../src/live/request.js';
import type { HostDriver } from '../../src/live/types.js';
import { FakeHostDriver } from './fake-driver.js';
import { FAKE } from './helpers.js';
import { nestedProbe } from './probe-helpers.js';
import { makeRig, type Rig } from './rig.js';
import { marksOf, verify } from './verify-harness.js';

/**
 * The model has the run of the project while a request is made, so a link can be left where the check
 * will clear or write next. The real probes keep their files in the root of the project, so the only way to
 * a file that goes through a directory is a probe whose file is nested (`nestedProbe`); the check has to
 * stay inside the project for that path all the same, and for the root files it has to remove a link as
 * the link and not follow it.
 */
const OWNER_TEXT = "the owner's own file";
const PROBE_FILES = [ALLOW_FILE, DENY_FILE, EGRESS_FILE] as const;

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

const isThere = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

describe.skipIf(process.platform === 'win32')('probe ancestors that are links', () => {
  // `missing-below` is a link to a directory that exists and lacks the next directory of the way: writing
  // through it would make that directory outside the project.
  it.each(['missing-below', 'dangling', 'loop'] as const)(
    'refuses a %s ancestor before spending a request or calling the driver',
    async (kind) => {
      const link = join(rig.project, 'sub');
      const target =
        kind === 'loop' ? link : kind === 'dangling' ? join(elsewhere, 'missing') : elsewhere;
      symlinkSync(target, link);
      const ledger = openLedger({ memory: true, limit: 30 });
      const driver = new FakeHostDriver({ fault: 'honest' });
      const requested = await makeRequest({
        driver,
        ledger,
        label: 'containment regression',
        probe: nestedProbe(),
        ctx: rig.ctx({ hookMode: 'noop' }),
        graceMs: 50,
      });
      expect(requested).toMatchObject({ sent: false, reason: 'unsafe-directory' });
      expect(driver.calls).toEqual([]);
      expect(await ledger.peek()).toMatchObject({ used: 0 });
      expect(existsSync(join(elsewhere, 'dir'))).toBe(false);
    },
  );

  it.each(['missing-below', 'dangling'] as const)(
    'refuses to clear a nested file through a %s ancestor in a reused project',
    (kind) => {
      const target = kind === 'dangling' ? join(elsewhere, 'missing') : elsewhere;
      symlinkSync(target, join(rig.project, 'sub'));
      expect(() => clearSentinel(rig.project, nestedProbe())).toThrow(
        expect.objectContaining({ code: 'unsafe-directory' }),
      );
      expect(existsSync(join(elsewhere, 'dir'))).toBe(false);
    },
  );

  it('allows missing directories below a link whose target stays in the project', () => {
    const target = join(rig.project, 'internal');
    mkdirSync(target);
    symlinkSync(target, join(rig.project, 'sub'));
    expect(() => clearSentinel(rig.project, nestedProbe())).not.toThrow();
    expect(() => prepareProject(rig.project, FAKE)).not.toThrow();
  });
});

// `prepareProject` clears only the files the probes name, all in the root of the project, so there is no
// directory in front of them for a link to stand in. A link in the place of a file itself is removed as the
// link: what it leads to is not opened, written or removed.
describe.skipIf(process.platform === 'win32')('probe files that are links', () => {
  it.each(['external', 'dangling', 'loop'] as const)(
    'removes an %s link in the place of each probe file in a reused project, and touches nothing it led to',
    (kind) => {
      const owner = join(elsewhere, 'owner.txt');
      writeFileSync(owner, OWNER_TEXT);
      for (const file of PROBE_FILES) {
        const link = join(rig.project, file);
        const target =
          kind === 'loop' ? link : kind === 'dangling' ? join(elsewhere, 'missing') : owner;
        symlinkSync(target, link);
      }
      expect(() => prepareProject(rig.project, FAKE)).not.toThrow();
      for (const file of PROBE_FILES) expect(isThere(join(rig.project, file))).toBe(false);
      expect(readFileSync(owner, 'utf8')).toBe(OWNER_TEXT);
      expect(existsSync(join(elsewhere, 'missing'))).toBe(false);
    },
  );

  // The whole run: the model leaves a link at the file of the next probe, and the check clears it before
  // that request, so the control that writes the file later writes it in the project and not through the link.
  it('clears a link planted at the next probe file, and the run goes on without touching what it led to', async () => {
    const owner = join(elsewhere, 'owner.txt');
    writeFileSync(owner, OWNER_TEXT);
    const fake = new FakeHostDriver({ fault: 'honest' });
    const driver: HostDriver = {
      detect: () => fake.detect(),
      run: async (p, ctx) => {
        const result = await fake.run(p, ctx);
        if (p.kind === 'allow') symlinkSync(owner, join(ctx.project, DENY_FILE));
        return result;
      },
    };
    const ledger = openLedger({ memory: true, limit: 30 });
    const result = await verify(rig, driver, { ledger });
    expect(marksOf(result)).toEqual({
      allow: 'passed:ran',
      deny: 'passed:blocked',
      'deny:control': 'passed:armed',
      'secret-egress': 'passed:blocked',
      'secret-egress:control': 'passed:armed',
    });
    expect(fake.calls).toHaveLength(5);
    expect(readFileSync(owner, 'utf8')).toBe(OWNER_TEXT);
  });
});
