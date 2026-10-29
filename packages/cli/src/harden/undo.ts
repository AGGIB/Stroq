import { rulesOf } from './apply.js';
import {
  assertWriteAllowed,
  removeEmptyDirs,
  removeFile,
  resolveRealPath,
  writeFileAtomic,
  type WriteRules,
} from './atomic.js';
import { readRecordedBackup } from './backup.js';
import { DIFF_HIDDEN_NOTICE, maskedDiff } from './diff-mask.js';
import { undoJsonEdits } from './json-edit.js';
import {
  entriesFor,
  readManifest,
  readManifestSnapshot,
  assertManifestSnapshot,
  withManifestLock,
  writeManifest,
  type ManifestEntry,
} from './manifest.js';
import { decodeUtf8Strict, readTargetBytes } from './read.js';
import { assertUnchanged } from './recheck.js';
import { undoTextBlock } from './textblock.js';
import {
  HardenError,
  sha256Text,
  type HardenEnv,
  type PlanRefusal,
  type RecordedEdit,
  type RecordedJsonEdit,
  type RecordedTextBlockEdit,
} from './types.js';
import {
  assertPreparedBinding,
  capturePreparedState,
  stalePrepared,
  type HardenPreparedBinding,
  type PreparedOperationOptions,
} from './prepared-state.js';

/**
 * Undoing what Stroq did to a file.
 *
 * Undo goes back through the recorded applies, newest first. When the file is exactly as an apply
 * left it, the copy made before that apply is put back. When it is not (the owner has edited it
 * since, or no copy was kept, or the copy was pruned) only the entries Stroq added are taken out,
 * and everything else stays. When the file is exactly as it was BEFORE an apply, that apply never
 * happened (its record outlived a write that failed), and there is nothing of it to take out.
 * Nothing is written until every apply has been worked out, and a file that cannot be edited
 * safely is left untouched with its records.
 *
 * Before it writes, undo checks that the path still leads to the file the records are about, and
 * looks at the file once more, as `apply` does: see `recheck.ts` for what that does and does not
 * promise.
 */

export type UndoStatus =
  /** The file is as it was before: the copy was put back, or a file Stroq made was removed. */
  | 'restored'
  /** Stroq's entries were taken out and the rest of the file was kept. */
  | 'surgical'
  /** There was nothing of Stroq's left to take out. */
  | 'already-undone'
  /** The file cannot be edited safely as it is. Nothing was changed. */
  | 'blocked';

export interface UndoOptions {
  /**
   * The directory the file must stay inside, as for `applyPlan`. The root each apply recorded is
   * kept to as well, whether or not this is given.
   */
  readonly root?: string;
}

export interface UndoResult {
  readonly status: UndoStatus;
  readonly real: string;
  /** What undo changed on disk. Empty when it changed nothing, or when it was left out (see `notices`). */
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

/** Said when the files are too large for a diff to be shown: undo does not depend on the preview. */
export const DIFF_OMITTED_NOTICE =
  'the diff was left out: the file is too large to show a diff of; the undo itself was done';

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
  const sha = sha256Text(text);
  // Exactly as that apply left it: nothing of the owner's to lose, so the copy goes back whole.
  if (sha === entry.shaAfter) {
    if (entry.created) return { text: null, kept: [], how: 'copy', reformatted: false };
    // A copy is used only if it is the bytes the signed record says it is. One that is gone
    // (pruned) sends this apply down the path of taking its entries out; one that is there but is
    // not those bytes is refused before anything is written (`readRecordedBackup`).
    const copy =
      entry.backup === null ? null : readRecordedBackup(env, real, entry.backup, entry.shaBefore);
    if (copy !== null) return { text: copy, kept: [], how: 'copy', reformatted: false };
  }
  // Exactly as it was before that apply: the record is of a change that was never made.
  if (entry.shaBefore !== null && sha === entry.shaBefore) {
    return { text, kept: [], how: 'nothing', reformatted: false };
  }
  return undoEntries(text, entry);
}

