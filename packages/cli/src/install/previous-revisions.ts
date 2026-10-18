import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { count } from '../commands/vet-text.js';
import { isPlainObject } from '../commands/config-file.js';
import { passportsFileIn } from '../paths.js';
import { readPassports } from './lock.js';
import { quotePath } from './safe-path.js';
import { readStoredTree, storePath } from './store.js';

const KIB = 1024;
const HEX_DIGEST = /^[0-9a-f]{64}$/;

/** Formats a byte count for doctor output, always including the exact byte count. */
export function formatStoreBytes(bytes: number): string {
  const exact = count(bytes, 'byte');
  return bytes < KIB ? exact : `${exact} (${(bytes / KIB).toFixed(1)} KiB)`;
}

async function directoryBytes(folder: string): Promise<number> {
  const entries = await readdir(folder, { withFileTypes: true });
  let total = 0;
  for (const entry of entries) {
    const full = join(folder, entry.name);
    const stat = await lstat(full);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) total += await directoryBytes(full);
    else if (stat.isFile()) total += stat.size;
  }
  return total;
}

/**
 * Computes the disk space (in bytes) used by a stored revision (`manifest.json` + `tree/`),
 * or `null` when the stored revision is absent, unreadable or fails digest verification.
 */
export async function storedRevisionBytes(home: string, digest: string): Promise<number | null> {
  if (!HEX_DIGEST.test(digest)) return null;
  try {
    const folder = storePath(home, digest);
    const stat = await lstat(folder);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return null;
    await readStoredTree(folder, digest);
    return await directoryBytes(folder);
  } catch {
    return null;
  }
}

export interface RetainedRevisionCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

/**
 * Reports retained previous revisions across confirmed skills and MCP servers in `stroq doctor`,
 * including the disk space each revision and the retained set use.
 */
export async function checkRetainedRevisions(
  home: string,
): Promise<readonly RetainedRevisionCheck[]> {
  try {
    const stat = await lstat(passportsFileIn(home));
    if (stat.isSymbolicLink() || !stat.isFile()) return [];
  } catch {
    return [];
  }
  let lock;
  try {
    lock = await readPassports(home);
  } catch {
    return [];
  }
  const items: {
    readonly kind: 'skill' | 'mcp';
    readonly name: string;
    readonly digest: string;
    readonly bytes: number | null;
  }[] = [];

  for (const [name, record] of Object.entries(lock.skills).sort(([a], [b]) => a.localeCompare(b))) {
    if (record.status === 'revoked' || record.previous === undefined) continue;
    const bytes = await storedRevisionBytes(home, record.previous.digest);
    items.push({ kind: 'skill', name, digest: record.previous.digest, bytes });
  }

  for (const [name, raw] of Object.entries(lock.mcp ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    if (!isPlainObject(raw) || raw['status'] !== 'confirmed') continue;
    const prev = raw['previous'];
    if (!isPlainObject(prev) || typeof prev['digest'] !== 'string') continue;
    const digest = prev['digest'];
    if (!HEX_DIGEST.test(digest)) continue;
    const bytes = await storedRevisionBytes(home, digest);
    items.push({ kind: 'mcp', name, digest, bytes });
  }

  if (items.length === 0) return [];

  const uniqueBytes = new Map<string, number>();
  for (const item of items) {
    if (item.bytes !== null) uniqueBytes.set(item.digest.slice(0, 32), item.bytes);
  }
  const totalBytes = [...uniqueBytes.values()].reduce((sum, n) => sum + n, 0);
  const allPresent = items.every((item) => item.bytes !== null);
  const parts = items.map((item) => {
    const size = item.bytes === null ? 'missing or damaged in store' : formatStoreBytes(item.bytes);
    return `${item.kind} ${quotePath(item.name)} sha256:${item.digest.slice(0, 12)} (${size})`;
  });

  return [
    {
      name: 'previous revisions',
      ok: allPresent,
      detail: `${count(items.length, 'previous revision')} retained (${formatStoreBytes(totalBytes)}): ${parts.join(', ')}`,
    },
  ];
}
