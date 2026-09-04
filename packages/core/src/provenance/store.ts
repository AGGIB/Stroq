import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sessionKey } from '../taint/session-store.js';
import type { ProvenanceRecord } from '../types.js';
import { withLock } from '../util/lock.js';

export type ProvenanceInput = Omit<ProvenanceRecord, 'seq' | 'at'>;

export interface ProvenanceStore {
  record(sessionId: string, inputs: readonly ProvenanceInput[]): Promise<void>;
  /** Records whose hash is in `hashes`, most recent first. */
  lookup(sessionId: string, hashes: readonly string[]): Promise<ProvenanceRecord[]>;
}

/** Oldest records are dropped beyond this many per session. */
export const MAX_RECORDS = 2000;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;

export class FileProvenanceStore implements ProvenanceStore {
  constructor(
    private readonly dir: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private file(sessionId: string): string {
    return join(this.dir, `${sessionKey(sessionId)}.prov.json`);
  }

  private async read(sessionId: string): Promise<ProvenanceRecord[]> {
    let raw: string;
    try {
      raw = await readFile(this.file(sessionId), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? (parsed as ProvenanceRecord[]) : [];
    } catch (err) {
      // Fail closed, like the session store: the CLI turns this into `deny`
      // on high-impact tools rather than silently forgetting what was read.
      throw new Error(`corrupt provenance state: ${this.file(sessionId)}`, { cause: err });
    }
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
      await this.write(sessionId, [...existing, ...added].slice(-MAX_RECORDS));
    });
  }

  async lookup(sessionId: string, hashes: readonly string[]): Promise<ProvenanceRecord[]> {
    const wanted = new Set(hashes);
    return (await this.read(sessionId)).filter((r) => wanted.has(r.hash)).reverse();
  }
}
