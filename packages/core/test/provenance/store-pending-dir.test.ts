import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileProvenanceStore } from '../../src/provenance/store.js';

/**
 * A clock five minutes back. A marker the store writes with it is already stale: its deadline has
 * passed, which is what a post that never finished leaves. A marker of a post that is running is no
 * loss, and is tested in engine-live-marker.test.ts.
 */
const STALE_CLOCK = (): Date => new Date(Date.now() - 5 * 60_000);

// The markers of results that are being recorded live in a directory of their own for each
// session, one file for each. The directory is never removed by taking a marker off: it is one
// empty directory for each session, removed by `clear` (`stroq untaint`), because taking it away
// could race another process that has made it and is about to write its marker in it. Markers of
// different processes never take one another away.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(renameFile?: typeof rename) {
  const dir = mkdtempSync(join(tmpdir(), 'stroq-pending-dir-'));
  dirs.push(dir);
  const store = new FileProvenanceStore(dir, STALE_CLOCK, renameFile);
  /** A second process: a store of its own on the same directory. */
  const other = () => new FileProvenanceStore(dir, STALE_CLOCK);
  const leftovers = (): string[] => readdirSync(dir).filter((name) => name.includes('.prov.'));
  const markerDirs = (): string[] => leftovers().filter((name) => name.endsWith('.prov.pending.d'));
  return { store, other, dir, leftovers, markerDirs };
}

describe('the directory of the markers of a session', () => {
  it('stays, empty, after the last marker is off, and the session is not incomplete', async () => {
    const f = fixture();
    await f.store.setPending('s1', true, 'a');
    await f.store.setPending('s1', false, 'a');

    expect(f.markerDirs()).toHaveLength(1);
    expect(readdirSync(join(f.dir, f.markerDirs()[0] ?? ''))).toEqual([]);
    expect(await f.store.isIncomplete('s1')).toBe(false);
  });

  it('is removed by clear, which is what untaint does', async () => {
    const f = fixture();
    await f.store.setPending('s1', true, 'a');
    await f.store.setPending('s1', false, 'a');
    await f.store.clear('s1');
    expect(f.leftovers()).toEqual([]);
  });

  it('is used again by the next marker', async () => {
    const f = fixture();
    await f.store.setPending('s1', true, 'a');
    await f.store.setPending('s1', false, 'a');
    await f.store.setPending('s1', true, 'b');
    expect(await f.store.isIncomplete('s1')).toBe(true);
    expect(f.markerDirs()).toHaveLength(1);
  });
});

describe('markers of different processes', () => {
  it('never lose one when another is put down and taken off in the middle of its writing', async () => {
    let reached!: () => void;
    let release!: () => void;
    const stalled = new Promise<void>((resolve) => (reached = resolve));
    const resume = new Promise<void>((resolve) => (release = resolve));
    let first = true;
    // The first process stops after its file is written in the directory and before it is moved
    // to its name: the straddle the other process does its whole work inside.
    const stallingRename = (async (from: string, to: string) => {
      if (first) {
        first = false;
        reached();
        await resume;
      }
      return rename(from, to);
    }) as typeof rename;
    const f = fixture(stallingRename);

    const writing = f.store.setPending('s1', true, 'a');
    await stalled;
    const process2 = f.other();
    await process2.setPending('s1', true, 'b');
    expect(await process2.isIncomplete('s1')).toBe(true);
    await process2.setPending('s1', false, 'b');
    release();
    await writing;

    expect(await process2.isIncomplete('s1')).toBe(true);
    await f.store.setPending('s1', false, 'a');
    expect(await process2.isIncomplete('s1')).toBe(false);
  });

  it('never lose one when they are put down and taken off at the same moment', async () => {
    const f = fixture();
    const processes = [f.store, f.other(), f.other()];
    for (let round = 0; round < 25; round += 1) {
      await Promise.all(
        processes.flatMap((process, p) =>
          [0, 1, 2].map(async (k) => {
            const owner = `r${round}p${p}k${k}`;
            await process.setPending('s1', true, owner);
            expect(await process.isIncomplete('s1')).toBe(true);
            await process.setPending('s1', false, owner);
          }),
        ),
      );
      expect(await f.store.isIncomplete('s1')).toBe(false);
    }
    expect(f.markerDirs()).toHaveLength(1);
  });

  it('keep the session incomplete for as long as one of them stands', async () => {
    const f = fixture();
    const process2 = f.other();
    await f.store.setPending('s1', true, 'old');
    for (let round = 0; round < 25; round += 1) {
      await Promise.all([
        f.store.setPending('s1', false, 'old'),
        process2.setPending('s1', true, 'new'),
      ]);
      expect(await f.store.isIncomplete('s1')).toBe(true);
      await Promise.all([
        f.store.setPending('s1', true, 'old'),
        process2.setPending('s1', false, 'new'),
      ]);
      expect(await f.store.isIncomplete('s1')).toBe(true);
    }
  });
});
