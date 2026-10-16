import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sessionKey, sessionStateFile } from '../taint/session-store.js';
import type { AtomKind, ProvenanceRecord } from '../types.js';
import { withLock } from '../util/lock.js';

export type ProvenanceInput = Omit<ProvenanceRecord, 'seq' | 'at'>;

export interface ProvenanceStore {
  record(sessionId: string, inputs: readonly ProvenanceInput[]): Promise<void>;
  /** Records whose hash is in `hashes`, most recent first. */
  lookup(sessionId: string, hashes: readonly string[]): Promise<ProvenanceRecord[]>;
  /**
   * Deletes all stored records for a session, and with them the note that its evidence
   * was incomplete; a no-op if none exist. This is what `stroq untaint` calls, and the
   * only way the note goes away.
   */
  clear(sessionId: string): Promise<void>;
  /**
   * Whether this session may have read something that is no longer on record: a record
   * was dropped to stay within the cap, a result was only partly recorded, or the file
   * is gone from a session that is known to exist. A lookup that finds nothing means
   * "not read" only when this is false.
   *
   * Ask AFTER `lookup`, never before. Setting the note always comes before the records
   * are rewritten, so a lookup that saw records after a drop is followed by an answer of
   * true; asked first, the two could straddle another process's write and read both as
   * clean.
   */
  isIncomplete(sessionId: string): Promise<boolean>;
  /**
   * Notes that evidence for this session was lost or never recorded. Permanent until
   * `clear`: a later short result does not make an earlier loss any less of one.
   */
  markIncomplete(sessionId: string): Promise<void>;
}

/** Oldest records are dropped beyond this many per session. */
export const MAX_RECORDS = 2000;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;
/**
 * The note that a session's evidence is incomplete lives beside the records, not in
 * them: `<key>.prov.json` stays the bare array every earlier version reads and writes,
 * so a downgrade or a tool that parses it keeps working. The note's presence is the
 * flag; what is inside is for a person looking at the file.
 */
const INCOMPLETE_SUFFIX = '.prov.incomplete';
const ATOM_KINDS: ReadonlySet<unknown> = new Set<AtomKind>([
  'url',
  'host',
  'pkg',
  'pipe_shell',
  'encoded',
]);

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

function isProvenanceRecord(value: unknown): value is ProvenanceRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['seq'] === 'number' &&
    typeof record['at'] === 'string' &&
    typeof record['tool'] === 'string' &&
    typeof record['source'] === 'string' &&
    ATOM_KINDS.has(record['kind']) &&
    typeof record['hash'] === 'string' &&
    typeof record['excerpt'] === 'string' &&
    typeof record['suspect'] === 'boolean'
  );
}

export class FileProvenanceStore implements ProvenanceStore {
  constructor(
    private readonly dir: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private file(sessionId: string): string {
    return join(this.dir, `${sessionKey(sessionId)}.prov.json`);
  }

  private incompleteFile(sessionId: string): string {
    return join(this.dir, `${sessionKey(sessionId)}${INCOMPLETE_SUFFIX}`);
  }

  private async read(sessionId: string): Promise<ProvenanceRecord[]> {
    let raw: string;
    try {
      raw = await readFile(this.file(sessionId), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      // Fail closed, like the session store: the CLI turns this into `deny`
      // on high-impact tools rather than silently forgetting what was read.
      throw new Error(`corrupt provenance state: ${this.file(sessionId)}`, { cause: err });
    }
    if (!Array.isArray(parsed) || !parsed.every(isProvenanceRecord)) {
      // Valid JSON but the wrong shape is corruption too: silently treating it
      // as an empty list would let `record` fold it away on the next write, and a
      // record whose `suspect` is not a boolean would read as a clean origin.
      throw new Error(`corrupt provenance state: ${this.file(sessionId)}`);
    }
    return parsed;
  }

  private async write(sessionId: string, records: readonly ProvenanceRecord[]): Promise<void> {
    const target = this.file(sessionId);
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(records), { encoding: 'utf8', mode: PRIVATE_FILE_MODE });
    await rename(tmp, target);
  }

  async record(sessionId: string, inputs: readonly ProvenanceInput[]): Promise<void> {
    if (inputs.length === 0) return;
    await mkdir(this.dir, { recursive: true, mode: PRIVATE_DIR_MODE });
    await withLock(`${this.file(sessionId)}.lock`, async () => {
      const existing = await this.read(sessionId);
      const at = this.now().toISOString();
      const start = existing[existing.length - 1]?.seq ?? 0;
      const added = inputs.map((input, i) => ({ ...input, seq: start + i + 1, at }));
      const all = [...existing, ...added];
      const kept = all.slice(-MAX_RECORDS);
      // The note first, the records second: a crash between the two leaves a session
      // that says it is incomplete and is not, never one that is and does not say so.
      if (kept.length < all.length) await this.markIncomplete(sessionId);
      await this.write(sessionId, kept);
    });
  }

  async markIncomplete(sessionId: string): Promise<void> {
    const target = this.incompleteFile(sessionId);
    // Idempotent and monotonic, so it needs no lock: whoever writes it writes the same thing.
    if (await exists(target)) return;
    await mkdir(this.dir, { recursive: true, mode: PRIVATE_DIR_MODE });
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    const body = JSON.stringify({ incomplete: true, since: this.now().toISOString() });
    await writeFile(tmp, body, { encoding: 'utf8', mode: PRIVATE_FILE_MODE });
    await rename(tmp, target);
  }

  async isIncomplete(sessionId: string): Promise<boolean> {
    try {
      if (await exists(this.incompleteFile(sessionId))) return true;
      if (await exists(this.file(sessionId))) return false;
      // No records file. For a session nothing ever touched that is the ordinary start,
      // but a tainted session has read something, and records it should hold have gone.
      return await exists(sessionStateFile(this.dir, sessionId));
    } catch {
      // A file Stroq cannot even stat is not evidence that nothing was lost.
      return true;
    }
  }

  async lookup(sessionId: string, hashes: readonly string[]): Promise<ProvenanceRecord[]> {
    const wanted = new Set(hashes);
    return (await this.read(sessionId)).filter((r) => wanted.has(r.hash)).reverse();
  }

  async clear(sessionId: string): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: PRIVATE_DIR_MODE });
    await withLock(`${this.file(sessionId)}.lock`, async () => {
      await rm(this.file(sessionId), { force: true });
      await rm(this.incompleteFile(sessionId), { force: true });
    });
  }
}
