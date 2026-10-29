import { neutralizeControls } from '@stroq/core';
import { createHash } from 'node:crypto';

/**
 * What `stroq harden`'s edit engine shares between its parts: the typed error, the small file
 * system seam, the environment every operation takes, and the shape of a plan and of the edits
 * a plan records.
 *
 * The engine edits files that belong to someone else (an agent's settings, an ignore file), so
 * it has to be able to show a diff, take a copy, write without a half-written moment, and undo
 * without clobbering what the owner did afterwards. Nothing here knows about a particular
 * recipe: those come later and only choose which edits to ask for.
 */

/**
 * Why the engine refused or failed, as a value a caller can branch on. A message is for a
 * person; the code is for the command that prints it.
 */
export type HardenErrorCode =
  /** The file's real path leaves the tree it was allowed to be written in (a symlink led out). */
  | 'path-escapes-root'
  /** A link in the path points nowhere: writing "the file" would make something else, or nothing. */
  | 'dangling-link'
  /** The path Stroq recorded now leads to another file than it did when Stroq edited it. */
  | 'path-changed'
  /** The target is a directory, a FIFO, a device: something that is not a regular file. */
  | 'not-regular-file'
  /** The target is larger than any agent config is. */
  | 'target-too-large'
  /** The target has no write bit for its owner: whoever set that did not want it edited. */
  | 'read-only-target'
  /** The inputs of a diff are bigger than the preview is willing to compute. */
  | 'diff-too-large'
  /** A recipe asked for something the engine cannot do: an empty path, a value that is not JSON. */
  | 'invalid-edit'
  /** A backup id that is not one the engine makes: it would name a place outside its directory. */
  | 'invalid-backup-id'
  /** The manifest is a link, or not a regular file: whatever it points at is not trusted. */
  | 'manifest-unsafe'
  | 'manifest-too-large'
  /** The manifest is not valid JSON, or not what the engine writes. Never read in part. */
  | 'manifest-invalid'
  /** The manifest was written before manifests were signed: nothing in it is trusted. */
  | 'manifest-unsigned'
  /** The manifest does not match its signature, or the key that checks it is missing or not private. */
  | 'manifest-unverified'
  /** A copy undo would put back is there but is not the bytes the manifest recorded for it. */
  | 'backup-mismatch'
  /** A plan that was refused cannot be applied. */
  | 'plan-refused'
  /** The plan's text after is not what its edits make of its text before: it was not made by a planner. */
  | 'plan-inconsistent'
  /** The change cannot be made without laying the whole file out again, and nobody agreed to that. */
  | 'reformat-not-acknowledged'
  /** The path is a link, or lies behind one, and nobody agreed that the change lands in the file it leads to. */
  | 'link-not-acknowledged'
  /** The change replaces a value that looks like a credential, which cannot be put back, and nobody agreed. */
  | 'credential-loss-not-acknowledged'
  /** Writing the file back would lose something in it (a number, a duplicate key, a key order). */
  | 'lossy-json'
  /** The file is not valid UTF-8: decoding and writing it would change bytes the owner wrote. */
  | 'not-utf8'
  /** The file is not what the plan was made from: the owner changed it, or the path now leads elsewhere. */
  | 'stale-plan';

export class HardenError extends Error {
  readonly code: HardenErrorCode;

  /**
   * The message is for a person, and it names paths that a repository chose (the name of a link,
   * what it leads to). A terminal obeys the control sequences in a name, so the message is made
   * safe to print: every such character is written out as a visible `\uXXXX` escape.
   */
  constructor(code: HardenErrorCode, message: string, options?: { readonly cause?: unknown }) {
    super(neutralizeControls(message), options);
    this.name = 'HardenError';
    this.code = code;
  }
}

/** What a stat answers that the engine looks at. `fs.Stats` satisfies it. */
export interface StatLike {
  readonly mode: number;
  /** Milliseconds since the epoch. */
  readonly mtimeMs: number;
  isFile(): boolean;
}

