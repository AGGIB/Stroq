import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { assertWriteAllowed } from '../harden/atomic.js';
import { storeDirIn } from '../paths.js';
import { outsideLine } from '../ui/layout.js';
import type { Passports, SkillRecord } from './lock.js';
import { assertPlainDirectory, storePath } from './store.js';

const STORE_ENTRY = /^sha256-([0-9a-f]{32})$/;

function liveReplacer(key: string, value: unknown): unknown {
  if (key === 'history') return undefined;
  if (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as { status?: unknown }).status === 'revoked'
  )
    return undefined;
  return value;
}

async function unreferencedStoreDigests(
  home: string,
  skillsText: string,
  mcpText: string,
  candidates: Iterable<string | null | undefined>,
): Promise<void> {
  const checked = new Set<string>();
  for (const digest of candidates) {
    if (digest === null || digest === undefined) continue;
    const prefix = digest.slice(0, 32);
    if (checked.has(prefix) || skillsText.includes(prefix) || mcpText.includes(prefix)) continue;
    checked.add(prefix);
    const stored = storePath(home, digest);
    assertWriteAllowed(stored, { root: home, initRule: false });
    if (await assertPlainDirectory(stored)) await rm(stored, { recursive: true });
  }
  const entries = await readdir(storeDirIn(home)).catch(() => [] as string[]);
  for (const entry of entries) {
    const match = STORE_ENTRY.exec(entry);
    if (match === null) continue;
    const prefix = match[1]!;
    if (checked.has(prefix) || skillsText.includes(prefix) || mcpText.includes(prefix)) continue;
    checked.add(prefix);
    const stored = join(storeDirIn(home), entry);
    assertWriteAllowed(stored, { root: home, initRule: false });
    if (await assertPlainDirectory(stored)) await rm(stored, { recursive: true });
  }
}

/** Revisions are shared by skills and MCP pins; removing one name must not remove another's code. */
export async function collectSkillStore(
  home: string,
  lock: Passports,
  name: string,
  record: SkillRecord,
): Promise<void> {
  const activeSkills = Object.fromEntries(
    Object.entries(lock.skills ?? {}).filter(
      ([key, value]) => key !== name && value.status !== 'revoked',
    ),
  );
  const skillsText = JSON.stringify(activeSkills, liveReplacer);
  // MCP may own opaque/older entries. A mention anywhere in a live record is enough to keep a revision,
  // including sha256:<digest>, store paths, nested fields and previous revisions.
  const mcpText = JSON.stringify(lock.mcp ?? {}, liveReplacer);
  const revisions = [
    record.digest,
    record.previous?.digest,
    ...record.history.flatMap((item) => [item.from, item.to]),
  ];
  await unreferencedStoreDigests(home, skillsText, mcpText, revisions);
}

/** The MCP counterpart: a revision stays while any skill or other MCP record still names it. */
export async function collectMcpStore(
  home: string,
  lock: Passports,
  ...digests: readonly (string | undefined)[]
): Promise<void> {
  const skillsText = JSON.stringify(lock.skills ?? {}, liveReplacer);
  const mcpText = JSON.stringify(lock.mcp ?? {}, liveReplacer);
  await unreferencedStoreDigests(home, skillsText, mcpText, digests);
}

/**
 * Clearing the old copy is the last step of a removal or an update, after the config and the lock were written. The
 * command has done what was asked by then, so a copy that cannot be cleared (a link where its folder should be, a
 * folder that cannot be written) is a leftover and not a failure: it is kept, and the person is told.
 */
export async function tidyStore(
  terminal: { write(text: string): void },
  digest: string,
  clear: () => Promise<void>,
): Promise<void> {
  try {
    await clear();
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'it could not be cleared';
    terminal.write(
      `warning: the old stored copy sha256:${digest.slice(0, 12)} was not removed (${outsideLine(reason)}); it is not used any more and can be deleted by hand\n`,
    );
  }
}
