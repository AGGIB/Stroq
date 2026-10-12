import type { ManifestEntry } from '../harden/manifest.js';
import type {
  JsonValue,
  RecordedEdit,
  RecordedJsonEdit,
  RecordedTextBlockEdit,
} from '../harden/types.js';
import { outsideLine } from '../ui/layout.js';

/**
 * What Stroq recorded about a file, as lines to read before undoing it.
 *
 * The record is a file Stroq wrote (and checks strictly when it reads it back), but the values in it came
 * from the owner's file, so each is made safe to print on one line, cut to a length that fits one, and
 * a long list is shown in part and counted. Nothing here reads a file: it is a function of the entries.
 */

/** How many values of one list are shown; the rest are counted. */
const MAX_SHOWN = 30;
/** How many already-there values are named in a sentence. */
const MAX_NAMED = 5;
const MAX_VALUE_CHARS = 120;

const plural = (count: number, one: string, many: string): string => (count === 1 ? one : many);

function shown(value: JsonValue): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const cut = text.length > MAX_VALUE_CHARS ? `${text.slice(0, MAX_VALUE_CHARS)}...` : text;
  return outsideLine(cut);
}

const bullets = (values: readonly string[]): string[] => [
  ...values.slice(0, MAX_SHOWN).map((value) => `    - ${value}`),
  ...(values.length > MAX_SHOWN ? [`    - ... and ${values.length - MAX_SHOWN} more`] : []),
];

type ArrayAdd = Extract<RecordedJsonEdit, { kind: 'json-array-add' }>;

/** The array edits of one entry, grouped by the list they went to, in the order they were made. */
function groupedByPath(edits: readonly ArrayAdd[]): readonly (readonly [string, ArrayAdd[]])[] {
  // Built by pushing into the group of its list: copying a group for each edit would be quadratic in
  // the number of edits, and a record can hold thousands.
  const groups = new Map<string, ArrayAdd[]>();
  for (const edit of edits) {
    const key = edit.path.join('.');
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [edit]);
    else group.push(edit);
  }
  return [...groups];
}

function arrayLines(path: string, edits: readonly ArrayAdd[]): string[] {
  const added = edits.filter((edit) => !edit.preexisting).map((edit) => shown(edit.value));
  const theirs = edits.filter((edit) => edit.preexisting).map((edit) => shown(edit.value));
  const where = outsideLine(path);
  const named = theirs.slice(0, MAX_NAMED).join(', ');
  const more = theirs.length > MAX_NAMED ? ` and ${theirs.length - MAX_NAMED} more` : '';
  return [
    ...(added.length === 0
      ? []
      : [
          `  Added ${added.length} ${plural(added.length, 'rule', 'rules')} to ${where}:`,
          ...bullets(added),
        ]),
    ...(theirs.length === 0
      ? []
      : [
          `  ${theirs.length} ${plural(theirs.length, 'rule was', 'rules were')} already there and ${plural(theirs.length, 'is', 'are')} not touched: ${named}${more}`,
        ]),
  ];
}

function setLine(edit: Extract<RecordedJsonEdit, { kind: 'json-set' }>): string {
  const was = edit.previous.present ? 'it held another value' : 'it was not there';
  return `  Set ${outsideLine(edit.path.join('.'))} (${was}).`;
}

function blockLines(edit: RecordedTextBlockEdit): string[] {
  const verb = edit.previous === null ? 'Added' : 'Replaced the lines of';
  const count = edit.lines.length;
  return [
    `  ${verb} a block of ${count} ${plural(count, 'line', 'lines')}, between two marker lines:`,
    ...bullets(edit.lines.map(outsideLine)),
  ];
}

function editLines(edits: readonly RecordedEdit[]): string[] {
  const arrays = edits.filter((edit): edit is ArrayAdd => edit.kind === 'json-array-add');
  return [
    ...groupedByPath(arrays).flatMap(([path, group]) => arrayLines(path, group)),
    ...edits.flatMap((edit) => (edit.kind === 'json-set' ? [setLine(edit)] : [])),
    ...edits.flatMap((edit) => (edit.kind === 'text-block' ? blockLines(edit) : [])),
  ];
}

function entryLines(entry: ManifestEntry): string[] {
  const how = entry.created ? '; it made the file.' : '.';
  return [
    `  Applied ${outsideLine(entry.appliedAt)} by ${outsideLine(entry.recipe)}${how}`,
    ...editLines(entry.edits),
  ];
}

/** The record of `entries` (oldest first) as lines. */
export function recordLines(entries: readonly ManifestEntry[]): string[] {
  const count = entries.length;
  return [
    `Stroq recorded ${count} ${plural(count, 'change', 'changes')} to it.`,
    ...entries.flatMap(entryLines),
  ];
}
