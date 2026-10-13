import { dirname } from 'node:path';
import {
  assertWriteAllowed,
  missingDirsTo,
  nodeFs,
  removeEmptyDirs,
  resolveRealPath,
  writeFileAtomic,
  type WriteRules,
} from './atomic.js';
import {
  backupFile,
  newBackupId,
  pruneBackups,
  removeBackup,
  type BackupResult,
} from './backup.js';
import { replacesCredential } from './json-edit.js';
import {
  entriesFor,
  readManifest,
  removeManifest,
  withManifestLock,
  writeManifest,
  type Manifest,
  type ManifestEntry,
} from './manifest.js';
import { linkNotice, linkTarget } from './plan-support.js';
import { readTargetBytes, sameBytes } from './read.js';
import { assertUnchanged } from './recheck.js';
import { verifyPlan } from './replay.js';
import { HardenError, sha256Text, type HardenEnv, type Plan } from './types.js';

/**
 * Applying a plan: the operation that changes an owner's file.
 *
 * It runs inside the lock beside the manifest, so that two commands on one machine do not
 * interleave. The lock is advisory and belongs to one host: a lock older than ten seconds whose
 * owner cannot be checked (one on another host, on a home shared over a network) is taken over.
 * It checks that the plan is what a planner would have made and that the file is still what the
 * plan was made from, keeps a copy of exactly the bytes it read (unless they hold
 * credential-shaped text), RECORDS what it is about to do, looks at the file once more, and only
 * then replaces it.
 *
 * Recording first is the safe order: a change that nobody recorded cannot be undone. The price is
 * that a record can outlive a change that did not happen (the write fails and the record cannot
 * be taken back, or the process is stopped hard between the two). That is not left as a trap:
 * undo reads such a record against the file, and a file that is exactly as it was before that
 * apply has nothing of that apply's to take out, so nothing is taken out and nothing is said.
 *
 * The look at the file just before it is replaced (before every try, when the system refuses the
 * rename for a moment and it is tried again) narrows the window in which an edit the owner makes
 * can be lost to the time between that read and the rename. It does not close it: no portable
 * call replaces an existing file only if it is unchanged, and a file that was not there when the
 * plan was made can be replaced by the rename if it has appeared since.
 */

export interface ApplyOptions {
  /**
   * The caller has shown the owner that this change lays the whole file out again (it is
   * minified, say, or indented in a way the engine does not use) and the owner agreed. Without it
   * such a plan is refused with `reformat-not-acknowledged`, and nothing is touched.
   */
  readonly acknowledgeReformat?: boolean;
  /**
   * The caller has shown the owner that the path is a link, or lies behind one, and that the change
   * lands in the file it leads to (the plan's notices say so), and the owner agreed. A link that
   * stays inside the project is followed, and that is how many people keep their dotfiles; but a
   * repository chooses its links too, and one that points `.cursorignore` at `.env` would have the
   * change land in a file the owner never named. Without this such a plan is refused with
   * `link-not-acknowledged`, and nothing is touched.
   */
  readonly acknowledgeLink?: boolean;
  /**
   * The caller has shown the owner that this change replaces a value that looks like a credential
   * (the plan's notices say so) and that no copy of it is kept, so that undo cannot put it back,
   * and the owner agreed. Without it such a plan is refused with `credential-loss-not-acknowledged`,
   * and nothing is touched.
   */
  readonly acknowledgeCredentialLoss?: boolean;
}

export interface ApplyResult {
  /** Whether the file was changed. `false` when the plan changed nothing. */
  readonly changed: boolean;
  readonly real: string;
  /** The diff of the change, as the plan showed it. */
  readonly diff: string;
  /** What was kept of the file before, or `null` when it did not exist. */
  readonly backup: BackupResult | null;
  /** What was recorded, or `null` when nothing was. */
  readonly entry: ManifestEntry | null;
}

const stale = (why: string): HardenError =>
  new HardenError('stale-plan', `${why}; make a new plan`);

/** The rules the file's path has to pass, from what the caller named. */
export const rulesOf = (root: string | undefined): WriteRules =>
  root === undefined ? {} : { root };

/**
 * The bytes of the file now, if it is still what `plan` was made from, and the path still leads
 * where it did. A plan is a promise about one version of one file; it is not a way to overwrite
 * another.
 */
function currentBytes(plan: Plan): Uint8Array | null {
  if (resolveRealPath(plan.file) !== plan.real) throw stale('the path now leads to another file');
  const bytes = readTargetBytes(plan.real);
  const expected = plan.existed ? Buffer.from(plan.before, 'utf8') : null;
  if (!sameBytes(bytes, expected)) throw stale('the file has changed since the plan was made');
  return bytes;
}

/**
 * Refuses a change the owner may not have been told about: one that lays the whole file out again,
 * and one that replaces a credential, which nothing can put back. The caller says it told them.
 */
function assertOwnerTold(plan: Plan, reformats: boolean, options: ApplyOptions): void {
  if (reformats && options.acknowledgeReformat !== true) {
    throw new HardenError(
      'reformat-not-acknowledged',
      `this change lays all of ${plan.file} out again (its layout is not the one Stroq writes), not only the lines it adds; the diff shows all of it. Apply it only if the owner has agreed`,
    );
  }
  if (replacesCredential(plan.edits) && options.acknowledgeCredentialLoss !== true) {
    throw new HardenError(
      'credential-loss-not-acknowledged',
      `this change replaces a value in ${plan.file} that looks like a credential, no copy of it is kept and it cannot be put back; apply it only if the owner has agreed`,
    );
  }
}

