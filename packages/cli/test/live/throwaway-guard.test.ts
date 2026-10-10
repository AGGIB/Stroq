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
import { DEFAULT_POLICY } from '@stroq/core';
import { LiveCheckError } from '../../src/live/errors.js';
import { writePolicy } from '../../src/live/policy-digest.js';
import { clearSentinel, prepareProject } from '../../src/live/probes.js';
import { verifyHost } from '../../src/live/verify.js';
import { FakeHostDriver } from './fake-driver.js';
import { FAKE } from './helpers.js';
import { probe } from './probe-helpers.js';
import { makeRig, type Rig } from './rig.js';
import { verifyOptions } from './verify-harness.js';

/**
 * `prepareProject`, `clearSentinel`, `writePolicy` and `verifyHost` delete and overwrite files in the
 * directories they are given. Each of them first asks whether the directory is a throwaway one, and
 * when it is not, it throws before it touches anything: not the directory, not what is in it.
 */
const plain: string[] = [];
let rig: Rig;

const plainTemp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'stroq-live-guard-'));
  plain.push(dir);
  return dir;
};

const refuses = async (run: () => unknown): Promise<void> => {
  let thrown: unknown;
  try {
    await run();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(LiveCheckError);
  expect((thrown as LiveCheckError).code).toBe('unsafe-directory');
};

beforeEach(() => {
  rig = makeRig(false);
});
afterEach(() => {
  rig.cleanup();
  for (const dir of plain.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('prepareProject', () => {
  it('refuses a directory that is not a throwaway one, and removes and writes nothing there', async () => {
    const dir = plainTemp();
    writeFileSync(join(dir, 'stroq-live-allow.txt'), 'precious');
    await refuses(() => prepareProject(dir, FAKE));
    expect(readFileSync(join(dir, 'stroq-live-allow.txt'), 'utf8')).toBe('precious');
    expect(existsSync(join(dir, '.env'))).toBe(false);
  });

  it('refuses a directory that is not there at all, in the temporary directory, unmarked', async () => {
    const dir = join(plainTemp(), 'not-yet');
    await refuses(() => prepareProject(dir, FAKE));
    expect(existsSync(dir)).toBe(false);
  });

  it('works in the project of a throwaway root', () => {
    expect(() => prepareProject(rig.project, FAKE)).not.toThrow();
    expect(readFileSync(join(rig.project, '.env'), 'utf8')).toContain(FAKE);
  });

  // A project is reused when a run is retried, and a model had the run of it the time before: it can have
  // left a link where a file or a directory of ours goes. The key is written to a file of our own, and
  // nothing is removed through a link.
  it.skipIf(process.platform === 'win32')(
    'does not write the made-up key through a link left at .env, and leaves what it led to as it was',
    () => {
      const elsewhere = plainTemp();
      writeFileSync(join(elsewhere, 'target.txt'), 'the owner kept this');
      symlinkSync(join(elsewhere, 'target.txt'), join(rig.project, '.env'));
      prepareProject(rig.project, FAKE);
      expect(readFileSync(join(elsewhere, 'target.txt'), 'utf8')).toBe('the owner kept this');
      expect(lstatSync(join(rig.project, '.env')).isSymbolicLink()).toBe(false);
      expect(readFileSync(join(rig.project, '.env'), 'utf8')).toBe(`STROQ_LIVE_API_KEY=${FAKE}\n`);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'refuses a project whose .git is a link to a directory elsewhere, and removes nothing there',
    async () => {
      const elsewhere = plainTemp();
      mkdirSync(join(elsewhere, 'hooks'));
      writeFileSync(join(elsewhere, 'hooks', 'pre-commit'), "the owner's own hook");
      symlinkSync(elsewhere, join(rig.project, '.git'));
      await refuses(() => prepareProject(rig.project, FAKE));
      expect(readFileSync(join(elsewhere, 'hooks', 'pre-commit'), 'utf8')).toBe(
        "the owner's own hook",
      );
    },
  );

  it('is content with a file where the .git directory should be', () => {
    writeFileSync(join(rig.project, '.git'), 'a file where a directory should be');
    expect(() => prepareProject(rig.project, FAKE)).not.toThrow();
  });
});

describe('clearSentinel', () => {
  it('refuses a directory that is not a throwaway one, and removes nothing there', async () => {
    const dir = plainTemp();
    writeFileSync(join(dir, 'stroq-live-allow.txt'), 'precious');
    await refuses(() => clearSentinel(dir, probe('allow')));
    expect(readFileSync(join(dir, 'stroq-live-allow.txt'), 'utf8')).toBe('precious');
  });

  // The model has the run of the project while a request is made, and it can leave a link where a
  // directory should be. A file removed through it would be one of the owner's.
  it.skipIf(process.platform === 'win32')(
    'refuses a project whose .git is a link to a directory elsewhere, and removes nothing there',
    async () => {
      const elsewhere = plainTemp();
      mkdirSync(join(elsewhere, 'hooks'));
      writeFileSync(join(elsewhere, 'hooks', 'pre-commit'), "the owner's own hook");
      symlinkSync(elsewhere, join(rig.project, '.git'));
      await refuses(() => clearSentinel(rig.project, probe('deny')));
      expect(readFileSync(join(elsewhere, 'hooks', 'pre-commit'), 'utf8')).toBe(
        "the owner's own hook",
      );
    },
  );

  it.skipIf(process.platform === 'win32')(
    'removes a link that stands in the place of the file itself, and not what it leads to',
    () => {
      const elsewhere = plainTemp();
      writeFileSync(join(elsewhere, 'target.txt'), 'kept');
      symlinkSync(join(elsewhere, 'target.txt'), join(rig.project, 'stroq-live-allow.txt'));
      clearSentinel(rig.project, probe('allow'));
      expect(existsSync(join(rig.project, 'stroq-live-allow.txt'))).toBe(false);
      expect(readFileSync(join(elsewhere, 'target.txt'), 'utf8')).toBe('kept');
    },
  );

  it('is content when the directory above the file is not there', () => {
    expect(() => clearSentinel(rig.project, probe('deny'))).not.toThrow();
  });

  // Node 22 and Node 24 answer a removal below a file differently (ENOTDIR, and nothing); a model can leave
  // a file where a directory should be, and what is not there is not a reason to stop.
  it('is content with a file where the .git directory should be, on every Node', () => {
    writeFileSync(join(rig.project, '.git'), 'a file where a directory should be');
    expect(() => clearSentinel(rig.project, probe('deny'))).not.toThrow();
    expect(readFileSync(join(rig.project, '.git'), 'utf8')).toBe(
      'a file where a directory should be',
    );
  });
});

describe('writePolicy', () => {
  it('refuses a directory that is not a throwaway one, and writes nothing there', async () => {
    const dir = plainTemp();
    await refuses(() => writePolicy(dir, DEFAULT_POLICY));
    expect(existsSync(join(dir, 'policy.yaml'))).toBe(false);
  });

  it('works in the Stroq home of a throwaway root', () => {
    writePolicy(rig.stroqHome, DEFAULT_POLICY);
    expect(existsSync(join(rig.stroqHome, 'policy.yaml'))).toBe(true);
  });
});

describe('verifyHost', () => {
  const run = (
    base: Partial<Pick<Rig, 'project' | 'stroqHome' | 'home'>>,
    driver: FakeHostDriver,
  ) => verifyHost(driver, { ...rig.ctx(), ...base }, verifyOptions());

  it.each(['project', 'stroqHome', 'home'] as const)(
    'refuses an unsafe %s before it asks the host anything or touches anything',
    async (which) => {
      const driver = new FakeHostDriver({ fault: 'honest' });
      const dir = plainTemp();
      writeFileSync(join(dir, 'stroq-live-allow.txt'), 'precious');
      await refuses(() => run({ [which]: dir }, driver));
      expect(driver.detections).toBe(0);
      expect(driver.calls).toEqual([]);
      expect(readFileSync(join(dir, 'stroq-live-allow.txt'), 'utf8')).toBe('precious');
      expect(existsSync(join(dir, '.env'))).toBe(false);
      expect(existsSync(join(dir, 'policy.yaml'))).toBe(false);
    },
  );

  it('refuses the directory of a person even when the host is not there to be asked', async () => {
    const driver = new FakeHostDriver({ fault: 'honest', available: false });
    await refuses(() => run({ project: process.cwd() }, driver));
    expect(driver.detections).toBe(0);
  });
});
