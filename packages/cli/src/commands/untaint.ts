import { existsSync, readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { FileProvenanceStore, FileSessionStore } from '@stroq/core';
import { sessionsDir } from '../paths.js';

const USAGE = 'usage: stroq untaint --session <id> | --all\n';

async function clearAll(): Promise<void> {
  const dir = sessionsDir();
  if (!existsSync(dir)) return;
  await Promise.all(readdirSync(dir).map((f) => rm(join(dir, f), { force: true })));
}

/**
 * Clears taint and provenance for a false-positive session (`--session <id>`,
 * the id shown in `stroq log`) or for every known session (`--all`, which
 * already removes every file in the sessions dir, provenance included).
 * Clearing only taint would leave `origin.suspect` firing forever from the
 * session's stored provenance records, so a false positive could never be
 * fully cleared. Neither flag prints usage and fails, since silently doing
 * nothing would look like success.
 */
export async function runUntaint(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    options: {
      session: { type: 'string' },
      all: { type: 'boolean', default: false },
    },
  });
  if (values.all) {
    await clearAll();
    process.stdout.write('cleared taint and provenance for all sessions\n');
    return 0;
  }
  if (values.session) {
    await new FileSessionStore(sessionsDir()).clear(values.session);
    await new FileProvenanceStore(sessionsDir()).clear(values.session);
    process.stdout.write(`cleared taint and provenance for session ${values.session}\n`);
    return 0;
  }
  process.stdout.write(USAGE);
  return 1;
}
