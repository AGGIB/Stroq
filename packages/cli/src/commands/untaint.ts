import { existsSync, readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { FileSessionStore } from '@stroq/core';
import { sessionsDir } from '../paths.js';

const USAGE = 'usage: stroq untaint --session <id> | --all\n';

async function clearAll(): Promise<void> {
  const dir = sessionsDir();
  if (!existsSync(dir)) return;
  await Promise.all(readdirSync(dir).map((f) => rm(join(dir, f), { force: true })));
}

/**
 * Clears taint for a false-positive session (`--session <id>`, the id shown
 * in `stroq log`) or for every known session (`--all`). Neither flag prints
 * usage and fails, since silently doing nothing would look like success.
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
    process.stdout.write('cleared taint for all sessions\n');
    return 0;
  }
  if (values.session) {
    await new FileSessionStore(sessionsDir()).clear(values.session);
    process.stdout.write(`cleared taint for session ${values.session}\n`);
    return 0;
  }
  process.stdout.write(USAGE);
  return 1;
}
