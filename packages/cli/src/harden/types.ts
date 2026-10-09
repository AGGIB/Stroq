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
  /** A plan that was refused cannot be applied. */
  | 'plan-refused'
  /** The file is not what the plan was made from: the owner changed it, or the path now leads elsewhere. */
  | 'stale-plan';

export class HardenError extends Error {
  readonly code: HardenErrorCode;

  constructor(code: HardenErrorCode, message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = 'HardenError';
    this.code = code;
  }
}

/** What a stat answers that the engine looks at. `fs.Stats` satisfies it. */
export interface StatLike {
  readonly mode: number;
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

/** What a `json-set` found where it wrote: a value, or nothing. */
export type PreviousValue =
  { readonly present: false } | { readonly present: true; readonly value: JsonValue };

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

/** A block of lines between Stroq's markers in a line-oriented file. */
export interface RecordedTextBlockEdit {
  readonly kind: 'text-block';
  readonly id: string;
  /** The lines written between the markers. */
  readonly lines: readonly string[];
  /** The lines of a block with the same id that this replaced, or `null` when it was appended. */
  readonly previous: readonly string[] | null;
  /** The separator written before an appended block, so that undo can take it away too. */
  readonly prefix: string;
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
  | 'markers-damaged';

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
   * Reads a file's text, or `null` when there is no such file. It is called with the REAL path.
   * Planning reads nothing else and writes nothing at all.
   */
  readonly read: (path: string) => string | null;
  /** Which recipe asked, recorded with what was changed. */
  readonly recipe?: string;
  /** The directory the file's real path must stay inside when it is written. */
  readonly root?: string;
  /** The mode of the file if it has to be created. */
  readonly newFileMode?: number;
}

/** What every plan says, whatever kind of file it edits. */
export interface PlanBase {
  readonly recipe: string;
  /** The path as it was asked for. */
  readonly file: string;
  /** The file that will be replaced: `file` with every link followed. */
  readonly real: string;
  readonly existed: boolean;
  /** The text now (`''` when the file does not exist). */
  readonly before: string;
  /** The text after the edits. Equal to `before` when nothing changes or the plan is refused. */
  readonly after: string;
  /** Unified diff from `before` to `after`; `''` when nothing changes. */
  readonly diff: string;
  readonly changed: boolean;
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
 * What a backup id may be: the name of one directory, so no separator, no dot at the front and
 * nothing that is not a plain character. Backups and the manifest both check it, because an id is
 * joined into a path and the manifest is a file someone else could have written.
 */
export const BACKUP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The SHA-256 of `text` as UTF-8, in lower-case hex: how the engine tells one version of a file from another. */
export const sha256Text = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');
