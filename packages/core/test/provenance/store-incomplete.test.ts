import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, rename as renameFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileProvenanceStore, MAX_RECORDS } from '../../src/provenance/store.js';
import { FileSessionStore, sessionKey } from '../../src/taint/session-store.js';

const fresh = () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'stroq-prov-inc-')), 'sessions');
  return { dir, store: new FileProvenanceStore(dir), sessions: new FileSessionStore(dir) };
};
const input = (hash: string, suspect = false) => ({
  tool: 'Read',
  source: 'README.md',
  kind: 'pkg' as const,
  hash,
  excerpt: hash,
  suspect,
});
const batch = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, i) => input(`${prefix}${i}`));
const links = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, i) => ({ ...input(`${prefix}${i}`), kind: 'url' as const }));
const provFile = (dir: string, id: string) => join(dir, `${sessionKey(id)}.prov.json`);
const taint = { tool: 'Read', ruleIds: ['STROQ-2026-00001'], at: '2026-09-04T00:00:00.000Z' };

describe('FileProvenanceStore incomplete flag', () => {
  it('reads a session it has never seen as complete', async () => {
    expect(await fresh().store.isIncomplete('s1')).toBe(false);
  });

  it('stays complete while every record still fits', async () => {
    const { store } = fresh();
    await store.record('s1', batch('a', MAX_RECORDS));
    expect(await store.isIncomplete('s1')).toBe(false);
  });

  it('sets the flag when the oldest record is dropped to make room', async () => {
    const { store } = fresh();
    await store.record('s1', batch('a', MAX_RECORDS));
    await store.record('s1', [input('b0')]);
    expect(await store.lookup('s1', ['a0'])).toEqual([]);
    expect(await store.isIncomplete('s1')).toBe(true);
  });

  it('keeps the flag per session', async () => {
    const { store } = fresh();
    await store.record('s1', batch('a', MAX_RECORDS + 1));
    await store.record('s2', [input('h')]);
    expect(await store.isIncomplete('s1')).toBe(true);
    expect(await store.isIncomplete('s2')).toBe(false);
  });

  it('never clears the flag on a later short record or a new store instance', async () => {
    const { dir, store } = fresh();
    await store.record('s1', batch('a', MAX_RECORDS + 1));
    await store.record('s1', [input('later')]);
    expect(await store.isIncomplete('s1')).toBe(true);
    expect(await new FileProvenanceStore(dir).isIncomplete('s1')).toBe(true);
  });

  it('sets the flag on request even when nothing was recorded', async () => {
    const { store } = fresh();
    await store.markIncomplete('s1');
    expect(await store.isIncomplete('s1')).toBe(true);
    expect(await store.lookup('s1', ['h'])).toEqual([]);
  });

  it('writes the flag privately, like the records', async () => {
    const { dir, store } = fresh();
    await store.markIncomplete('s1');
    if (process.platform === 'win32') return;
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, `${sessionKey('s1')}.prov.incomplete`)).mode & 0o777).toBe(0o600);
  });

  it('is cleared by clear(), for that session only', async () => {
    const { store } = fresh();
    await store.markIncomplete('s1');
    await store.markIncomplete('s2');
    await store.clear('s1');
    expect(await store.isIncomplete('s1')).toBe(false);
    expect(await store.isIncomplete('s2')).toBe(true);
  });

  it('starts a cleared session over: complete again, and incomplete again only on a new loss', async () => {
    const { store } = fresh();
    await store.record('s1', batch('a', MAX_RECORDS + 1));
    await store.clear('s1');
    await store.record('s1', batch('b', 3));
    expect(await store.isIncomplete('s1')).toBe(false);
    expect(await store.lookup('s1', ['b2'])).toHaveLength(1);
  });

  it('keeps the records in the same on-disk shape, whatever the flag says', async () => {
    const { dir, store } = fresh();
    await store.record('s1', batch('a', MAX_RECORDS + 1));
    const onDisk: unknown = JSON.parse(readFileSync(provFile(dir, 's1'), 'utf8'));
    expect(Array.isArray(onDisk)).toBe(true);
    expect(onDisk).toHaveLength(MAX_RECORDS);
  });

  it('still reads a file an older version wrote, as complete', async () => {
    const { dir, store } = fresh();
    await mkdir(dir, { recursive: true });
    const old = Array.from({ length: 3 }, (_, i) => ({
      ...input(`o${i}`, i === 1),
      seq: i + 1,
      at: '2026-09-04T00:00:00.000Z',
    }));
    writeFileSync(provFile(dir, 's1'), JSON.stringify(old));
    expect(await store.isIncomplete('s1')).toBe(false);
    expect((await store.lookup('s1', ['o1']))[0]).toMatchObject({ seq: 2, suspect: true });
    await store.record('s1', [input('n0')]);
    expect(await store.lookup('s1', ['o0', 'n0'])).toHaveLength(2);
    expect(await store.isIncomplete('s1')).toBe(false);
  });

  it('reads a garbled flag file as incomplete, since its presence is the flag', async () => {
    const { dir, store } = fresh();
    await mkdir(dir, { recursive: true });
    writeFileSync(join(dir, `${sessionKey('s1')}.prov.incomplete`), '{garbage');
    expect(await store.isIncomplete('s1')).toBe(true);
  });
});

