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
import { mkdir } from 'node:fs/promises';
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
