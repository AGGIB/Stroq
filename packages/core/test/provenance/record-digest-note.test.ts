import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProvenanceRecorder } from '../../src/provenance/record.js';
import { FileProvenanceStore } from '../../src/provenance/store.js';

// A pending marker comes off only when everything that was lost is durably noted: the wide note
// for what can raise the floor, and the narrow note for hashes. A note that cannot be written
// leaves the marker in place as the evidence, and says so.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const STALE_CLOCK = (): Date => new Date(Date.now() - 5 * 60_000);
const READING = {
  text: 'integrity: sha512-x',
  atoms: [{ kind: 'digest' as const, value: 'x'.repeat(88) }],
};
const EVENT = {
  sessionId: 's1',
  toolName: 'Read',
  toolInput: { file_path: 'README.md' },
  toolResultText: READING.text,
  cwd: '/tmp',
};

/** A rename that fails for the files whose names contain any of `failing`. */
const renameFailing = (failing: readonly string[]): typeof rename =>
  (async (from: string, to: string) => {
    if (failing.some((part) => to.includes(part))) throw new Error('disk full');
    return rename(from, to);
  }) as typeof rename;

function fixture(failing: readonly string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'stroq-record-note-'));
  dirs.push(dir);
  mkdirSync(dir, { recursive: true });
  const store = new FileProvenanceStore(dir, STALE_CLOCK, renameFailing(failing));
  const recorder = new ProvenanceRecorder(store, undefined);
  const markers = (): string[] =>
    readdirSync(dir).flatMap((name) =>
      name.endsWith('.prov.pending.d')
        ? readdirSync(join(dir, name)).map((owner) => `${name}/${owner}`)
        : [],
    );
  const run = async (digestsLost: boolean, lost = false) => {
    const owner = await recorder.begin('s1');
    const outcome = await recorder.record(
      EVENT,
      'README.md',
      [READING],
      false,
      lost,
      owner,
      digestsLost,
    );
    return outcome;
  };
  return { store, markers, run, dir };
}

describe('the marker of a result whose hashes were left out', () => {
  it('comes off when the note of the loss is written', async () => {
    const f = fixture([]);
    const outcome = await f.run(true);
    expect(outcome.error).toBeNull();
    expect(f.markers()).toEqual([]);
    expect(await f.store.digestsLost('s1')).toBe(true);
  });

  it('stays when neither the narrow note nor the wide one can be written, and says so', async () => {
    const f = fixture(['.prov.digests-lost', '.prov.incomplete']);
    const outcome = await f.run(true);
    expect(outcome.error).not.toBeNull();
    expect(f.markers()).toHaveLength(1);
    // The marker is the evidence that remains: once it is stale the session reads as incomplete.
    expect(await f.store.isIncomplete('s1')).toBe(true);
  });

  it('comes off when only the narrow note fails, since the wide one then stands for it', async () => {
    const f = fixture(['.prov.digests-lost']);
    const outcome = await f.run(true);
    expect(outcome.error).toBeNull();
    expect(f.markers()).toEqual([]);
    expect(await f.store.isIncomplete('s1')).toBe(true);
  });

  it('stays when the wide loss is noted and the narrow one cannot be, with nothing to stand for it', async () => {
    const f = fixture(['.prov.digests-lost', '.prov.incomplete']);
    const outcome = await f.run(true, true);
    expect(outcome.error).not.toBeNull();
    expect(f.markers()).toHaveLength(1);
  });

  it('comes off when there is no loss of hashes at all', async () => {
    const f = fixture(['.prov.digests-lost', '.prov.incomplete']);
    const outcome = await f.run(false);
    expect(outcome.error).toBeNull();
    expect(f.markers()).toEqual([]);
  });
});