describe('FileProvenanceStore on a tainted session', () => {
  it('reads a tainted session that never recorded an atom as complete: nothing was lost', async () => {
    const { store, sessions } = fresh();
    await sessions.markSuspect('s1', taint);
    expect(await store.isIncomplete('s1')).toBe(false);
  });

  it('reads a session nothing has touched as complete', async () => {
    const { store, sessions } = fresh();
    await sessions.markSuspect('other', taint);
    expect(await store.isIncomplete('s1')).toBe(false);
  });

  it('reads a tainted session whose provenance file is present as complete', async () => {
    const { store, sessions } = fresh();
    await sessions.markSuspect('s1', taint);
    await store.record('s1', [input('h')]);
    expect(await store.isIncomplete('s1')).toBe(false);
  });

  it('stays incomplete after untaint of the taint alone, until the provenance is cleared too', async () => {
    const { store, sessions } = fresh();
    await sessions.markSuspect('s1', taint);
    await store.markIncomplete('s1');
    await sessions.clear('s1');
    expect(await store.isIncomplete('s1')).toBe(true);
    await store.clear('s1');
    expect(await store.isIncomplete('s1')).toBe(false);
  });

  it('keeps failing closed on a corrupt file instead of answering', async () => {
    const { dir, store, sessions } = fresh();
    await sessions.markSuspect('s1', taint);
    writeFileSync(provFile(dir, 's1'), '{not json');
    await expect(store.lookup('s1', ['h'])).rejects.toThrow(/corrupt provenance/);
    await expect(store.record('s1', [input('h')])).rejects.toThrow(/corrupt provenance/);
  });
});

describe('FileProvenanceStore when the flag cannot be read', () => {
  it.skipIf(process.platform === 'win32')(
    'counts a dangling symlink at the flag path as the flag being there',
    async () => {
      const { dir, store } = fresh();
      await mkdir(dir, { recursive: true });
      symlinkSync(join(dir, 'nothing-here'), join(dir, `${sessionKey('s1')}.prov.incomplete`));
      expect(await store.isIncomplete('s1')).toBe(true);
    },
  );

  it('reads a sessions path it cannot stat as incomplete rather than clean', async () => {
    const { dir } = fresh();
    await mkdir(join(dir, '..'), { recursive: true });
    writeFileSync(dir, 'a file where the sessions directory should be');
    expect(await new FileProvenanceStore(dir).isIncomplete('s1')).toBe(true);
  });

  it('reads a missing sessions path below a regular file as incomplete', async () => {
    const { dir } = fresh();
    writeFileSync(dir, 'a file where a parent directory should be');
    expect(await new FileProvenanceStore(join(dir, 'nested', 'sessions')).isIncomplete('s1')).toBe(
      true,
    );
  });

  it('reads missing nested directories below a writable directory as complete', async () => {
    const { dir } = fresh();
    expect(await new FileProvenanceStore(join(dir, 'nested', 'sessions')).isIncomplete('s1')).toBe(
      false,
    );
  });
});