/** The diff to show, and what to tell the owner about it. A diff that cannot be made is left out. */
function previewOf(
  current: string | null,
  text: string | null,
  real: string,
): { readonly diff: string; readonly notices: readonly string[] } {
  if (current === text) return { diff: '', notices: [] };
  try {
    const shown = maskedDiff(current, text, real);
    return { diff: shown.diff, notices: shown.hidden ? [DIFF_HIDDEN_NOTICE] : [] };
  } catch (err) {
    if (err instanceof HardenError && err.code === 'diff-too-large') {
      return { diff: '', notices: [DIFF_OMITTED_NOTICE] };
    }
    throw err;
  }
}

/**
 * Refuses unless `real` is still the file the records are about: filed under its own path, inside
 * every root that was recorded for it (and the one the caller named), and not behind a link that
 * has been put there since. Touches nothing.
 */
function assertRecordedPath(
  real: string,
  entries: readonly ManifestEntry[],
  options: UndoOptions,
): void {
  if (entries.some((entry) => entry.real !== real)) {
    throw new HardenError(
      'manifest-invalid',
      'the manifest has a record filed under a path that is not the path it is about',
    );
  }
  const roots = new Set<string>();
  if (options.root !== undefined) roots.add(options.root);
  for (const entry of entries) if (entry.root !== null) roots.add(entry.root);
  // Every root is a tree the file has to stay in; with none, the rule `init` applies is the one.
  const rules: WriteRules[] = roots.size === 0 ? [{}] : [...roots].map((root) => ({ root }));
  for (const rule of rules) assertWriteAllowed(real, rule);
  // A path that is still inside its tree can still lead to another file than the one that was
  // edited (a link put there since, a directory that was moved and linked back).
  if (resolveRealPath(real) !== real) {
    throw new HardenError(
      'path-changed',
      `refusing to undo ${real}: the path now leads to ${resolveRealPath(real)}, not to the file Stroq edited. Put the file back, or remove the link, first.`,
    );
  }
}

/** What going back through the recorded applies came to. */
interface Worked {
  /** The text the file should hold; `null` when it should not exist. */
  readonly text: string | null;
  readonly kept: readonly string[];
  readonly usedCopy: boolean;
  readonly usedEntries: boolean;
  readonly reformatted: boolean;
  readonly blocked?: { readonly refused: PlanRefusal; readonly detail: string };
}

/**
 * Goes back through `entries`, newest first, from the text the file holds now, and works out what
 * it should hold. Nothing is written.
 */
function workOut(
  env: HardenEnv,
  real: string,
  current: string | null,
  entries: readonly ManifestEntry[],
): Worked {
  let text = current;
  const kept: string[] = [];
  let usedCopy = false;
  let usedEntries = false;
  let reformatted = false;
  for (const entry of [...entries].reverse()) {
    if (text === null) break;
    const step = undoEntry(env, real, text, entry);
    if (step.blocked !== undefined) {
      return { text, kept, usedCopy, usedEntries, reformatted, blocked: step.blocked };
    }
    text = step.text;
    kept.push(...step.kept);
    usedCopy ||= step.how === 'copy';
    usedEntries ||= step.how === 'entries';
    reformatted ||= step.reformatted;
  }
  return { text, kept, usedCopy, usedEntries, reformatted };
}

/**
 * Makes the file what undo worked out: written, or removed when it should not exist. The file is
 * looked at once more right before (see `recheck.ts`), and a file that changed is left alone.
 */
async function putFileBack(
  env: HardenEnv,
  real: string,
  text: string | null,
  bytes: Uint8Array | null,
  options: UndoOptions,
  assertCurrent?: () => void | Promise<void>,
): Promise<void> {
  const rules = rulesOf(options.root);
  const fs = env.fs === undefined ? {} : { fs: env.fs };
  const look = async (): Promise<void> => {
    await assertCurrent?.();
    assertUnchanged(real, real, bytes);
  };
  if (text === null) await removeFile(real, { ...rules, ...fs, beforeRemove: look });
  else await writeFileAtomic(real, text, { ...rules, ...fs, beforeRename: look });
}

