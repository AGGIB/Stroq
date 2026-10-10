import {
  assertWriteAllowed,
  readTargetText,
  removeFile,
  resolveRealPath,
  writeFileAtomic,
  type WriteRules,
} from './atomic.js';
import { backupFile, newBackupId, readBackup, type BackupResult } from './backup.js';
import { maskedDiff, DIFF_HIDDEN_NOTICE } from './diff-mask.js';
import { undoJsonEdits } from './json-edit.js';
import {
  entriesFor,
  readManifest,
  withManifestLock,
  writeManifest,
  type Manifest,
  type ManifestEntry,
} from './manifest.js';
import { undoTextBlock } from './textblock.js';
import {
  HardenError,
  sha256Text,
  type HardenEnv,
  type Plan,
  type PlanRefusal,
  type RecordedEdit,
  type RecordedJsonEdit,
  type RecordedTextBlockEdit,
} from './types.js';

/**
 * Applying a plan and undoing it: the two operations that change an owner's file.
 *
 * Both run inside the lock beside the manifest, so that two commands never interleave. An apply
 * checks that the file is still what the plan was made from, keeps a copy of it, RECORDS what it is
 * about to do and only then replaces the file; a failure after the record puts the record back.
 * Recording first is the safe order: a record of a change that did not happen is a harmless line
 * that undo reads as "nothing to take out", where a change nobody recorded cannot be undone.
 *
 * Undo goes back through the recorded applies, newest first. When the file is exactly as an apply
 * left it, the copy made before that apply is put back. When it is not (the owner has edited it
 * since, or no copy was kept) only the entries Stroq added are taken out, and everything else
 * stays. Nothing is written until every apply has been worked out, and a file that cannot be
 * edited safely is left untouched with its records.
 */

export * from './types.js';
export {
  MAX_TARGET_BYTES,
  assertWriteAllowed,
  nodeFs,
  readTargetText,
  removeFile,
  resolveRealPath,
  writeFileAtomic,
  type AtomicWriteOptions,
  type AtomicWriteResult,
  type WriteRules,
} from './atomic.js';
export {
  BACKUPS_KEPT_PER_FILE,
  backupFile,
  backupPath,
  findCredentialShape,
  newBackupId,
  planBackup,
  readBackup,
  type BackupResult,
  type CredentialShape,
} from './backup.js';
export { MAX_DIFF_BYTES, MAX_DIFF_LINES, unifiedDiff, type DiffOptions } from './diff.js';
export {
  deepEqual,
  findJsoncSyntax,
  planJsonEdits,
  undoJsonEdits,
  type JsonUndo,
} from './json-edit.js';
export {
  MAX_MANIFEST_BYTES,
  emptyManifest,
  entriesFor,
  readManifest,
  withManifestLock,
  writeManifest,
  type Manifest,
  type ManifestEntry,
} from './manifest.js';
export { blockMarkers, planTextBlock, undoTextBlock, type TextUndo } from './textblock.js';

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
const rulesOf = (root: string | undefined): WriteRules => (root === undefined ? {} : { root });

/**
 * Whether the file is still what `plan` was made from, and the path still leads where it did.
 * A plan is a promise about one version of one file; it is not a way to overwrite another.
 */
function assertStillCurrent(plan: Plan): void {
  if (resolveRealPath(plan.file) !== plan.real) throw stale('the path now leads to another file');
  const current = readTargetText(plan.real);
  if (current !== (plan.existed ? plan.before : null)) {
    throw stale('the file has changed since the plan was made');
  }
}

const withEntry = (manifest: Manifest, real: string, entry: ManifestEntry): Manifest => ({
  ...manifest,
  files: { ...manifest.files, [real]: [...entriesFor(manifest, real), entry] },
});

