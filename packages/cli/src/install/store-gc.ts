import { rm } from 'node:fs/promises';
import { assertWriteAllowed } from '../harden/atomic.js';
import type { Passports, SkillRecord } from './lock.js';
import { assertPlainDirectory, storePath } from './store.js';

/** Revisions are shared by skills and MCP pins; removing one name must not remove another's code. */
export async function collectSkillStore(
  home: string,
  lock: Passports,
  name: string,
  record: SkillRecord,
): Promise<void> {
  const active = new Set(
    Object.entries(lock.skills)
      .filter(([key, value]) => key !== name && value.status !== 'revoked')
      .map(([, value]) => value.digest),
  );
  for (const value of Object.values(lock.mcp ?? {})) {
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      value['status'] !== 'revoked' &&
      typeof value['digest'] === 'string'
    )
      active.add(value['digest']);
  }
  // The folder uses a prefix. Even a hypothetical prefix collision must keep a referenced tree.
  const activePrefixes = new Set([...active].map((digest) => digest.slice(0, 32)));
  const revisions = new Set([
    record.digest,
    ...record.history.flatMap((item) => [item.from, item.to]),
  ]);
  for (const digest of revisions) {
    if (digest === null || activePrefixes.has(digest.slice(0, 32))) continue;
    const stored = storePath(home, digest);
    assertWriteAllowed(stored, { root: home, initRule: false });
    if (await assertPlainDirectory(stored)) await rm(stored, { recursive: true });
  }
}
