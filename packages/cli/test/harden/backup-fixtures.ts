import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fakeEnv, tempDir } from './helpers.js';

/** What the tests of the copies of a file share: a home, an env around it, and what is in it. */

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
export const bytes = (text: string): Uint8Array => Buffer.from(text, 'utf8');

/** A home, an env around it, and the real path of a file somebody else owns. */
export function setup() {
  const home = tempDir('home');
  const real = join(tempDir('project'), '.claude', 'settings.json');
  return { home, real, env: fakeEnv(home) };
}

/** The ids of the copies of `real` that are in `home`, oldest first. */
export const copiesOf = (home: string, real: string): string[] => {
  const root = join(home, 'backups');
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((id) => existsSync(join(root, id, `${sha256(real)}.bak`)))
    .sort();
};