async function applyLocked(plan: Plan, env: HardenEnv): Promise<ApplyResult> {
  const now = env.now();
  assertStillCurrent(plan);
  // Read first: a manifest that cannot be trusted must stop this before anything is written.
  const manifest = readManifest(env);

  const backup = plan.existed
    ? await backupFile(env, plan.real, Buffer.from(plan.before, 'utf8'), newBackupId(now))
    : null;
  const entry: ManifestEntry = {
    recipe: plan.recipe,
    created: !plan.existed,
    edits: plan.edits,
    shaBefore: plan.existed ? sha256Text(plan.before) : null,
    shaAfter: sha256Text(plan.after),
    backup: backup?.stored === true ? backup.id : null,
    stroqVersion: env.version,
    appliedAt: now.toISOString(),
  };

  await writeManifest(env, withEntry(manifest, plan.real, entry));
  try {
    await writeFileAtomic(plan.file, plan.after, {
      ...rulesOf(plan.root),
      ...(plan.newFileMode === undefined ? {} : { mode: plan.newFileMode }),
      ...(env.fs === undefined ? {} : { fs: env.fs }),
    });
  } catch (err) {
    // Take the record back, and never let a failure to do so hide the failure that matters.
    await writeManifest(env, manifest).catch(() => undefined);
    throw err;
  }
  return { changed: true, real: plan.real, diff: plan.diff, backup, entry };
}

/**
 * Makes the change `plan` describes: checks that the file is still what the plan was made from,
 * keeps a copy of it (unless it holds credential-shaped text), records the edits and replaces the
 * file atomically.
 *
 * Throws `HardenError` `plan-refused` for a refused plan and `stale-plan` for a file that is no
 * longer what the plan was made from, in both cases before anything is touched. A plan that
 * changes nothing does nothing and records nothing.
 */
export async function applyPlan(plan: Plan, env: HardenEnv): Promise<ApplyResult> {
  if (plan.refused !== undefined) {
    throw new HardenError(
      'plan-refused',
      `this plan cannot be applied: ${plan.refusedDetail ?? plan.refused}`,
    );
  }
  if (!plan.changed) {
    return { changed: false, real: plan.real, diff: '', backup: null, entry: null };
  }
  // Before anything is made or kept: a path that leads out of its tree, or a file that is not what
  // the plan was made from, must cost nothing. The same check is made again inside the lock, where
  // it is the one that counts.
  assertWriteAllowed(plan.file, rulesOf(plan.root));
  assertStillCurrent(plan);
  return withManifestLock(env, () => applyLocked(plan, env));
}

export type UndoStatus =
  /** The file is as it was before: the copy was put back, or a file Stroq made was removed. */
  | 'restored'
  /** Stroq's entries were taken out and the rest of the file was kept. */
  | 'surgical'
  /** There was nothing of Stroq's left to take out. */
  | 'already-undone'
  /** The file cannot be edited safely as it is. Nothing was changed. */
  | 'blocked';

export interface UndoResult {
  readonly status: UndoStatus;
  readonly real: string;
  /** What undo changed on disk. Empty when it changed nothing. */
  readonly diff: string;
  /** Entries left as they are because they are no longer what Stroq wrote. */
  readonly kept: readonly string[];
  /** The file had to be laid out again to take the entries out. */
  readonly reformatted: boolean;
  /** How many recorded applies were undone. */
  readonly applications: number;
  /** Things the owner should know about what was done or shown. */
  readonly notices: readonly string[];
  readonly blocked?: { readonly refused: PlanRefusal; readonly detail: string };
}

interface Step {
  /** The text after this apply is undone; `null` when the file should not exist. */
  readonly text: string | null;
  readonly kept: readonly string[];
  readonly how: 'copy' | 'entries' | 'nothing';
  readonly reformatted: boolean;
  readonly blocked?: { readonly refused: PlanRefusal; readonly detail: string };
}

const isJsonEdit = (edit: RecordedEdit): edit is RecordedJsonEdit => edit.kind !== 'text-block';
const isBlockEdit = (edit: RecordedEdit): edit is RecordedTextBlockEdit =>
  edit.kind === 'text-block';

const blockedStep = (refused: PlanRefusal, detail: string): Step => ({
  text: null,
  kept: [],
  how: 'nothing',
  reformatted: false,
  blocked: { refused, detail },
});

