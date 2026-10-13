import { resolveRealPath } from '../harden/atomic.js';
import { readBackup } from '../harden/backup.js';
import { deepEqual } from '../harden/json-edit.js';
import { getAt, isArray, isObject } from '../harden/json-doc.js';
import { readManifest, type Manifest, type ManifestEntry } from '../harden/manifest.js';
import { decodeUtf8Strict, readTargetBytes } from '../harden/read.js';
import { findBlock } from '../harden/textblock-find.js';
import { HardenError, sha256Text } from '../harden/types.js';
import type { JsonObject, JsonValue, RecordedEdit } from '../harden/types.js';
import { outsideLine } from '../ui/layout.js';
import type { HardenContext } from './harden-deps.js';
import type { Printer } from './harden-printer.js';

/**
 * `stroq harden status`: what the record says Stroq changed, and whether each file still has it.
 *
 * It reads the record and each file it names, and writes nothing. For every file: which of the entries
 * Stroq added are still there, whether the owner has edited the file since, whether the copy of the file
 * from before is still kept, and whether the path still leads to the file Stroq edited. A rule that was
 * already the owner's when Stroq applied is reported as theirs and is not counted: it was never Stroq's.
 */

export type FileState = 'in-place' | 'partial' | 'gone' | 'missing' | 'unreadable';
export type ItemState = 'present' | 'missing' | 'yours' | 'edited' | 'unknown';

export interface StatusItem {
  readonly text: string;
  readonly state: ItemState;
}

export interface FileStatus {
  readonly file: string;
  readonly recipes: readonly string[];
  readonly changes: number;
  readonly appliedAt: string;
  readonly created: boolean;
  readonly state: FileState;
  readonly items: readonly StatusItem[];
  readonly editedSince: boolean;
  readonly backup: 'kept' | 'gone' | 'none';
  readonly pathNow: 'same' | 'moved';
  readonly notices: readonly string[];
}

/** What the file holds now: its text, or why it cannot be looked at. */
type Current =
  | { readonly kind: 'text'; readonly text: string; readonly doc: JsonObject | null }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unreadable'; readonly why: string };