// A directory this process cannot write to is where a loss cannot be noted. root ignores modes.
const canRestrict = process.platform !== 'win32' && process.getuid?.() !== 0;

describe.skipIf(!canRestrict)(
  'FileProvenanceStore when the sessions directory cannot be written',
  () => {
    const restricted = async () => {
      const f = fresh();
      await f.store.record('s1', [input('h')]);
      chmodSync(f.dir, 0o500);
      return f;
    };

    it('fails to note a loss, and reads the session as incomplete all the same', async () => {
      const f = await restricted();
      try {
        await expect(f.store.markIncomplete('s1')).rejects.toThrow();
        expect(existsSync(join(f.dir, `${sessionKey('s1')}.prov.incomplete`))).toBe(false);
        expect(await f.store.isIncomplete('s1')).toBe(true);
      } finally {
        chmodSync(f.dir, 0o700);
      }
    });

    it('reads a session as complete again once the directory can be written', async () => {
      const f = await restricted();
      chmodSync(f.dir, 0o700);
      expect(await f.store.isIncomplete('s1')).toBe(false);
    });

    it('still reads a directory that does not exist yet as complete', async () => {
      const { store } = fresh();
      expect(await store.isIncomplete('s1')).toBe(false);
    });
  },
);

describe('FileProvenanceStore.markIncomplete when the rename fails', () => {
  const failing = (before?: () => void) => {
    const { dir } = fresh();
    const rename = async (): Promise<void> => {
      before?.();
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    };
    return { dir, store: new FileProvenanceStore(dir, undefined, rename) };
  };

  it('leaves no temporary file behind, and says it failed', async () => {
    const { dir, store } = failing();
    await expect(store.markIncomplete('s1')).rejects.toThrow(/operation not permitted/);
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(await store.isIncomplete('s1')).toBe(false);
  });

  it('succeeds when another process wrote the note first, which is what a Windows rename race looks like', async () => {
    const { dir, store } = failing(() =>
      writeFileSync(join(dir, `${sessionKey('s1')}.prov.incomplete`), '{}'),
    );
    await expect(store.markIncomplete('s1')).resolves.toBeUndefined();
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(await store.isIncomplete('s1')).toBe(true);
  });
});

describe('FileProvenanceStore under concurrent callers', () => {
  const tmpFiles = (dir: string) => readdirSync(dir).filter((name) => name.endsWith('.tmp'));

  it('notes a loss once, however many callers note it at the same time', async () => {
    const { dir, store } = fresh();
    await Promise.all(Array.from({ length: 12 }, () => store.markIncomplete('s1')));
    expect(await store.isIncomplete('s1')).toBe(true);
    expect(tmpFiles(dir)).toEqual([]);
  });

  it('settles a note that races a clear to one of the two outcomes, and leaves nothing behind', async () => {
    const { dir, store } = fresh();
    await store.record('s1', [input('h')]);
    await Promise.all([store.markIncomplete('s1'), store.clear('s1')]);
    expect(tmpFiles(dir)).toEqual([]);
    await store.clear('s1');
    expect(await store.isIncomplete('s1')).toBe(false);
    expect(await store.lookup('s1', ['h'])).toEqual([]);
  });

  it('keeps both records, and notes the loss once, when two writers straddle the cap', async () => {
    const { store } = fresh();
    await store.record('s1', batch('a', MAX_RECORDS - 1));
    expect(await store.isIncomplete('s1')).toBe(false);

    await Promise.all([store.record('s1', [input('x')]), store.record('s1', [input('y')])]);

    expect(await store.lookup('s1', ['x', 'y'])).toHaveLength(2);
    expect(await store.lookup('s1', ['a0'])).toEqual([]);
    expect(await store.isIncomplete('s1')).toBe(true);
  });

  it('does not note a loss when two writers together only fill the cap', async () => {
    const { store } = fresh();
    await store.record('s1', batch('a', MAX_RECORDS - 2));
    await Promise.all([store.record('s1', [input('x')]), store.record('s1', [input('y')])]);
    expect(await store.lookup('s1', ['a0', 'x', 'y'])).toHaveLength(3);
    expect(await store.isIncomplete('s1')).toBe(false);
  });
});

