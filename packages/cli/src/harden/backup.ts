import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { backupsDirIn } from '../paths.js';
import {
  assertWriteAllowed,
  makePrivateDir,
  nodeFs,
  readTargetText,
  writeFileAtomic,
} from './atomic.js';
import { findCredentialShape, type CredentialShape } from './credential-shape.js';
import {
  HardenError,
  ID_PATTERN,
  sha256Text,
  type BackupPlan,
  type Fs,
  type HardenEnv,
} from './types.js';

/**
 * Deciding whether a file may be copied.
 *
 * A byte copy of a settings file is one more file on the disk, and if the settings hold a
 * credential (an `env` block with a token, an MCP server started with a key) it is one more copy
 * of the credential, in a place the owner did not put it and will not think to clean. So the
 * engine looks at the pre-image first, with the same detectors that guard secrets everywhere else
 * in Stroq, and keeps no copy of a file that holds anything credential-shaped. Undo of such a file
 * works on the entries Stroq added alone, which is what it does for any file that was edited
 * afterwards anyway.
 *
 * This is a heuristic, and it leans toward "do not copy": a false alarm costs the byte copy
 * (undo is surgical instead) and a miss costs a credential in one more place. The reading itself
 * lives in `credential-shape.ts`.
 */

export { findCredentialShape, type CredentialShape };

/**
 * What a plan tells the owner about the copy: whether one will be kept for `before` (the file's
 * text now, or `null` when there is no file), and the sentence to show when it will not.
 */
export function planBackup(before: string | null): {
  readonly backup: BackupPlan;
  readonly notices: readonly string[];
} {
  if (before === null) return { backup: 'none-new-file', notices: [] };
  const shape = findCredentialShape(before);
  if (shape === null) return { backup: 'copy', notices: [] };
  return {
    backup:
      shape === 'unchecked' || shape === 'unchecked-line'
        ? 'none-unchecked'
        : 'none-credential-text',
    notices: [`no byte backup: ${whyNoCopy(shape)}`],
  };
}

/**
 * Why no copy is kept, in words that are true of that case: a file that was found to hold a
 * credential and a file that was too large to be looked at in full are not the same thing.
 */
const whyNoCopy = (shape: CredentialShape): string =>
  shape === 'unchecked'
    ? 'the file is too large to check for credential-shaped text'
    : shape === 'unchecked-line'
      ? 'the file has a line too long to check for credential-shaped text'
      : 'the file holds credential-shaped text';

// ---------------------------------------------------------------------------------------------
// Storing the copy.

/** How many copies of one file are kept: the first, and the newest four. */
export const BACKUPS_KEPT_PER_FILE = 5;

const PRIVATE_FILE_MODE = 0o600;

export interface BackupResult {
  readonly id: string;
  /** Whether a copy was written. */
  readonly stored: boolean;
  /** Why not, when it was not. */
  readonly reason?: string;
}

const isBackupId = (id: string): boolean => ID_PATTERN.test(id);

/**
 * A new id for one apply: the UTC time to the millisecond, so that ids sort in the order they were
 * made, and a random part, so that two made in the same millisecond are not one.
 */
export function newBackupId(now: Date): string {
  const stamp = now.toISOString().replace(/[-:.]/g, '');
  return `${stamp}-${randomBytes(3).toString('hex')}`;
}

/** Where the copy of `real` made under `id` lives: `<home>/backups/<id>/<sha256 of the path>.bak`. */
export const backupPath = (home: string, id: string, real: string): string =>
  join(backupsDirIn(home), id, `${sha256Text(real)}.bak`);

/**
 * Removes the copy of `real` that `backupFile` stored under `id`, and its directory if that leaves
 * it empty: for an apply that did not go through, whose copy nothing will ever use. Best effort;
 * a copy that stays is clutter and not harm.
 */
export async function removeBackup(env: HardenEnv, real: string, id: string): Promise<void> {
  if (!isBackupId(id)) return;
  const fs = env.fs ?? nodeFs;
  const file = backupPath(env.home, id, real);
  assertWriteAllowed(file, { root: env.home, initRule: false });
  await fs.unlink(file).catch(() => undefined);
  await fs.rmdir(dirname(file)).catch(() => undefined);
}

