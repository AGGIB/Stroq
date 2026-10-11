import {
  deepEqual,
  dotted,
  getAt,
  isArray,
  isEmptyContainer,
  parseJsonDocument,
  removeAt,
  serializeJson,
  setAt,
} from './json-doc.js';
import type { JsonObject, JsonValue, PlanRefusal, RecordedJsonEdit } from './types.js';

/**
 * Undo, the surgical way: take out what Stroq put in and nothing else. It is what runs when the
 * owner has changed the file since Stroq did (so that a copy of the old bytes would erase their
 * work), and when no copy was kept because the file held credential-shaped text.
 */

export type JsonUndo =
  | {
      readonly outcome: 'edited';
      /** The text with Stroq's entries out. Exactly the text given when there was nothing to take out. */
      readonly text: string;
      /** Entries that were left because they are no longer what Stroq wrote. */
      readonly kept: readonly string[];
      /** The file had to be laid out again, because it could not be written back as it was. */
      readonly reformatted: boolean;
      /** Nothing is left in the document. */
      readonly empty: boolean;
    }
  | { readonly outcome: 'blocked'; readonly refused: PlanRefusal; readonly detail: string };

/**
 * Removes the keys Stroq made, from the deepest one up, for as long as they are empty. Stops at
 * the first one that is not: the owner put something there.
 */
function pruneMade(doc: JsonObject, path: readonly string[], createdFrom: number): JsonObject {
  let current = doc;
  for (let depth = path.length - 1; depth >= createdFrom; depth -= 1) {
    const here = getAt(current, path.slice(0, depth + 1));
    if (here === undefined) continue;
    if (!isEmptyContainer(here)) break;
    current = removeAt(current, path.slice(0, depth + 1));
  }
  return current;
}

interface Undone {
  readonly doc: JsonObject;
  readonly changed: boolean;
  readonly kept?: string;
}

function undoArrayAdd(doc: JsonObject, edit: RecordedJsonEdit): Undone {
  const current = getAt(doc, edit.path);
  if (edit.kind !== 'json-array-add' || edit.preexisting || !isArray(current)) {
    return { doc, changed: false };
  }
  // The last equal element: Stroq appended its own, and the owner's come before it or after.
  let index = current.length - 1;
  while (index >= 0 && !deepEqual(current[index] as JsonValue, edit.value)) index -= 1;
  if (index === -1) return { doc, changed: false };
  const without = setAt(
    doc,
    edit.path,
    current.filter((_, i) => i !== index),
  );
  return { doc: pruneMade(without, edit.path, edit.createdFrom), changed: true };
}

function undoSet(doc: JsonObject, edit: RecordedJsonEdit): Undone {
  if (edit.kind !== 'json-set') return { doc, changed: false };
  const current = getAt(doc, edit.path);
  if (current === undefined) return { doc, changed: false };
  if (!deepEqual(current, edit.value)) {
    const kept = `${dotted(edit.path)}: it is not the value Stroq set any more, so it was left as it is`;
    return { doc, changed: false, kept };
  }
  if (edit.previous.present) {
    // The value was credential-shaped and was not written down: there is nothing to put back, and
    // the placeholder in the record must never become the file's value.
    if (edit.previous.masked === true) {
      const kept = `${dotted(edit.path)}: Stroq replaced a value that looked like a credential and kept no copy of it, so it cannot be put back; the value Stroq set was left as it is`;
      return { doc, changed: false, kept };
    }
    return deepEqual(current, edit.previous.value)
      ? { doc, changed: false }
      : { doc: setAt(doc, edit.path, edit.previous.value), changed: true };
  }
  return { doc: pruneMade(removeAt(doc, edit.path), edit.path, edit.createdFrom), changed: true };
}

/**
 * Takes Stroq's edits out of `text`, which may have been changed by its owner since, and keeps
 * everything else: an element is removed only if it is still equal to what was added (and was
 * not there before), a set value is put back only if it is still the one Stroq set. The edits are
 * undone newest first, so that a path two of them made together is taken apart whole.
 *
 * The file is laid out as it is now. When there is nothing to take out the text is returned
 * exactly as it was given. A file that has become something Stroq will not rewrite (a comment
 * added, a syntax error) is `blocked`, untouched.
 */
export function undoJsonEdits(text: string, edits: readonly RecordedJsonEdit[]): JsonUndo {
  const parsed = parseJsonDocument(text);
  if (!parsed.ok) return { outcome: 'blocked', refused: parsed.refused, detail: parsed.detail };

  let doc = parsed.doc;
  let changed = false;
  const kept: string[] = [];
  for (const edit of [...edits].reverse()) {
    const step = edit.kind === 'json-array-add' ? undoArrayAdd(doc, edit) : undoSet(doc, edit);
    doc = step.doc;
    changed ||= step.changed;
    if (step.kept !== undefined) kept.unshift(step.kept);
  }
  const empty = Object.keys(doc).length === 0;
  if (!changed) return { outcome: 'edited', text, kept, reformatted: false, empty };
  try {
    return {
      outcome: 'edited',
      text: serializeJson(doc, parsed.layout),
      kept,
      reformatted: !parsed.roundTrips,
      empty,
    };
  } catch {
    return {
      outcome: 'blocked',
      refused: 'invalid-json',
      detail: 'the file is nested too deeply to rewrite',
    };
  }
}
