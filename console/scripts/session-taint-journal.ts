import { join } from 'node:path';
import { GENESIS_HASH, hashEntry, isCanonicalIso, type AuditEntry } from '@stroq/core';
import { parseStrictJson } from '../../packages/core/src/scope/strict-json.js';
import { file, hash, type FileCapture, type Location } from './session-taint-files.ts';

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export type JournalStatus = 'verified' | 'missing' | 'unavailable' | 'limit' | 'broken';

export type Journal = {
  status: JournalStatus;
  sha256: string | null;
  entries: AuditEntry[] | null;
  /** Private capture metadata: never included in a browser projection. */
  source?: FileCapture;
  rawSha256?: string[];
};

/** The core chain hash over captured bytes; no raw copy persists if a worker is terminated. */
export async function captureJournal(root: Location): Promise<Journal> {
  let source;
  try {
    source =
      root.homePin === null
        ? { kind: 'missing' as const }
        : await file(join(root.home, 'audit.jsonl'), 16 * 1024 * 1024);
  } catch (error) {
    return {
      status:
        error instanceof Error && error.message === 'source-limit'
          ? 'limit'
          : error instanceof Error && error.message === 'invalid-source'
            ? 'broken'
            : 'unavailable',
      sha256: null,
      entries: null,
    };
  }
  if (source.kind === 'missing') return { status: 'missing', sha256: null, entries: null, source };
  const broken: Journal = { status: 'broken', sha256: source.sha256, entries: null, source };
  try {
    const lines = source.text.split('\n').filter((line) => line.trim().length > 0);
    const entries: AuditEntry[] = [];
    let previous = GENESIS_HASH;
    for (const [index, line] of lines.entries()) {
      const parsed = parseStrictJson(line);
      if (!parsed.ok || !object(parsed.value)) return broken;
      const entry = parsed.value;
      if (
        entry.seq !== index + 1 ||
        entry.prevHash !== previous ||
        typeof entry.hash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(entry.hash) ||
        typeof entry.ts !== 'string' ||
        !isCanonicalIso(entry.ts) ||
        !['pre', 'post'].includes(String(entry.phase)) ||
        typeof entry.sessionId !== 'string' ||
        typeof entry.tool !== 'string'
      )
        return broken;
      const { hash: digest, ...unhashed } = entry;
      if (hashEntry(unhashed as unknown as Omit<AuditEntry, 'hash'>) !== digest) return broken;
      previous = digest;
      entries.push(entry as unknown as AuditEntry);
    }
    return {
      status: 'verified',
      sha256: source.sha256,
      entries,
      source,
      rawSha256: lines.map(hash),
    };
  } catch {
    return broken;
  }
}
