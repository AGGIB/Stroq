import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileProvenanceStore } from '../../src/provenance/store.js';

// The markers of results that are being recorded live in a directory of their own for each
// session, one file for each. Once the last is taken off the directory has nothing to say and is
// removed with it, without ever taking away the place a marker that is being put down is about to
// stand in.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'stroq-pending-dir-'));
  dirs.push(dir);
  const store = new FileProvenanceStore(dir);
  const leftovers = (): string[] => readdirSync(dir).filter((name) => name.includes('.prov.'));
  return { store, dir, leftovers };
}

describe('the directory of the markers of a session', () => {
  it('is removed with the last marker', async () => {
    const f = fixture();
    await f.store.setPending('s1', true, 'a');
    expect(f.leftovers().some((name) => name.endsWith('.prov.pending.d'))).toBe(true);

    await f.store.setPending('s1', false, 'a');

    expect(f.leftovers()).toEqual([]);
    expect(await f.store.isIncomplete('s1')).toBe(false);
  });

  it('stays while another marker is in it, and goes with that one', async () => {
    const f = fixture();
    await f.store.setPending('s1', true, 'a');
    await f.store.setPending('s1', true, 'b');

    await f.store.setPending('s1', false, 'a');
    expect(f.leftovers().some((name) => name.endsWith('.prov.pending.d'))).toBe(true);
    expect(await f.store.isIncomplete('s1')).toBe(true);

    await f.store.setPending('s1', false, 'b');
    expect(f.leftovers()).toEqual([]);
  });

  it('is not left by taking off a marker that was never put down', async () => {
    const f = fixture();
    await f.store.setPending('s1', false, 'never');
    expect(f.leftovers()).toEqual([]);
  });

  it('can be made again by the next marker', async () => {
    const f = fixture();
    await f.store.setPending('s1', true, 'a');
    await f.store.setPending('s1', false, 'a');
    await f.store.setPending('s1', true, 'b');
    expect(await f.store.isIncomplete('s1')).toBe(true);
    await f.store.setPending('s1', false, 'b');
    expect(f.leftovers()).toEqual([]);
  });

  it('never takes away the place of a marker that is being put down', async () => {
    const f = fixture();
    for (let round = 0; round < 30; round += 1) {
      const owners = Array.from({ length: 6 }, (_, k) => `r${round}o${k}`);
      await Promise.all(
        owners.map(async (owner) => {
          await f.store.setPending('s1', true, owner);
          await f.store.setPending('s1', false, owner);
        }),
      );
      // Every marker that was put down was taken off by its owner, and none was lost on the way.
      expect(await f.store.isIncomplete('s1')).toBe(false);
    }
    expect(f.leftovers()).toEqual([]);
    expect(existsSync(join(f.dir))).toBe(true);
  });

  it('keeps a marker that is put down while the last other one is taken off', async () => {
    const f = fixture();
    await f.store.setPending('s1', true, 'old');
    for (let round = 0; round < 40; round += 1) {
      await Promise.all([
        f.store.setPending('s1', false, 'old'),
        f.store.setPending('s1', true, 'new'),
      ]);
      expect(await f.store.isIncomplete('s1')).toBe(true);
      await Promise.all([
        f.store.setPending('s1', true, 'old'),
        f.store.setPending('s1', false, 'new'),
      ]);
      expect(await f.store.isIncomplete('s1')).toBe(true);
    }
  });
});
