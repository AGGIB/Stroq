import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { nodeFs } from '../../src/harden/atomic.js';
import {
  BACKUPS_KEPT_PER_FILE,
  backupFile,
  backupPath,
  newBackupId,
  readBackup,
  removeBackup,
} from '../../src/harden/backup.js';
import { HardenError, type Fs } from '../../src/harden/types.js';
import { fakeEnv, removeTempDirs, steppingClock, tempDir } from './helpers.js';

afterEach(removeTempDirs);

const onWindows = process.platform === 'win32';
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const bytes = (text: string): Uint8Array => Buffer.from(text, 'utf8');
const FAKE_SECRET = 'stroq_attack_fixture_value_0123456789';

/** A home, an env around it, and the real path of a file somebody else owns. */
function setup() {
  const home = tempDir('home');
  const real = join(tempDir('project'), '.claude', 'settings.json');
  return { home, real, env: fakeEnv(home) };
}

const copiesOf = (home: string, real: string): string[] => {
  const root = join(home, 'backups');
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((id) => existsSync(join(root, id, `${sha256(real)}.bak`)))
    .sort();
};

describe('backupFile: what it stores', () => {
  it('keeps the bytes under backups/<id>/<sha256 of the real path>.bak', async () => {
    const { home, real, env } = setup();

    const result = await backupFile(env, real, bytes('{"a":1}\n'), 'b1');

    expect(result).toEqual({ id: 'b1', stored: true });
    const file = join(home, 'backups', 'b1', `${sha256(real)}.bak`);
    expect(readFileSync(file, 'utf8')).toBe('{"a":1}\n');
    expect(backupPath(home, 'b1', real)).toBe(file);
  });

  it('keeps the bytes exactly, whatever they are', async () => {
    const { home, real, env } = setup();
    const odd = new Uint8Array([0xef, 0xbb, 0xbf, 0xff, 0xfe, 0x00, 0x0d, 0x0a, 0x7b]);

    await backupFile(env, real, odd, 'b1');

    expect([...readFileSync(backupPath(home, 'b1', real))]).toEqual([...odd]);
  });

  it('stores a copy of an empty file too', async () => {
    const { home, real, env } = setup();

    const result = await backupFile(env, real, new Uint8Array(), 'b1');

    expect(result.stored).toBe(true);
    expect(readFileSync(backupPath(home, 'b1', real)).length).toBe(0);
  });

  it('writes the same id and file again without trouble, the later bytes winning', async () => {
    const { home, real, env } = setup();

    await backupFile(env, real, bytes('one'), 'b1');
    await backupFile(env, real, bytes('two'), 'b1');

    expect(readFileSync(backupPath(home, 'b1', real), 'utf8')).toBe('two');
  });

  describe.skipIf(onWindows)('who can read it', () => {
    // `umask(0)` so that the modes asked for are the modes seen, as `hook-stamp.test.ts` does.
    it('is private to its owner: directories 0700, the file 0600', async () => {
      const { home, real, env } = setup();

      const previous = process.umask(0);
      try {
        await backupFile(env, real, bytes('x'), 'b1');
      } finally {
        process.umask(previous);
      }

      expect(statSync(join(home, 'backups')).mode & 0o777).toBe(0o700);
      expect(statSync(join(home, 'backups', 'b1')).mode & 0o777).toBe(0o700);
      expect(statSync(backupPath(home, 'b1', real)).mode & 0o777).toBe(0o600);
    });

    it('tightens a backups directory that was left more open', async () => {
      const { home, real, env } = setup();
      mkdirSync(join(home, 'backups'));
      chmodSync(join(home, 'backups'), 0o755);

      await backupFile(env, real, bytes('x'), 'b1');

      expect(statSync(join(home, 'backups')).mode & 0o777).toBe(0o700);
    });
  });
});

