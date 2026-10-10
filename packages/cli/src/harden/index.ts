/**
 * `stroq harden`'s edit engine: planning a change to a file that belongs to someone else, showing
 * it, applying it so that it can be undone, and undoing it without clobbering what the owner did
 * afterwards.
 *
 * - `planJsonEdits` and `planTextBlock` read a file and say what would change (nothing is written);
 * - `applyPlan` (apply.ts) makes the change: a byte copy, a record, one atomic replacement;
 * - `undoFile` (undo.ts) takes it back, from the copy when the file is as it was left and entry by
 *   entry when it is not.
 */

export * from './types.js';
export { applyPlan, type ApplyOptions, type ApplyResult } from './apply.js';
export {
  DIFF_OMITTED_NOTICE,
  undoFile,
  type UndoOptions,
  type UndoResult,
  type UndoStatus,
} from './undo.js';
export {
  MAX_TARGET_BYTES,
  assertWriteAllowed,
  nodeFs,
  removeFile,
  resolveRealPath,
  writeFileAtomic,
  type AtomicWriteOptions,
  type AtomicWriteResult,
  type WriteRules,
} from './atomic.js';
export {
  decodeUtf8Strict,
  readTargetBytes,
  readTargetStrict,
  readTargetText,
  sameBytes,
} from './read.js';
export {
  BACKUPS_KEPT_PER_FILE,
  backupFile,
  backupPath,
  findCredentialShape,
  newBackupId,
  planBackup,
  pruneBackups,
  readBackup,
  removeBackup,
  type BackupResult,
  type CredentialShape,
} from './backup.js';
export { DIFF_HIDDEN_NOTICE } from './diff-mask.js';
export {
  HIDDEN_LINE,
  MAX_DIFF_BYTES,
  MAX_DIFF_LINES,
  unifiedDiff,
  type DiffOptions,
} from './diff.js';
export {
  MASKED_PREVIOUS_VALUE,
  REPLACED_CREDENTIAL_NOTICE,
  deepEqual,
  findJsoncSyntax,
  planJsonEdits,
  undoJsonEdits,
  type JsonUndo,
} from './json-edit.js';
export { findLossyJson } from './json-lossy.js';
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