describe('FileProvenanceStore when the records outgrow the cap', () => {
  // A URL or a host cannot raise the floor, so losing the record of one is not a loss that needs
  // a note, and a lot of them must not push out the records that can.
  it('drops the oldest URL records before any other, and says nothing', async () => {
    const { store } = fresh();
    await store.record('s1', [...batch('p', 10), ...links('u', MAX_RECORDS - 10)]);
    await store.record('s1', links('v', 50));

    expect(await store.lookup('s1', ['u0', 'u49'])).toEqual([]);
    expect(await store.lookup('s1', ['u50', 'v49'])).toHaveLength(2);
    expect(await store.lookup('s1', ['p0', 'p9'])).toHaveLength(2);
    expect(await store.isIncomplete('s1')).toBe(false);
  });

  it('stays complete however many URL records a session reads', async () => {
    const { store } = fresh();
    await store.record('s1', batch('p', 5));
    for (let round = 0; round < 6; round += 1) {
      await store.record('s1', links(`r${round}-`, MAX_RECORDS / 2));
    }
    expect(await store.lookup('s1', ['p0', 'p4'])).toHaveLength(2);
    expect(await store.isIncomplete('s1')).toBe(false);
  });

  it('keeps the cap on the file, URL records included', async () => {
    const { dir, store } = fresh();
    await store.record('s1', links('u', MAX_RECORDS + 300));
    const onDisk: unknown = JSON.parse(readFileSync(provFile(dir, 's1'), 'utf8'));
    expect(onDisk).toHaveLength(MAX_RECORDS);
  });

  it('notes the loss when it is a record that can raise the floor that goes', async () => {
    const { store } = fresh();
    await store.record('s1', batch('p', MAX_RECORDS));
    await store.record('s1', links('u', 3));
    expect(await store.isIncomplete('s1')).toBe(false);
    expect(await store.lookup('s1', ['u0'])).toEqual([]);

    await store.record('s1', [input('q0')]);

    expect(await store.lookup('s1', ['p0'])).toEqual([]);
    expect(await store.isIncomplete('s1')).toBe(true);
  });

  it('keeps the records in the order they were read', async () => {
    const { dir, store } = fresh();
    await store.record('s1', [input('p0'), ...links('u', 3), input('p1')]);
    await store.record('s1', links('v', MAX_RECORDS));
    const onDisk = JSON.parse(readFileSync(provFile(dir, 's1'), 'utf8')) as { seq: number }[];
    const seqs = onDisk.map((record) => record.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });
});

describe('FileProvenanceStore pending marker', () => {
  it('settles only its own operation, including across store instances', async () => {
    const { dir, store } = fresh();
    const other = new FileProvenanceStore(dir);
    await Promise.all([
      store.setPending('s1', true, 'operation-a'),
      other.setPending('s1', true, 'operation-b'),
    ]);
    await store.setPending('s1', false, 'operation-a');
    expect(await new FileProvenanceStore(dir).isIncomplete('s1')).toBe(true);
    await other.setPending('s1', false, 'operation-b');
    expect(await store.isIncomplete('s1')).toBe(false);
  });

  it('leaves a legacy marker in place when a new operation settles', async () => {
    const { store } = fresh();
    await store.setPending('s1', true);
    await store.setPending('s1', true, 'operation-a');
    await store.setPending('s1', false, 'operation-a');
    expect(await store.isIncomplete('s1')).toBe(true);
    await store.clear('s1');
    expect(await store.isIncomplete('s1')).toBe(false);
  });

  it('removes abandoned operation markers only when clear starts the session over', async () => {
    const { dir, store } = fresh();
    await store.setPending('s1', true, 'crashed-operation');
    await store.setPending('other', true, 'other-operation');
    expect(await new FileProvenanceStore(dir).isIncomplete('s1')).toBe(true);
    await store.clear('s1');
    expect(await store.isIncomplete('s1')).toBe(false);
    expect(await store.isIncomplete('other')).toBe(true);
  });

  it('keeps operation directories and markers private', async () => {
    if (process.platform === 'win32') return;
    const { dir, store } = fresh();
    await store.setPending('s1', true, 'operation-a');
    const pending = join(dir, `${sessionKey('s1')}.prov.pending.d`);
    expect(statSync(pending).mode & 0o777).toBe(0o700);
    expect(statSync(join(pending, sessionKey('operation-a'))).mode & 0o777).toBe(0o600);
  });

  it('reads a session as incomplete from the time a result is about to be recorded until it is settled', async () => {
    const { store } = fresh();
    await store.setPending('s1', true);
    expect(await store.isIncomplete('s1')).toBe(true);
    await store.setPending('s1', false);
    expect(await store.isIncomplete('s1')).toBe(false);
  });

  it('is not the note: settling it does not clear a loss that was noted', async () => {
    const { store } = fresh();
    await store.markIncomplete('s1');
    await store.setPending('s1', true);
    await store.setPending('s1', false);
    expect(await store.isIncomplete('s1')).toBe(true);
  });

  it('settles a marker that was never set, and is removed by clear()', async () => {
    const { store } = fresh();
    await expect(store.setPending('s1', false)).resolves.toBeUndefined();
    await store.setPending('s1', true);
    await store.clear('s1');
    expect(await store.isIncomplete('s1')).toBe(false);
  });

  it('is private, like the other files', async () => {
    if (process.platform === 'win32') return;
    const { dir, store } = fresh();
    await store.setPending('s1', true);
    expect(statSync(join(dir, `${sessionKey('s1')}.prov.pending`)).mode & 0o777).toBe(0o600);
  });
});

// A disk that fills at the cap: the move that makes the note the real one fails, and the
// directory can still be written to. Failing is not allowed to mean forgetting.
describe('FileProvenanceStore when the note of an eviction cannot be written', () => {
  const noSpace = () => Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
  const failingFor = (suffix: string) => {
    const { dir } = fresh();
    const rename: typeof renameFile = async (from, to) => {
      if (String(to).endsWith(suffix)) throw noSpace();
      await renameFile(from, to);
    };
    return { dir, store: new FileProvenanceStore(dir, undefined, rename) };
  };

  it('still writes the records, and then fails closed on them, where the note would have been', async () => {
    const { dir, store } = failingFor('.prov.incomplete');
    await store.record('s1', batch('a', MAX_RECORDS));

    await expect(store.record('s1', [input('b0')])).rejects.toThrow(/no space left/);

    const raw = readFileSync(provFile(dir, 's1'), 'utf8');
    expect(raw).toContain('"hash":"b0"');
    await expect(store.lookup('s1', ['a0'])).rejects.toThrow(/corrupt provenance/);
    await expect(store.record('s1', [input('c0')])).rejects.toThrow(/corrupt provenance/);
  });

  it('fails closed on the records that were there when neither file could be written', async () => {
    const { dir } = fresh();
    const full = new FileProvenanceStore(dir, undefined, async () => {
      throw noSpace();
    });
    const plain = new FileProvenanceStore(dir);
    await plain.record('s1', batch('a', MAX_RECORDS));

    await expect(full.record('s1', [input('b0')])).rejects.toThrow(/no space left/);

    await expect(plain.lookup('s1', ['a0'])).rejects.toThrow(/corrupt provenance/);
  });

  it('is cleared by clear(), which is what untaint calls', async () => {
    const { store } = failingFor('.prov.incomplete');
    await store.record('s1', batch('a', MAX_RECORDS));
    await expect(store.record('s1', [input('b0')])).rejects.toThrow();

    await store.clear('s1');

    expect(await store.lookup('s1', ['a0'])).toEqual([]);
    await expect(store.record('s1', [input('c0')])).resolves.toBeUndefined();
  });

  it('leaves a store whose notes are written alone', async () => {
    const { store } = fresh();
    await store.record('s1', batch('a', MAX_RECORDS));
    await store.record('s1', [input('b0')]);
    expect(await store.lookup('s1', ['b0'])).toHaveLength(1);
    expect(await store.isIncomplete('s1')).toBe(true);
  });
});