export interface PreparedUndo {
  readonly file: string;
  readonly root: string | null;
  readonly binding: HardenPreparedBinding;
  /** Private result: diff/kept labels are not a public API projection. */
  readonly result: UndoResult;
  readonly changed: boolean;
  readonly removesFile: boolean;
  readonly applications: number;
  readonly recipes: readonly string[];
  readonly candidateSha256: string | null;
  /** Raw private candidate for fixed-count projections. NEVER return through a public API. */
  readonly candidateText: string | null;
}

function undoPrepared(env: HardenEnv, file: string, options: UndoOptions) {
  const before = capturePreparedState(env, file, options.root ?? null, null);
  const real = before.binding.real;
  const entries = entriesFor(before.manifest, real);
  if (entries.length) assertRecordedPath(real, entries, options);
  const bytes = readTargetBytes(real);
  const current = bytes === null ? null : decodeUtf8Strict(bytes, real);
  const worked = workOut(env, real, current, entries);
  const changed = worked.blocked === undefined && worked.text !== current;
  const preview = changed ? previewOf(current, worked.text, real) : { diff: '', notices: [] };
  const result: UndoResult = {
    status: worked.blocked
      ? 'blocked'
      : !changed && worked.kept.length === 0
        ? 'already-undone'
        : worked.usedCopy && !worked.usedEntries && worked.kept.length === 0
          ? 'restored'
          : 'surgical',
    real,
    diff: preview.diff,
    kept: worked.kept,
    reformatted: worked.reformatted && changed,
    applications: entries.length,
    notices: preview.notices,
    ...(worked.blocked ? { blocked: worked.blocked } : {}),
  };
  const after = capturePreparedState(env, file, options.root ?? null, null);
  assertPreparedBinding(before.binding, after.binding);
  const candidateSha256 = worked.text === null ? null : sha256Text(worked.text);
  const prepared: PreparedUndo = {
    file,
    root: options.root ?? null,
    binding: { ...after.binding, candidateSha256 },
    result,
    changed,
    removesFile: changed && worked.text === null,
    applications: entries.length,
    recipes: [...new Set(entries.map((entry) => entry.recipe))],
    candidateSha256,
    candidateText: worked.text,
  };
  return { prepared, manifest: before.manifest, entries, current, bytes, worked };
}

/** Read-only computation of ALL recorded applications to one file, never only one recipe. */
export function prepareUndo(env: HardenEnv, file: string, options: UndoOptions = {}): PreparedUndo {
  return undoPrepared(env, file, options).prepared;
}

/** Caller MUST already hold the actual manifest lock. Recomputes, validates, then uses fresh data. */
export async function applyPreparedUndoUnderManifestLock(
  prepared: PreparedUndo,
  env: HardenEnv,
  options: PreparedOperationOptions = {},
): Promise<UndoResult> {
  const rules = prepared.root === null ? {} : { root: prepared.root };
  const fresh = undoPrepared(env, prepared.file, rules);
  assertPreparedBinding(prepared.binding, fresh.prepared.binding);
  if (
    JSON.stringify(prepared.result) !== JSON.stringify(fresh.prepared.result) ||
    prepared.applications !== fresh.prepared.applications ||
    JSON.stringify(prepared.recipes) !== JSON.stringify(fresh.prepared.recipes) ||
    prepared.changed !== fresh.prepared.changed ||
    prepared.removesFile !== fresh.prepared.removesFile ||
    prepared.candidateSha256 !== fresh.prepared.candidateSha256 ||
    prepared.candidateText !== fresh.prepared.candidateText
  )
    stalePrepared();
  await options.assertCurrent?.();
  const recheck = (): void =>
    assertPreparedBinding(
      prepared.binding,
      capturePreparedState(env, prepared.file, prepared.root, prepared.candidateSha256).binding,
    );
  recheck();
  if (fresh.worked.blocked || fresh.entries.length === 0) return fresh.prepared.result;
  if (fresh.prepared.changed)
    await putFileBack(
      env,
      fresh.prepared.binding.real,
      fresh.worked.text,
      fresh.bytes,
      rules,
      async () => {
        await options.assertCurrent?.();
        recheck();
      },
    );
  // File mutation is complete; do not compare its pre-write identity or roll it back.
  assertManifestSnapshot(env, prepared.binding.manifest);
  const nowBytes = readTargetBytes(fresh.prepared.binding.real);
  if (
    (nowBytes === null
      ? null
      : sha256Text(decodeUtf8Strict(nowBytes, fresh.prepared.binding.real))) !==
    prepared.candidateSha256
  )
    stalePrepared();
  if (fresh.worked.text === null) {
    const createdDirs = fresh.entries.flatMap((entry) => entry.createdDirs ?? []);
    if (createdDirs.length) {
      const roots = new Set<string>();
      if (prepared.root !== null) roots.add(prepared.root);
      for (const entry of fresh.entries) if (entry.root !== null) roots.add(entry.root);
      await removeEmptyDirs(createdDirs, {
        ...(roots.size ? { roots: [...roots] } : {}),
        ...(env.fs ? { fs: env.fs } : {}),
      });
    }
  }
  const { [fresh.prepared.binding.real]: _removed, ...rest } = fresh.manifest.files;
  await writeManifest(env, { ...fresh.manifest, files: rest }, prepared.binding.manifest);
  return fresh.prepared.result;
}