/** What `backupFile` stored for `real` under `id`, or `null` when there is nothing usable there. */
export function readBackup(env: HardenEnv, real: string, id: string): string | null {
  if (!isBackupId(id)) return null;
  try {
    return readTargetText(backupPath(env.home, id, real));
  } catch {
    return null;
  }
}

/**
 * Removes copies of `real` until `BACKUPS_KEPT_PER_FILE` are left, counting the one just written
 * (`keepId`), which is never removed whatever its id sorts like.
 *
 * Which ones go: the OLDEST copy that exists for this file stays, and so do the newest four. The
 * oldest is the file as it was before Stroq first touched it, unless an earlier undo left its own
 * copy behind (copies stay after an undo), in which case that older copy holds the place; dropping
 * the oldest (as a plain "newest five" does) would throw the original away at the sixth apply. The
 * ones between are only steps on the way, and undo can take an apply's entries out of the file
 * itself when its copy is gone. Other files' copies are not looked at, and a directory is removed
 * only when this leaves it empty.
 */
async function prune(fs: Fs, home: string, real: string, keepId: string): Promise<void> {
  const root = backupsDirIn(home);
  const name = `${sha256Text(real)}.bak`;
  const holders: string[] = [keepId];
  for (const id of await fs.readdir(root)) {
    if (id === keepId || !isBackupId(id)) continue;
    const holds = await fs.stat(join(root, id, name)).then(
      (stat) => stat.isFile(),
      () => false,
    );
    if (holds) holders.push(id);
  }
  const ordered = [...holders].sort();
  const keep = new Set([
    ...ordered.slice(0, 1),
    ...ordered.slice(-(BACKUPS_KEPT_PER_FILE - 1)),
    keepId,
  ]);
  for (const id of ordered) {
    if (keep.has(id)) continue;
    await fs.unlink(join(root, id, name)).catch(() => undefined);
    await fs.rmdir(join(root, id)).catch(() => undefined);
  }
}

/**
 * Keeps a byte copy of `real`, whose text is `bytes`, as `<home>/backups/<id>/<sha256 of the
 * path>.bak` (directories 0700, the file 0600). It removes nothing: an older copy is dropped by
 * `pruneBackups`, once the change that needed the room has been made, because a copy pruned for an
 * apply that then fails is lost for nothing.
 *
 * Returns `stored: false`, with the reason, and writes nothing when the bytes hold
 * credential-shaped text. Throws for an id that is not a plain name, and when the place it
 * would write to leads out of the Stroq home by a link.
 */
export async function backupFile(
  env: HardenEnv,
  real: string,
  bytes: Uint8Array,
  id: string,
): Promise<BackupResult> {
  if (!isBackupId(id)) {
    throw new HardenError(
      'invalid-backup-id',
      'a backup id is a plain name: letters, digits, dots, hyphens and underscores',
    );
  }
  const shape = findCredentialShape(new TextDecoder().decode(bytes));
  if (shape !== null) return { id, stored: false, reason: whyNoCopy(shape) };
  const fs = env.fs ?? nodeFs;
  const file = backupPath(env.home, id, real);
  // The home is Stroq's own and may be a link on purpose; the only rule is that nothing in it
  // leads out. Asked first, so that no directory is made or changed through such a link.
  const rules = { root: env.home, initRule: false } as const;
  assertWriteAllowed(file, rules);

  await makePrivateDir(fs, backupsDirIn(env.home));
  await makePrivateDir(fs, dirname(file));
  try {
    await writeFileAtomic(file, bytes, { ...rules, mode: PRIVATE_FILE_MODE, fs });
  } catch (err) {
    await fs.rmdir(dirname(file)).catch(() => undefined);
    throw err;
  }
  return { id, stored: true };
}

/**
 * Drops the copies of `real` beyond `BACKUPS_KEPT_PER_FILE`, keeping `keepId`, which has just been
 * stored for a change that has been made. Best effort, and it never throws: a copy that cannot be
 * removed is still a copy, and the next apply tries again.
 */
export async function pruneBackups(env: HardenEnv, real: string, keepId: string): Promise<void> {
  if (!isBackupId(keepId)) return;
  await prune(env.fs ?? nodeFs, env.home, real, keepId).catch(() => undefined);
}
