import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { nodeFs } from '../../src/harden/atomic.js';
import { backupPath } from '../../src/harden/backup.js';
import { applyPlan } from '../../src/harden/index.js';
import { readManifest } from '../../src/harden/manifest.js';
import type { Fs } from '../../src/harden/types.js';
import { addDeny, engine, jsonText } from './engine-setup.js';
import { removeTempDirs } from './helpers.js';

afterEach(removeTempDirs);

/**
 * The window in which an owner's edit can be lost is the time between the last time the engine
 * looked at the file and the moment it replaces it. Before the copy and the record were made, the
 * look was a long way back (a copy is a write, a record is a write, and a write is flushed); it
 * is now made again at the very last point there is, and a file that has changed since it was
 * read is not replaced. This narrows the window to the time between one read and one rename. It
 * cannot close it: no portable call replaces a file only if it is unchanged.
 */
const THEIRS = jsonText({ model: 'theirs' });
const onWindows = process.platform === 'win32';

/** An Fs that runs `owner` once, right after the manifest has been written (the record is made). */
function ownerEditsAfterRecord(owner: () => void): Fs {
  let done = false;
  return {
    ...nodeFs,
    rename: async (from, to) => {
      await nodeFs.rename(from, to);
      if (!done && to.endsWith('manifest.json')) {
        done = true;
        owner();
      }
    },
  };
}

/** An Fs that runs `owner` once, when the temporary file of the target is made. */
function ownerEditsWhileWriting(name: string, owner: () => void): Fs {
  let done = false;
  return {
    ...nodeFs,
    open: (path, flags, mode) => {
      if (!done && basename(path).startsWith(`.${name}.stroq-`)) {
        done = true;
        owner();
      }
      return nodeFs.open(path, flags, mode);
    },
  };
}

const leftovers = (dir: string): string[] =>
  readdirSync(dir).filter((name) => name.endsWith('.tmp'));

describe('applyPlan: the file changes after the copy and the record were made', () => {
  it('does not replace it, and the owner’s edit is the file', async () => {
    const e = engine();
    writeFileSync(e.file('settings.json'), jsonText({ model: 'mine' }));
    const plan = e.planJson('settings.json', [addDeny('x')]);
    const fs = ownerEditsAfterRecord(() => writeFileSync(e.file('settings.json'), THEIRS));

    await expect(applyPlan(plan, { ...e.env, fs })).rejects.toMatchObject({ code: 'stale-plan' });

    expect(readFileSync(e.file('settings.json'), 'utf8')).toBe(THEIRS);
    expect(leftovers(e.project)).toEqual([]);
  });

  it('takes the record back, so that undo has nothing of a change that did not happen', async () => {
    const e = engine();
    writeFileSync(e.file('settings.json'), jsonText({ model: 'mine' }));
    const plan = e.planJson('settings.json', [addDeny('x')]);
    const fs = ownerEditsAfterRecord(() => writeFileSync(e.file('settings.json'), THEIRS));

    await expect(applyPlan(plan, { ...e.env, fs })).rejects.toBeDefined();

    expect(readManifest(e.env).files).toEqual({});
  });

  it('takes the copy back as well: a copy of a file that was not replaced is only clutter', async () => {
    const e = engine();
    writeFileSync(e.file('settings.json'), jsonText({ model: 'mine' }));
    const plan = e.planJson('settings.json', [addDeny('x')]);
    const fs = ownerEditsAfterRecord(() => writeFileSync(e.file('settings.json'), THEIRS));

    await expect(applyPlan(plan, { ...e.env, fs })).rejects.toBeDefined();

    expect(existsSync(join(e.home, 'backups')) ? readdirSync(join(e.home, 'backups')) : []).toEqual(
      [],
    );
  });

  it('refuses when the owner deleted the file', async () => {
    const e = engine();
    writeFileSync(e.file('settings.json'), jsonText({ model: 'mine' }));
    const plan = e.planJson('settings.json', [addDeny('x')]);
    const fs = ownerEditsAfterRecord(() => unlinkSync(e.file('settings.json')));

    await expect(applyPlan(plan, { ...e.env, fs })).rejects.toMatchObject({ code: 'stale-plan' });

    expect(existsSync(e.file('settings.json'))).toBe(false);
    expect(readManifest(e.env).files).toEqual({});
  });

  it('refuses when a file that was not there has appeared, and does not replace it', async () => {
    const e = engine();
    const plan = e.planJson('settings.json', [addDeny('x')]);
    const fs = ownerEditsAfterRecord(() => writeFileSync(e.file('settings.json'), THEIRS));

    await expect(applyPlan(plan, { ...e.env, fs })).rejects.toMatchObject({ code: 'stale-plan' });

    expect(readFileSync(e.file('settings.json'), 'utf8')).toBe(THEIRS);
    expect(readManifest(e.env).files).toEqual({});
  });
});