/** Refuses a change that lands in another file than the one named, unless the owner has been told. */
function assertLinkAcknowledged(plan: Plan, options: ApplyOptions): void {
  if (options.acknowledgeLink === true) return;
  if (linkTarget(plan.file, plan.real, plan.root) === null) return;
  throw new HardenError(
    'link-not-acknowledged',
    `refusing to apply: ${linkNotice(plan.file, plan.real)}. Apply it only if the owner has seen that and agreed`,
  );
}

const withEntry = (manifest: Manifest, real: string, entry: ManifestEntry): Manifest => ({
  ...manifest,
  files: { ...manifest.files, [real]: [...entriesFor(manifest, real), entry] },
});

async function applyLocked(plan: Plan, env: HardenEnv): Promise<ApplyResult> {
  const now = env.now();
  const bytes = currentBytes(plan);
  const fs = env.fs ?? nodeFs;
  // Read first: a manifest that cannot be trusted must stop this before anything is written.
  const manifest = readManifest(env);
  let backup: BackupResult | null = null;
  let recorded = false;
  const createdDirs = plan.existed ? [] : await missingDirsTo(fs, dirname(plan.real));
  try {
    // The copy is of the bytes just read, and the last look below compares with those same bytes:
    // what is kept is what is replaced, or nothing is replaced.
    backup =
      plan.existed && bytes !== null
        ? await backupFile(env, plan.real, bytes, newBackupId(now))
        : null;
    const entry: ManifestEntry = {
      recipe: plan.recipe,
      created: !plan.existed,
      createdDirs,
      real: plan.real,
      root: plan.root === undefined ? null : resolveRealPath(plan.root),
      edits: plan.edits,
      shaBefore: plan.existed ? sha256Text(plan.before) : null,
      shaAfter: sha256Text(plan.after),
      backup: backup?.stored === true ? backup.id : null,
      stroqVersion: env.version,
      appliedAt: now.toISOString(),
    };
    await writeManifest(env, withEntry(manifest, plan.real, entry));
    recorded = true;
    assertUnchanged(plan.file, plan.real, bytes);
    await writeFileAtomic(plan.file, plan.after, {
      ...rulesOf(plan.root),
      ...(plan.newFileMode === undefined ? {} : { mode: plan.newFileMode }),
      ...(env.fs === undefined ? {} : { fs: env.fs }),
      beforeRename: () => assertUnchanged(plan.file, plan.real, bytes),
    });
    // Only now: an older copy is dropped to make room for this one once the change has been made.
    // It never throws, which matters here: a failure after the file was replaced must not undo
    // the record of it.
    if (backup?.stored === true) await pruneBackups(env, plan.real, backup.id);
    return { changed: true, real: plan.real, diff: plan.diff, backup, entry };
  } catch (err) {
    // Take back what was done, and never let a failure to do so hide the failure that matters.
    if (recorded) {
      if (Object.keys(manifest.files).length === 0) {
        await removeManifest(env).catch(() => undefined);
      } else {
        await writeManifest(env, manifest).catch(() => undefined);
      }
    }
    if (backup?.stored === true)
      await removeBackup(env, plan.real, backup.id).catch(() => undefined);
    if (createdDirs.length > 0) {
      await removeEmptyDirs(createdDirs, { ...rulesOf(plan.root), fs });
    }
    throw err;
  }
}

/**
 * Makes the change `plan` describes: checks that the plan is what a planner would have made of
 * its text and edits, that the file is still what the plan was made from and that a change which
 * lays the whole file out again was agreed to, keeps a copy of the file (unless it holds
 * credential-shaped text), records the edits and replaces the file atomically.
 *
 * Throws, in every case before anything is touched:
 * - `plan-refused` for a plan that was refused;
 * - `lossy-json` for a file that would lose something in the trip through an object, whatever the
 *   plan says and whatever the caller agreed to;
 * - `plan-inconsistent` for a plan whose text after, diff or edits are not what a planner makes;
 * - `reformat-not-acknowledged` for a change that lays the file out again, unless
 *   `options.acknowledgeReformat` is `true`;
 * - `credential-loss-not-acknowledged` for a change that replaces a value that looks like a
 *   credential, unless `options.acknowledgeCredentialLoss` is `true`;
 * - `link-not-acknowledged` for a path that is a link, or lies behind one, below the plan's root,
 *   unless `options.acknowledgeLink` is `true`;
 * - `path-escapes-root` and `dangling-link` for a path that leaves its tree or leads nowhere;
 * - `stale-plan` for a file that is not what the plan was made from.
 *
 * A plan that changes nothing does nothing and records nothing.
 */
export async function applyPlan(
  plan: Plan,
  env: HardenEnv,
  options: ApplyOptions = {},
): Promise<ApplyResult> {
  if (plan.refused !== undefined) {
    throw new HardenError(
      'plan-refused',
      `this plan cannot be applied: ${plan.refusedDetail ?? plan.refused}`,
    );
  }
  if (!plan.changed) {
    return { changed: false, real: plan.real, diff: '', backup: null, entry: null };
  }
  // The plan is judged by what it is made of, not by what it says about itself.
  const { reformats } = verifyPlan(plan);
  assertOwnerTold(plan, reformats, options);
  // Before anything is made or kept: a path that leads out of its tree or nowhere, or a file that
  // is not what the plan was made from, must cost nothing. The same checks are made again inside
  // the lock, where they are the ones that count.
  assertWriteAllowed(plan.file, rulesOf(plan.root));
  currentBytes(plan);
  // After `currentBytes`: it has just shown that `plan.real` is where the path leads now, so a plan
  // that says it is not a link cannot get round this by lying about it.
  assertLinkAcknowledged(plan, options);
  return withManifestLock(env, () => applyLocked(plan, env));
}
