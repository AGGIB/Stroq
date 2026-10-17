import { resolve } from 'node:path';
import { readPassportLock } from '../install/lock-reader.js';
import { passportsFileIn, stroqHome } from '../paths.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * What `add --kind mcp` wrote for each server it confirmed in this config file, by name, taken from the lock and
 * never from the config: a record that is confirmed, names this file, and holds the entry `add` wrote. A lock
 * that is missing or cannot be read confirms nothing.
 */
export function confirmedEntries(
  file: string,
  home: string = stroqHome(),
): ReadonlyMap<string, Record<string, unknown>> {
  const confirmed = new Map<string, Record<string, unknown>>();
  try {
    const lock = readPassportLock(passportsFileIn(home));
    for (const [name, record] of Object.entries(lock.mcp)) {
      if (
        isRecord(record) &&
        record['kind'] === 'mcp' &&
        record['status'] === 'confirmed' &&
        isRecord(record['written']) &&
        typeof record['config'] === 'string' &&
        resolve(record['config']) === resolve(file)
      )
        confirmed.set(name, record['written']);
    }
  } catch {
    // No lock, or one that cannot be read: nothing was confirmed that could be compared.
  }
  return confirmed;
}