function parsed(text: string): JsonObject | null {
  try {
    const value: unknown = JSON.parse(text.startsWith('\uFEFF') ? text.slice(1) : text);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

function currentOf(real: string): Current {
  try {
    const bytes = readTargetBytes(real);
    if (bytes === null) return { kind: 'absent' };
    const text = decodeUtf8Strict(bytes, real);
    return { kind: 'text', text, doc: parsed(text) };
  } catch (err) {
    const why = err instanceof HardenError ? err.message : 'it cannot be read';
    return { kind: 'unreadable', why: outsideLine(why) };
  }
}

const labelOf = (value: JsonValue): string =>
  outsideLine(typeof value === 'string' ? value : JSON.stringify(value));

type TextNow = Extract<Current, { readonly kind: 'text' }>;

function itemsOfEdit(edit: RecordedEdit, now: TextNow): StatusItem[] {
  if (edit.kind === 'text-block') {
    const found = findBlock(now.text, edit.id);
    const state: ItemState =
      found.kind === 'none'
        ? 'missing'
        : found.kind === 'damaged'
          ? 'unknown'
          : found.body.join('\n') === edit.lines.join('\n')
            ? 'present'
            : 'edited';
    return edit.lines.map((line) => ({ text: outsideLine(line), state }));
  }
  if (now.doc === null) return [];
  const there = getAt(now.doc, edit.path);
  if (edit.kind === 'json-set') {
    const same = there !== undefined && deepEqual(there, edit.value);
    return [{ text: outsideLine(edit.path.join('.')), state: same ? 'present' : 'edited' }];
  }
  if (edit.preexisting) return [{ text: labelOf(edit.value), state: 'yours' }];
  const held = isArray(there) && there.some((element) => deepEqual(element, edit.value));
  return [{ text: labelOf(edit.value), state: held ? 'present' : 'missing' }];
}

/** The items of every entry, each named once, in the order the entries were made. */
function itemsOf(entries: readonly ManifestEntry[], now: TextNow): StatusItem[] {
  const seen = new Map<string, StatusItem>();
  for (const entry of entries) {
    for (const item of entry.edits.flatMap((edit) => itemsOfEdit(edit, now))) {
      seen.set(item.text, item);
    }
  }
  return [...seen.values()];
}

function stateOf(items: readonly StatusItem[]): FileState {
  if (items.some((item) => item.state === 'unknown')) return 'unreadable';
  const counted = items.filter((item) => item.state !== 'yours');
  if (counted.every((item) => item.state === 'present')) return 'in-place';
  return counted.every((item) => item.state === 'missing') ? 'gone' : 'partial';
}

function backupOf(ctx: HardenContext, real: string, newest: ManifestEntry): FileStatus['backup'] {
  if (newest.backup === null) return 'none';
  return readBackup(ctx.env, real, newest.backup) === null ? 'gone' : 'kept';
}

const NOT_JSON = 'it is not plain JSON now (a comment or a syntax error)';

function fileStatus(
  ctx: HardenContext,
  real: string,
  entries: readonly ManifestEntry[],
): FileStatus {
  const newest = entries[entries.length - 1] as ManifestEntry;
  const now = currentOf(real);
  const usesJson = entries.some((entry) => entry.edits.some((edit) => edit.kind !== 'text-block'));
  const unreadableWhy =
    now.kind === 'unreadable'
      ? now.why
      : now.kind === 'text' && usesJson && now.doc === null
        ? NOT_JSON
        : null;
  const items = now.kind === 'text' && unreadableWhy === null ? itemsOf(entries, now) : [];
  const state: FileState =
    now.kind === 'absent' ? 'missing' : unreadableWhy !== null ? 'unreadable' : stateOf(items);
  return {
    file: outsideLine(real),
    recipes: [...new Set(entries.map((entry) => outsideLine(entry.recipe)))],
    changes: entries.length,
    appliedAt: outsideLine(newest.appliedAt),
    created: entries.some((entry) => entry.created),
    state,
    items,
    editedSince: now.kind !== 'text' || sha256Text(now.text) !== newest.shaAfter,
    backup: backupOf(ctx, real, newest),
    pathNow: resolveRealPath(real) === real ? 'same' : 'moved',
    notices: unreadableWhy === null ? [] : [`Stroq cannot check the file: ${unreadableWhy}`],
  };
}

/** What the record says, file by file in path order, each looked at as it is now. */
export function statusOf(ctx: HardenContext, manifest: Manifest): readonly FileStatus[] {
  return Object.entries(manifest.files)
    .filter(([, entries]) => entries.length > 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([real, entries]) => fileStatus(ctx, real, entries));
}

const plural = (count: number, one: string, many: string): string => (count === 1 ? one : many);

function namesOf(items: readonly StatusItem[], state: ItemState): string | null {
  const named = items.filter((item) => item.state === state).map((item) => item.text);
  return named.length === 0
    ? null
    : named.slice(0, 10).join(', ') + (named.length > 10 ? `, and ${named.length - 10} more` : '');
}

function stateLine(status: FileStatus): string {
  const counted = status.items.filter((item) => item.state !== 'yours');
  const present = counted.filter((item) => item.state === 'present').length;
  const how = `${present} of ${counted.length}`;
  const lines: Readonly<Record<FileState, string>> = {
    'in-place': `State: everything Stroq added is in place (${how}).`,
    partial: `State: only part of what Stroq added is in place (${how}).`,
    gone: 'State: none of what Stroq added is in the file now.',
    missing: 'State: the file is not there now.',
    unreadable:
      status.notices[0]?.startsWith('Stroq cannot') === true
        ? `State: ${status.notices[0]}`
        : 'State: unknown.',
  };
  return lines[status.state];
}

const COPY_LINES: Readonly<Record<FileStatus['backup'], (created: boolean) => string>> = {
  kept: () => 'Copy: a byte copy of the file as it was is kept.',
  gone: () =>
    'Copy: the byte copy that was kept is gone, so undo can only take out what Stroq added.',
  none: (created) =>
    created
      ? 'Copy: none was kept, because Stroq made the file; undo removes it.'
      : 'Copy: none was kept, because the file held credential-shaped text or was too large to check; undo takes out only what Stroq added.',
};

function fileLines(status: FileStatus): string[] {
  const missing = namesOf(status.items, 'missing');
  const changed = namesOf(status.items, 'edited');
  return [
    status.file,
    `  Applied by ${status.recipes.join(', ')}, ${status.changes} ${plural(status.changes, 'change', 'changes')}, the last on ${status.appliedAt}.`,
    `  ${stateLine(status)}`,
    ...(missing === null ? [] : [`  Missing: ${missing}`]),
    ...(changed === null ? [] : [`  Changed: ${changed}`]),
    `  ${COPY_LINES[status.backup](status.created)}`,
    status.editedSince
      ? '  The file has been edited since Stroq last changed it.'
      : '  The file has not been edited since.',
    ...(status.pathNow === 'moved'
      ? ['  The path now leads to another file than the one Stroq edited.']
      : []),
  ];
}

const NOTHING = [
  'Nothing applied: stroq harden has not changed any file.',
  'To see what it would do: stroq harden',
].join('\n');

export function statusCommand(ctx: HardenContext, printer: Printer): number {
  const files = statusOf(ctx, readManifest(ctx.env));
  if (files.length === 0) {
    return printer.finish(0, { status: 'status', message: NOTHING }, { files });
  }
  printer.show(`${files.map((status) => fileLines(status).join('\n')).join('\n\n')}\n`);
  return printer.finish(0, { status: 'status', message: '' }, { files });
}