describe('backupFile: a file that holds a credential', () => {
  it.each([
    ['a vendor token', JSON.stringify({ note: 'ghp_0123456789abcdefghijklmnop' })],
    ['a secret under a name that says so', JSON.stringify({ env: { API_TOKEN: FAKE_SECRET } })],
    ['a line of an env file', `API_TOKEN=${FAKE_SECRET}\n`],
  ])('stores no copy of a file with %s in it, and says why', async (_name, text) => {
    const { home, real, env } = setup();

    const result = await backupFile(env, real, bytes(text), 'b1');

    expect(result).toEqual({
      id: 'b1',
      stored: false,
      reason: 'the file holds credential-shaped text',
    });
    expect(existsSync(join(home, 'backups'))).toBe(false);
    expect(existsSync(home) ? readdirSync(home) : []).toEqual([]);
  });

  it('says the file was too large to check, when that is why there is no copy', async () => {
    const { home, real, env } = setup();

    const result = await backupFile(env, real, bytes('x'.repeat(2 * 1024 * 1024 + 1)), 'b1');

    expect(result).toEqual({
      id: 'b1',
      stored: false,
      reason: 'the file is too large to check for credential-shaped text',
    });
    expect(existsSync(join(home, 'backups'))).toBe(false);
  });

  it('never puts the credential in the reason', async () => {
    const { real, env } = setup();

    const result = await backupFile(env, real, bytes(`API_TOKEN=${FAKE_SECRET}\n`), 'b1');

    expect(JSON.stringify(result)).not.toContain(FAKE_SECRET);
  });
});

describe('backupFile: which five copies of a file are kept', () => {
  const idsFor = (count: number): string[] => {
    const clock = steppingClock();
    return Array.from({ length: count }, () => newBackupId(clock()));
  };

  // The first copy is the file as it was before Stroq ever touched it. Keeping the newest five
  // would throw it away at the sixth apply, and with it the only way back to what the owner wrote.
  it('keeps the first copy and the newest four, and removes the ones between, with the directories they leave empty', async () => {
    const { home, real, env } = setup();
    const ids = idsFor(7);

    for (const id of ids) await backupFile(env, real, bytes(`copy ${id}`), id);

    expect(BACKUPS_KEPT_PER_FILE).toBe(5);
    expect(copiesOf(home, real)).toEqual([ids[0], ...ids.slice(3)]);
    expect(readdirSync(join(home, 'backups')).sort()).toEqual([ids[0], ...ids.slice(3)]);
    expect(readFileSync(backupPath(home, ids[0] ?? '', real), 'utf8')).toBe(`copy ${ids[0]}`);
    expect(readFileSync(backupPath(home, ids[6] ?? '', real), 'utf8')).toBe(`copy ${ids[6]}`);
  });

  it('keeps all of them while there are five or fewer', async () => {
    const { home, real, env } = setup();
    const ids = idsFor(5);

    for (const id of ids) await backupFile(env, real, bytes('x'), id);

    expect(copiesOf(home, real)).toEqual(ids);
  });

  it('keeps the first copy however many come after it', async () => {
    const { home, real, env } = setup();
    const ids = idsFor(25);

    for (const id of ids) await backupFile(env, real, bytes(`copy ${id}`), id);

    expect(copiesOf(home, real)).toEqual([ids[0], ...ids.slice(-4)]);
    expect(readFileSync(backupPath(home, ids[0] ?? '', real), 'utf8')).toBe(`copy ${ids[0]}`);
  });

  it('keeps five per file, and never touches the copies of another file', async () => {
    const { home, real, env } = setup();
    const other = join(tempDir('other'), 'settings.json');
    const ids = idsFor(7);

    for (const id of ids.slice(0, 2)) await backupFile(env, other, bytes('other'), id);
    for (const id of ids) await backupFile(env, real, bytes('this'), id);

    expect(copiesOf(home, real)).toEqual([ids[0], ...ids.slice(3)]);
    expect(copiesOf(home, other)).toEqual(ids.slice(0, 2));
    // The directory of the third copy held nothing else, and is gone; the first two still hold
    // the other file’s copies.
    expect(readdirSync(join(home, 'backups')).sort()).toEqual(ids.filter((id) => id !== ids[2]));
  });

  it('never removes the copy it has just written, even if its id sorts oldest', async () => {
    const { home, real, env } = setup();
    const ids = idsFor(6);
    for (const id of ids.slice(1)) await backupFile(env, real, bytes('later'), id);

    await backupFile(env, real, bytes('earlier id'), ids[0] ?? '');

    const kept = copiesOf(home, real);
    expect(kept).toHaveLength(5);
    expect(kept).toContain(ids[0]);
  });

  it('never removes the copy it has just written, even if its id sorts in the middle of the rest', async () => {
    const { home, real, env } = setup();
    const ids = idsFor(9);
    const middle = ids[2] ?? '';
    for (const index of [0, 5, 6, 7, 8])
      await backupFile(env, real, bytes('copy'), ids[index] ?? '');

    await backupFile(env, real, bytes('between'), middle);

    // The first copy, the four newest, and the one just written, which is neither.
    expect(copiesOf(home, real)).toEqual([ids[0], middle, ...ids.slice(5)]);
  });

  it('keeps going when it cannot remove an old copy', async () => {
    const { home, real, env } = setup();
    const ids = idsFor(6);
    const fs: Fs = { ...nodeFs, unlink: () => Promise.reject(new Error('simulated EPERM')) };

    for (const id of ids) await backupFile({ ...env, fs }, real, bytes('x'), id);

    expect(copiesOf(home, real)).toEqual(ids);
  });
});