describe('applyPlan: the file changes while the new content is being written', () => {
  it('does not replace it, removes the temporary file, and leaves the owner’s edit', async () => {
    const e = engine();
    writeFileSync(e.file('settings.json'), jsonText({ model: 'mine' }));
    const plan = e.planJson('settings.json', [addDeny('x')]);
    const fs = ownerEditsWhileWriting('settings.json', () =>
      writeFileSync(e.file('settings.json'), THEIRS),
    );

    await expect(applyPlan(plan, { ...e.env, fs })).rejects.toMatchObject({ code: 'stale-plan' });

    expect(readFileSync(e.file('settings.json'), 'utf8')).toBe(THEIRS);
    expect(leftovers(e.project)).toEqual([]);
    expect(readManifest(e.env).files).toEqual({});
  });

  it.skipIf(onWindows)(
    'refuses when the path was pointed at another file in the meantime, and touches neither',
    async () => {
      const e = engine();
      writeFileSync(e.file('settings.json'), jsonText({ model: 'mine' }));
      const other = jsonText({ model: 'other' });
      writeFileSync(e.file('other.json'), other);
      const plan = e.planJson('settings.json', [addDeny('x')]);
      const fs = ownerEditsWhileWriting('settings.json', () => {
        unlinkSync(e.file('settings.json'));
        symlinkSync(e.file('other.json'), e.file('settings.json'));
      });

      await expect(applyPlan(plan, { ...e.env, fs })).rejects.toMatchObject({ code: 'stale-plan' });

      expect(readFileSync(e.file('other.json'), 'utf8')).toBe(other);
      expect(readManifest(e.env).files).toEqual({});
    },
  );
});

/** An Fs whose first rename onto `name` is refused as busy, and the owner saves while it is. */
function busyWhileOwnerSaves(name: string, owner: () => void): Fs {
  let done = false;
  return {
    ...nodeFs,
    rename: (from, to) => {
      if (done || !to.endsWith(name)) return nodeFs.rename(from, to);
      done = true;
      owner();
      return Promise.reject(Object.assign(new Error('simulated busy file'), { code: 'EBUSY' }));
    },
  };
}

describe('applyPlan: the file changes while a busy rename is waited for', () => {
  it('does not replace it after the wait, and the owner’s save is the file', async () => {
    const e = engine();
    writeFileSync(e.file('settings.json'), jsonText({ model: 'mine' }));
    const plan = e.planJson('settings.json', [addDeny('x')]);
    const fs = busyWhileOwnerSaves('settings.json', () =>
      writeFileSync(e.file('settings.json'), THEIRS),
    );

    await expect(applyPlan(plan, { ...e.env, fs })).rejects.toMatchObject({ code: 'stale-plan' });

    expect(readFileSync(e.file('settings.json'), 'utf8')).toBe(THEIRS);
    expect(leftovers(e.project)).toEqual([]);
  });

  it('takes back the record and the copy, as for any apply that did not go through', async () => {
    const e = engine();
    writeFileSync(e.file('settings.json'), jsonText({ model: 'mine' }));
    const plan = e.planJson('settings.json', [addDeny('x')]);
    const fs = busyWhileOwnerSaves('settings.json', () =>
      writeFileSync(e.file('settings.json'), THEIRS),
    );

    await expect(applyPlan(plan, { ...e.env, fs })).rejects.toBeDefined();

    expect(readManifest(e.env).files).toEqual({});
    expect(existsSync(join(e.home, 'backups')) ? readdirSync(join(e.home, 'backups')) : []).toEqual(
      [],
    );
  });

  it('still goes through when the file did not change during the wait', async () => {
    const e = engine();
    writeFileSync(e.file('settings.json'), jsonText({ model: 'mine' }));
    const plan = e.planJson('settings.json', [addDeny('x')]);
    const fs = busyWhileOwnerSaves('settings.json', () => undefined);

    const result = await applyPlan(plan, { ...e.env, fs });

    expect(result.changed).toBe(true);
    expect(readFileSync(e.file('settings.json'), 'utf8')).toBe(plan.after);
  });
});