/** Takes the entries of one apply out of `text`, leaving the rest. */
function undoEntries(text: string, entry: ManifestEntry): Step {
  const jsonEdits = entry.edits.filter(isJsonEdit);
  const blockEdits = entry.edits.filter(isBlockEdit);
  let out = text;
  let kept: readonly string[] = [];
  let empty = false;
  let reformatted = false;

  if (jsonEdits.length > 0 && blockEdits.length > 0) {
    return blockedStep('type-conflict', 'the record of this change mixes JSON and text edits');
  }
  if (jsonEdits.length > 0) {
    const result = undoJsonEdits(text, jsonEdits);
    if (result.outcome === 'blocked') return blockedStep(result.refused, result.detail);
    out = result.text;
    kept = result.kept;
    empty = result.empty;
    reformatted = result.reformatted;
  } else {
    for (const edit of [...blockEdits].reverse()) {
      const result = undoTextBlock(out, edit);
      if (result.outcome === 'blocked') return blockedStep(result.refused, result.detail);
      out = result.text;
      kept = [...kept, ...result.kept];
      empty = result.empty;
    }
  }
  // A file Stroq made and the owner has taken everything out of is a file nobody wanted.
  if (entry.created && empty) return { text: null, kept, how: 'entries', reformatted };
  return { text: out, kept, how: out === text ? 'nothing' : 'entries', reformatted };
}

function undoEntry(env: HardenEnv, real: string, text: string, entry: ManifestEntry): Step {
  // Exactly as that apply left it: nothing of the owner's to lose, so the copy goes back whole.
  if (sha256Text(text) === entry.shaAfter) {
    if (entry.created) return { text: null, kept: [], how: 'copy', reformatted: false };
    const copy = entry.backup === null ? null : readBackup(env, real, entry.backup);
    // A copy is trusted only if it is the bytes the record says it is.
    if (copy !== null && sha256Text(copy) === entry.shaBefore) {
      return { text: copy, kept: [], how: 'copy', reformatted: false };
    }
  }
  return undoEntries(text, entry);
}

async function undoLocked(env: HardenEnv, asked: string, rules: WriteRules): Promise<UndoResult> {
  const manifest = readManifest(env);
  // The key it was recorded under, if that is what was asked for; else wherever the path leads.
  const real = entriesFor(manifest, asked).length > 0 ? asked : resolveRealPath(asked);
  const entries = entriesFor(manifest, real);
  const nothing: UndoResult = {
    status: 'already-undone',
    real,
    diff: '',
    kept: [],
    reformatted: false,
    applications: 0,
    notices: [],
  };
  if (entries.length === 0) return nothing;

  assertWriteAllowed(real, rules);
  const current = readTargetText(real);
  let text = current;
  const kept: string[] = [];
  let usedCopy = false;
  let usedEntries = false;
  let reformatted = false;
  for (const entry of [...entries].reverse()) {
    if (text === null) break;
    const step = undoEntry(env, real, text, entry);
    if (step.blocked !== undefined) return { ...nothing, status: 'blocked', blocked: step.blocked };
    text = step.text;
    kept.push(...step.kept);
    usedCopy ||= step.how === 'copy';
    usedEntries ||= step.how === 'entries';
    reformatted ||= step.reformatted;
  }

  // The diff first: it is the one thing that can still refuse, and nothing has been touched yet.
  const changed = text !== current;
  const shown = changed ? maskedDiff(current, text, real) : { diff: '', hidden: false };
  const fs = env.fs === undefined ? {} : { fs: env.fs };
  if (changed) {
    if (text === null) await removeFile(real, { ...rules, ...fs });
    else await writeFileAtomic(real, text, { ...rules, ...fs });
  }
  // The records go only once the file is as it is going to be.
  const { [real]: _undone, ...rest } = manifest.files;
  await writeManifest(env, { ...manifest, files: rest });

  const status: UndoStatus =
    !changed && kept.length === 0
      ? 'already-undone'
      : usedCopy && !usedEntries && kept.length === 0
        ? 'restored'
        : 'surgical';
  return {
    status,
    real,
    diff: shown.diff,
    kept,
    reformatted: reformatted && changed,
    applications: entries.length,
    notices: shown.hidden ? [DIFF_HIDDEN_NOTICE] : [],
  };
}

/**
 * Undoes what Stroq did to `real` (a real path, or a link to it), whatever the owner has done to
 * the file since. See the top of this file for how; `options.root` is the directory the file must
 * stay inside, as for `applyPlan`.
 *
 * Idempotent: when nothing of Stroq's is left to take out, the answer is `already-undone` and the
 * file is not touched. The records are removed only after the file has been written.
 */
export function undoFile(
  env: HardenEnv,
  real: string,
  options: { readonly root?: string } = {},
): Promise<UndoResult> {
  return withManifestLock(env, () => undoLocked(env, real, rulesOf(options.root)));
}