describe('backupFile: ids', () => {
  it.each([
    ['empty', ''],
    ['a dot', '.'],
    ['two dots', '..'],
    ['a path up', '../escape'],
    ['a path down', 'a/b'],
    ['a backslash', 'a\\b'],
    ['a leading dot', '.hidden'],
    ['a space', 'a b'],
    ['a newline', 'a\nb'],
    ['too long', 'x'.repeat(65)],
  ])('rejects an id that is %s, and writes nothing', async (_name, id) => {
    const { home, real, env } = setup();

    const error = await backupFile(env, real, bytes('x'), id).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(HardenError);
    expect(error).toMatchObject({ code: 'invalid-backup-id' });
    expect(existsSync(join(home, 'backups'))).toBe(false);
  });

  it('makes ids that sort by time and never repeat', () => {
    const clock = steppingClock();
    const first = newBackupId(clock());
    const second = newBackupId(clock());
    const sameInstant = [newBackupId(new Date(0)), newBackupId(new Date(0))];

    expect(first).toMatch(/^\d{8}T\d{9}Z-[0-9a-f]{6}$/);
    expect(first < second).toBe(true);
    expect(sameInstant[0]).not.toBe(sameInstant[1]);
  });
});

describe('backupFile: where it writes', () => {
  // Asked before any directory is made: `mkdir` and `chmod` follow a link, and would change a
  // directory somewhere else before the write itself was refused.
  it.skipIf(onWindows)(
    'refuses a backups directory that is a link out of the home, touching nothing',
    async () => {
      const { home, real, env } = setup();
      const outside = tempDir('outside');
      chmodSync(outside, 0o755);
      symlinkSync(outside, join(home, 'backups'));
      const touched: string[] = [];
      const fs: Fs = {
        ...nodeFs,
        mkdir: (path, options) => (touched.push(`mkdir ${path}`), nodeFs.mkdir(path, options)),
        chmod: (path, mode) => (touched.push(`chmod ${path}`), nodeFs.chmod(path, mode)),
      };

      await expect(backupFile({ ...env, fs }, real, bytes('x'), 'b1')).rejects.toMatchObject({
        code: 'path-escapes-root',
      });

      expect(touched).toEqual([]);
      expect(readdirSync(outside)).toEqual([]);
      expect(statSync(outside).mode & 0o777).toBe(0o755);
    },
  );

  it.skipIf(onWindows)(
    'works in a home that is itself a link, as a dotfile manager leaves it',
    async () => {
      const { real } = setup();
      const target = tempDir('target');
      const link = join(tempDir('links'), 'stroq-home');
      symlinkSync(target, link);

      await backupFile(fakeEnv(link), real, bytes('x'), 'b1');

      expect(readFileSync(join(target, 'backups', 'b1', `${sha256(real)}.bak`), 'utf8')).toBe('x');
    },
  );

  it('leaves no copy and no temporary file when the write fails', async () => {
    const { home, real, env } = setup();
    const fs: Fs = {
      ...nodeFs,
      rename: () => Promise.reject(Object.assign(new Error('simulated EXDEV'), { code: 'EXDEV' })),
    };

    await expect(backupFile({ ...env, fs }, real, bytes('x'), 'b1')).rejects.toThrow(/EXDEV/);

    expect(copiesOf(home, real)).toEqual([]);
    expect(readdirSync(join(home, 'backups'))).toEqual([]);
  });
});