async function undoLocked(
  env: HardenEnv,
  asked: string,
  options: UndoOptions,
): Promise<UndoResult> {
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

  assertRecordedPath(real, entries, options);
  // Strictly: text that was decoded loosely and written back would replace what the owner wrote
  // with U+FFFD. A file that is not valid UTF-8 is left exactly as it is.
  const bytes = readTargetBytes(real);
  const current = bytes === null ? null : decodeUtf8Strict(bytes, real);
  const worked = workOut(env, real, current, entries);
  if (worked.blocked !== undefined)
    return { ...nothing, status: 'blocked', blocked: worked.blocked };
  const { text, kept, usedCopy, usedEntries, reformatted } = worked;

  const changed = text !== current;
  const preview = changed ? previewOf(current, text, real) : { diff: '', notices: [] };
  if (changed) await putFileBack(env, real, text, bytes, options);
  if (text === null) {
    const createdDirs = entries.flatMap((entry) => entry.createdDirs ?? []);
    if (createdDirs.length > 0) {
      const roots = new Set<string>();
      if (options.root !== undefined) roots.add(options.root);
      for (const entry of entries) if (entry.root !== null) roots.add(entry.root);
      await removeEmptyDirs(createdDirs, {
        ...(roots.size === 0 ? {} : { roots: [...roots] }),
        ...(env.fs === undefined ? {} : { fs: env.fs }),
      });
    }
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
    diff: preview.diff,
    kept,
    reformatted: reformatted && changed,
    applications: entries.length,
    notices: preview.notices,
  };
}

/**
 * Undoes what Stroq did to `real` (a real path, or a link to it), whatever the owner has done to
 * the file since. See the top of this file for how.
 *
 * Throws, before anything is written, a `HardenError`:
 * - `path-escapes-root` or `dangling-link` for a path that leaves a tree it must stay in or leads
 *   nowhere (the trees are the roots recorded when Stroq edited the file, `options.root`, and the
 *   rule `init` applies);
 * - `path-changed` for a path that no longer leads to the file Stroq edited;
 * - `not-utf8` for a file that is not valid UTF-8;
 * - `stale-plan` for a file that changed while undo was working it out;
 * - `manifest-invalid` and the other manifest errors for a manifest that cannot be trusted,
 *   among them `manifest-unsigned` (from before manifests were signed) and `manifest-unverified`;
 * - `backup-mismatch` for a kept copy that is there but is not the bytes the manifest recorded.
 *
 * Idempotent: when nothing of Stroq's is left to take out, the answer is `already-undone` and the
 * file is not touched. The records are removed only after the file has been written. A diff that
 * is too large to show is left out and said so (`DIFF_OMITTED_NOTICE`); the undo is done anyway.
 */
export function undoFile(
  env: HardenEnv,
  real: string,
  options: UndoOptions = {},
): Promise<UndoResult> {
  return withManifestLock(env, () => undoLocked(env, real, options));
}