describe('applyPlan: the copy is the bytes that were read', () => {
  it('keeps every byte of a file with a byte order mark, CRLF line ends and non-ASCII text', async () => {
    const e = engine();
    const original = Buffer.from(`\u{FEFF}{\r\n  "name": "café \u{1f600}"\r\n}\r\n`, 'utf8');
    writeFileSync(e.file('settings.json'), original);
    const plan = e.planJson('settings.json', [addDeny('x')]);

    const result = await applyPlan(plan, e.env);

    const copy = readFileSync(backupPath(e.home, result.backup?.id ?? '', plan.real));
    expect([...copy]).toEqual([...original]);
  });

  it('keeps no copy of a file that did not exist', async () => {
    const e = engine();
    mkdirSync(join(e.project, 'sub'), { recursive: true });
    const plan = e.planJson('sub/new.json', [addDeny('x')]);

    const result = await applyPlan(plan, e.env);

    expect(result.backup).toBeNull();
  });
});

describe('applyPlan: when it does not go through, it leaves nothing of its own', () => {
  it('removes the copy when the write fails', async () => {
    const e = engine();
    writeFileSync(e.file('settings.json'), jsonText({ model: 'mine' }));
    const plan = e.planJson('settings.json', [addDeny('x')]);
    const fs: Fs = {
      ...nodeFs,
      rename: (from, to) =>
        to.endsWith('settings.json')
          ? Promise.reject(new Error('simulated trouble'))
          : nodeFs.rename(from, to),
    };

    await expect(applyPlan(plan, { ...e.env, fs })).rejects.toThrow(/simulated trouble/);

    expect(existsSync(join(e.home, 'backups')) ? readdirSync(join(e.home, 'backups')) : []).toEqual(
      [],
    );
  });

  it('removes the copy when it cannot make the record', async () => {
    const e = engine();
    writeFileSync(e.file('settings.json'), jsonText({ model: 'mine' }));
    const plan = e.planJson('settings.json', [addDeny('x')]);
    const fs: Fs = {
      ...nodeFs,
      rename: (from, to) =>
        to.endsWith('manifest.json')
          ? Promise.reject(new Error('simulated trouble'))
          : nodeFs.rename(from, to),
    };

    await expect(applyPlan(plan, { ...e.env, fs })).rejects.toThrow(/simulated trouble/);

    expect(existsSync(join(e.home, 'backups')) ? readdirSync(join(e.home, 'backups')) : []).toEqual(
      [],
    );
  });

  it('does not remove a copy from an earlier apply', async () => {
    const e = engine();
    writeFileSync(e.file('settings.json'), jsonText({ model: 'mine' }));
    const first = await applyPlan(e.planJson('settings.json', [addDeny('a')]), e.env);
    const plan = e.planJson('settings.json', [addDeny('b')]);
    const fs = ownerEditsAfterRecord(() => writeFileSync(e.file('settings.json'), THEIRS));

    await expect(applyPlan(plan, { ...e.env, fs })).rejects.toBeDefined();

    expect(readdirSync(join(e.home, 'backups'))).toEqual([first.backup?.id]);
  });
});