describe('readBackup', () => {
  it('reads what was stored', async () => {
    const { real, env } = setup();
    await backupFile(env, real, bytes('{"é": 1}\r\n'), 'b1');

    expect(readBackup(env, real, 'b1')).toBe('{"é": 1}\r\n');
  });

  it('is null when there is no such copy, for another file, or for an id it would not write', async () => {
    const { real, env } = setup();
    await backupFile(env, real, bytes('x'), 'b1');

    expect(readBackup(env, real, 'b2')).toBeNull();
    expect(readBackup(env, join(tempDir(), 'other.json'), 'b1')).toBeNull();
    expect(readBackup(env, real, '../b1')).toBeNull();
    expect(readBackup(env, real, '')).toBeNull();
  });

  it('is null for something that is not a file where a copy should be', async () => {
    const { home, real, env } = setup();
    mkdirSync(backupPath(home, 'b1', real), { recursive: true });

    expect(readBackup(env, real, 'b1')).toBeNull();
  });

  it('is null for a copy too large to be a config', async () => {
    const { home, real, env } = setup();
    mkdirSync(join(home, 'backups', 'b1'), { recursive: true });
    writeFileSync(backupPath(home, 'b1', real), Buffer.alloc(5 * 1024 * 1024, 0x20));

    expect(readBackup(env, real, 'b1')).toBeNull();
  });
});

describe('removeBackup', () => {
  it('removes the copy and the directory it leaves empty', async () => {
    const { home, real, env } = setup();
    await backupFile(env, real, bytes('x'), 'b1');

    await removeBackup(env, real, 'b1');

    expect(existsSync(join(home, 'backups', 'b1'))).toBe(false);
  });

  it('leaves the copies of other files, and the directory they share', async () => {
    const { home, real, env } = setup();
    const other = join(tempDir('other'), 'settings.json');
    await backupFile(env, real, bytes('this'), 'b1');
    await backupFile(env, other, bytes('other'), 'b1');

    await removeBackup(env, real, 'b1');

    expect(copiesOf(home, real)).toEqual([]);
    expect(readFileSync(backupPath(home, 'b1', other), 'utf8')).toBe('other');
  });

  it('is quiet about a copy that is not there, and about an id it would not have written', async () => {
    const { real, env } = setup();

    await expect(removeBackup(env, real, 'nope')).resolves.toBeUndefined();
    await expect(removeBackup(env, real, '../escape')).resolves.toBeUndefined();
  });

  it('does not touch what an id that climbs out of the directory would name', async () => {
    const { home, real, env } = setup();
    const victim = join(home, 'victim.txt');
    writeFileSync(victim, 'precious');

    await removeBackup(env, real, '../victim.txt');

    expect(readFileSync(victim, 'utf8')).toBe('precious');
  });
});