/** The part of a file handle an atomic write uses. `fs.promises.FileHandle` satisfies it. */
export interface FileHandleLike {
  writeFile(data: string | Uint8Array): Promise<void>;
  chmod(mode: number): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

/**
 * The file system operations the engine WRITES with, and nothing else. It exists so that a test
 * can make one of them fail (the rename that would have put a half-edited file in place) and
 * then look at what is left on disk. Reading goes through `readRegularFile`, which is not
 * injectable because no test needs a read to fail.
 */
export interface Fs {
  stat(path: string): Promise<StatLike>;
  mkdir(
    path: string,
    options: { readonly recursive: true; readonly mode?: number },
  ): Promise<unknown>;
  open(path: string, flags: string, mode: number): Promise<FileHandleLike>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  readdir(path: string): Promise<string[]>;
  rmdir(path: string): Promise<void>;
}

/**
 * Passed to every operation, so that a test never touches the real home: `home` is a Stroq home
 * directory (`stroqHome()` in the product, a temp directory in a test).
 */
export interface HardenEnv {
  readonly home: string;
  readonly now: () => Date;
  /** The Stroq version recorded with what was changed. */
  readonly version: string;
  readonly fs?: Fs;
}

/** Any JSON value. */
export type JsonValue =
  null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type JsonObject = { readonly [key: string]: JsonValue };

/**
 * What a recipe asks of a JSON file.
 *
 * `json-array-add` appends `value` to the array at `path`, unless an element that is deep-equal to
 * it is already there. `json-set` puts `value` at `path`. Either creates the objects (and the
 * array) on the way if they are absent.
 */
export type JsonEdit =
  | {
      readonly kind: 'json-array-add';
      readonly path: readonly string[];
      readonly value: JsonValue;
    }
  | { readonly kind: 'json-set'; readonly path: readonly string[]; readonly value: JsonValue };

/**
 * What a `json-set` found where it wrote: nothing, or a value. A value that is credential-shaped
 * is not kept (the record is a file too, and would be one more place the credential lives): it is
 * recorded as a placeholder with `masked: true`, and undo cannot put it back.
 */
export type PreviousValue =
  | { readonly present: false }
  | { readonly present: true; readonly value: JsonValue; readonly masked?: true };

/**
 * An edit as it was made: everything undo needs to take back exactly that and nothing else.
 *
 * `createdFrom` is the first index of `path` whose key did not exist before the edit (and so was
 * made by it), or `path.length` when everything was already there. It is what lets undo remove
 * the empty skeleton it created instead of leaving `"permissions": {"deny": []}` behind.
 */
export type RecordedJsonEdit =
  | {
      readonly kind: 'json-array-add';
      readonly path: readonly string[];
      readonly value: JsonValue;
      /** The element was there already: it is the owner's, and undo never removes it. */
      readonly preexisting: boolean;
      readonly createdFrom: number;
    }
  | {
      readonly kind: 'json-set';
      readonly path: readonly string[];
      readonly value: JsonValue;
      readonly previous: PreviousValue;
      readonly createdFrom: number;
    };

/**
 * A block of lines between Stroq's markers in a line-oriented file, with the exact bytes that were
 * written around it when it was appended, so that undo takes away those and nothing else.
 *
 * Appending a block to `text` writes `prefix`, the block (begin marker, lines, end marker) and
 * `suffix`. For a block that replaced one where it stood, all three of `prefix`, `closesLastLine`
 * and `suffix` say that nothing was written around it.
 */
export interface RecordedTextBlockEdit {
  readonly kind: 'text-block';
  readonly id: string;
  /** The lines written between the markers. */
  readonly lines: readonly string[];
  /**
   * The lines of a block with the same id that this replaced, or `null` when it was appended. They
   * are the lines the owner left between Stroq's markers, recorded as they were so that undo can put
   * them back. The record is a file, so a block whose lines look like a credential is not replaced
   * at all (the plan is refused with `credential-in-block`), and none is ever recorded. An unchanged
   * plan can still carry raw lines here; do not print or serialize a whole plan for presentation.
   */
  readonly previous: readonly string[] | null;
  /**
   * The bytes written before the begin marker: a line break to end the owner's last line if it
   * had none, then a blank line to set the block off unless there was one already.
   */
  readonly prefix: string;
  /** The first line break of `prefix` ended the owner's last line, which had none. */
  readonly closesLastLine: boolean;
  /**
   * The line break written after the end marker. Undo takes away the end marker's line together
   * with whatever line break it has by then, so this is not what it matches on; it is kept so that
   * the record says everything that was written around the block.
   */
  readonly suffix: string;
}

export type RecordedEdit = RecordedJsonEdit | RecordedTextBlockEdit;

/** Why a plan will not be applied. The file is never rewritten in any of these cases. */
export type PlanRefusal =
  /** Comments or trailing commas: rewriting it would lose them. Print a snippet instead. */
  | 'jsonc'
  | 'invalid-json'
  /** JSON, but not an object at the top. */
  | 'not-object'
  /** Not valid UTF-8: reading and writing it as text would change bytes the owner wrote. */
  | 'not-utf8'
  /** An edit's path runs through, or ends in, a value of the wrong type. */
  | 'type-conflict'
  /** A text block's markers are not a matched pair, or appear twice. */
  | 'markers-damaged'
  /** The lines between a text block's markers look like a credential, and replacing them would record them. */
  | 'credential-in-block'
  /** A link carries the path out of the tree it belongs to. The file was never opened. */
  | 'path-escapes-root'
  /** A link in the path points nowhere. The file was never opened. */
  | 'dangling-link'
  /** Plain JSON, but writing it back would lose or reorder something the file says. */
  | 'lossy-json';

/**
 * Whether a byte copy of the file will be kept before it is replaced, and if not, why.
 * A file that holds credential-shaped text is not copied: the copy would be one more place the
 * credential lives. Undo of such a file takes its own entries out and leaves the rest.
 */
export type BackupPlan =
  | 'copy'
  | 'none-new-file'
  | 'none-credential-text'
  /** Too large to look at in full, which is not the same as clean. */
  | 'none-unchecked';

export interface PlanOptions {
  /**
   * Reads a file's text, or `null` when there is no such file. It is called with the REAL path,
   * and only after the path has passed the rules a write would apply: for a path that leaves its
   * tree, or leads nowhere, it is not called at all. Planning reads nothing else and writes
   * nothing at all.
   */
  readonly read: (path: string) => string | null;
  /** Which recipe asked, recorded with what was changed. */
  readonly recipe?: string;
  /**
   * The project or home directory the real path must stay inside. Pass the trusted top-level
   * directory, not a config subdirectory: only links below this root count as repository links.
   */
  readonly root?: string;
  /** The mode of the file if it has to be created. */
  readonly newFileMode?: number;
  /**
   * The owner has seen the link notice and agreed to preview the named target. Without this the
   * entire diff is withheld for a linked path, including context and reformatted additions. This
   * permits preview only; apply still needs its own `acknowledgeLink` option.
   */
  readonly acknowledgeLink?: boolean;
}

/**
 * Internal engine data, including raw owner text. Never print or serialize a whole plan for UI,
 * logging or `--json`; construct an explicit presentation object from diff, notices and metadata.
 */
export interface PlanBase {
  readonly recipe: string;
  /** The path as it was asked for. */
  readonly file: string;
  /** The file that will be replaced: `file` with every link followed. */
  readonly real: string;
  /** Whether the file was there. `false` too for a plan refused before the file was opened. */
  readonly existed: boolean;
  /** Raw text now, possibly secret. Engine-only; `''` when absent or never opened. */
  readonly before: string;
  /** Raw text after the edits, possibly secret. Engine-only; equals before when unchanged/refused. */
  readonly after: string;
  /** Unified diff; `''` when nothing changes or a linked preview is withheld. */
  readonly diff: string;
  /** The linked target was not acknowledged for preview. Replayed without reading the file system. */
  readonly previewWithheld?: true;
  readonly changed: boolean;
  /**
   * Why the plan cannot be applied. `path-escapes-root` and `dangling-link` mean the file was never
   * opened, so the plan holds nothing of it.
   */
  readonly refused?: PlanRefusal;
  /** What the refusal is about, in words that name the place and never the value. */
  readonly refusedDetail?: string;
  readonly backup: BackupPlan;
  /** Things the owner should be told before saying yes. */
  readonly notices: readonly string[];
  readonly root?: string;
  readonly newFileMode?: number;
}

export interface JsonPlan extends PlanBase {
  readonly kind: 'json';
  readonly edits: readonly RecordedJsonEdit[];
  /** Whether the file, parsed and written back with no edits, comes out as the same text. */
  readonly roundTrips: boolean;
  /** `will-change`: the edit cannot be made without also re-laying-out the file. */
  readonly formatting: 'preserved' | 'will-change';
}

export interface TextBlockPlan extends PlanBase {
  readonly kind: 'text-block';
  readonly edits: readonly RecordedTextBlockEdit[];
}

export type Plan = JsonPlan | TextBlockPlan;

/**
 * What an id may be, for a backup (the name of one directory) and for a text block (a word inside
 * a marker line): a plain name, so no separator, no dot at the front, no space and nothing that
 * is not a plain character. Backups, text blocks and the manifest all check this one rule,
 * because an id is joined into a path or a line, and the manifest is a file someone else could
 * have written.
 */
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The SHA-256 of `text` as UTF-8, in lower-case hex: how the engine tells one version of a file from another. */
export const sha256Text = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');
