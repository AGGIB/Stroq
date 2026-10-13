import { resolveRealPath } from './atomic.js';
import { findCredentialShape, planBackup } from './backup.js';
import { DIFF_HIDDEN_NOTICE, LINK_PREVIEW_NOTICE, maskedDiff } from './diff-mask.js';
import {
  DEFAULT_LAYOUT,
  deepEqual,
  dotted,
  isArray,
  isObject,
  parseJsonDocument,
  serializeJson,
  setAt,
  type Parsed,
} from './json-doc.js';
import { linkNotices, pathRefusal } from './plan-support.js';
import {
  HardenError,
  type JsonEdit,
  type JsonObject,
  type JsonPlan,
  type JsonValue,
  type PlanOptions,
  type PlanRefusal,
  type PreviousValue,
  type RecordedEdit,
  type RecordedJsonEdit,
} from './types.js';

/**
 * Planning an edit to a JSON config the way a careful person would make it: parse the file,
 * change what has to change, write it back in the layout it had, and show the difference first.
 * Nothing is written here. A file the engine will not rewrite (comments, a trailing comma, a
 * value of the wrong type where an edit has to go) gives a plan that is `refused`; applying that
 * is an error, and the file is untouched.
 *
 * The parts live next to this file: `json-doc.ts` reads and lays out a document, `json-undo.ts`
 * takes an edit back out.
 */

export { deepEqual, findJsoncSyntax } from './json-doc.js';
export { undoJsonEdits, type JsonUndo } from './json-undo.js';

const DEFAULT_RECIPE = 'custom';
/** Deeper than any value a recipe has a reason to write. */
const MAX_VALUE_DEPTH = 64;

/** Stands in the record for a replaced value that was not kept because it looked like a credential. */
export const MASKED_PREVIOUS_VALUE = '[credential-shaped value not kept]';
/** Said before the owner agrees to an edit that replaces such a value. */
export const REPLACED_CREDENTIAL_NOTICE =
  'a value that looks like a credential will be replaced, and no copy of it is kept';

const invalid = (message: string): HardenError => new HardenError('invalid-edit', message);

/**
 * Whether any of `edits` replaces a value that was not kept because it looks like a credential:
 * a change that no undo can take back.
 */
export const replacesCredential = (edits: readonly RecordedEdit[]): boolean =>
  edits.some(
    (edit) => edit.kind === 'json-set' && edit.previous.present && edit.previous.masked === true,
  );

/** A copy of `value` that is certainly JSON, or the typed error a recipe's mistake deserves. */
function cloneJson(value: unknown, depth = 0): JsonValue {
  if (depth > MAX_VALUE_DEPTH) throw invalid('an edit value is nested too deeply');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalid('an edit value holds a number that is not finite');
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => cloneJson(item, depth + 1));
  if (typeof value === 'object') {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw invalid('an edit value holds an object that is not plain JSON');
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneJson(item, depth + 1)]),
    );
  }
  throw invalid(`an edit value holds a ${typeof value}, which is not JSON`);
}

function validateEdit(edit: JsonEdit): JsonEdit {
  const kind: string = edit.kind;
  if (kind !== 'json-array-add' && kind !== 'json-set') throw invalid(`unknown edit kind ${kind}`);
  const { path } = edit;
  if (!Array.isArray(path) || path.length === 0) throw invalid('an edit needs a path');
  if (path.some((part) => typeof part !== 'string' || part === '')) {
    throw invalid('every part of an edit path has to be a non-empty string');
  }
  return { kind: edit.kind, path: [...path], value: cloneJson(edit.value) };
}

type Probe =
  | { readonly ok: true; readonly createdFrom: number; readonly leaf: JsonValue | undefined }
  | { readonly ok: false; readonly conflict: string };

/**
 * Walks `path` through `doc` without changing it: where the first key that is not there is
 * (`createdFrom`), the value at the end if there is one, or the place where the way runs
 * through something that is not an object.
 */
function probe(doc: JsonObject, path: readonly string[]): Probe {
  let node: JsonValue = doc;
  for (const [i, key] of path.entries()) {
    if (!isObject(node)) {
      return { ok: false, conflict: `${dotted(path.slice(0, i))} is not an object` };
    }
    if (!Object.hasOwn(node, key)) return { ok: true, createdFrom: i, leaf: undefined };
    node = node[key] as JsonValue;
  }
  return { ok: true, createdFrom: path.length, leaf: node };
}

type Applied =
  | {
      readonly ok: true;
      readonly doc: JsonObject;
      readonly changed: boolean;
      readonly record: RecordedJsonEdit | null;
    }
  | { readonly ok: false; readonly conflict: string };

function applyArrayAdd(doc: JsonObject, edit: JsonEdit): Applied {
  const found = probe(doc, edit.path);
  if (!found.ok) return found;
  if (found.leaf !== undefined && !isArray(found.leaf)) {
    return { ok: false, conflict: `${dotted(edit.path)} is not an array` };
  }
  const existing = found.leaf ?? [];
  const base = { kind: 'json-array-add', path: edit.path, value: edit.value } as const;
  if (existing.some((element) => deepEqual(element, edit.value))) {
    const record = { ...base, preexisting: true, createdFrom: edit.path.length };
    return { ok: true, doc, changed: false, record };
  }
  const record = { ...base, preexisting: false, createdFrom: found.createdFrom };
  return { ok: true, doc: setAt(doc, edit.path, [...existing, edit.value]), changed: true, record };
}

/**
 * Whether `value`, found under the last key of a path, is credential-shaped: asked the way the
 * rest of the engine asks about a file, with the key as the name above the value. A value too
 * deep to be looked at is not clean.
 */
function holdsCredential(name: string, value: JsonValue): boolean {
  try {
    return findCredentialShape(JSON.stringify({ [name]: value })) !== null;
  } catch {
    return true;
  }
}

/** What to record of the value a set found: the value, unless it must not be written down. */
function previousOf(path: readonly string[], leaf: JsonValue | undefined): PreviousValue {
  if (leaf === undefined) return { present: false };
  const name = path[path.length - 1] ?? '';
  return holdsCredential(name, leaf)
    ? { present: true, value: MASKED_PREVIOUS_VALUE, masked: true }
    : { present: true, value: leaf };
}

function applySet(doc: JsonObject, edit: JsonEdit): Applied {
  const found = probe(doc, edit.path);
  if (!found.ok) return found;
  if (found.leaf !== undefined && deepEqual(found.leaf, edit.value)) {
    // No undo needs this value. Recording it could persist an existing credential as edit.value.
    return { ok: true, doc, changed: false, record: null };
  }
  const previous = previousOf(edit.path, found.leaf);
  const base = { kind: 'json-set', path: edit.path, value: edit.value, previous } as const;
  const record = { ...base, createdFrom: found.createdFrom };
  return { ok: true, doc: setAt(doc, edit.path, edit.value), changed: true, record };
}

const applyEdit = (doc: JsonObject, edit: JsonEdit): Applied =>
  edit.kind === 'json-array-add' ? applyArrayAdd(doc, edit) : applySet(doc, edit);

interface Frame {
  readonly file: string;
  readonly real: string;
  /** The file's text, or `null` when there is no file (or it was never opened). */
  readonly text: string | null;
  readonly options: Pick<PlanOptions, 'recipe' | 'root' | 'newFileMode'>;
  /** What the owner is told because of where the path leads: only a planner, who looked, knows. */
  readonly notices: readonly string[];
  readonly previewWithheld: boolean;
}

interface Outcome {
  readonly after: string;
  readonly edits: readonly RecordedJsonEdit[];
  readonly roundTrips: boolean;
  readonly refusal?: { readonly refused: PlanRefusal; readonly detail: string };
}

function buildPlan(frame: Frame, outcome: Outcome): JsonPlan {
  const { file, real, text, options } = frame;
  const before = text ?? '';
  const changed = outcome.after !== before;
  // The diff first: it refuses a file that is too large to show, and that must cost nothing more
  // than counting its lines. Reading it for credentials is the dearest part of a plan. It is
  // labelled with the file the change lands in: when the path is a link, that is not the path.
  const shown = changed
    ? maskedDiff(text, outcome.after, real, frame.previewWithheld)
    : { diff: '', hidden: false };
  const backup = planBackup(text);
  return {
    kind: 'json',
    recipe: options.recipe ?? DEFAULT_RECIPE,
    file,
    real,
    existed: text !== null,
    before,
    after: outcome.after,
    diff: shown.diff,
    ...(frame.previewWithheld ? { previewWithheld: true as const } : {}),
    changed,
    ...(outcome.refusal === undefined
      ? {}
      : { refused: outcome.refusal.refused, refusedDetail: outcome.refusal.detail }),
    backup: backup.backup,
    notices: [
      ...frame.notices,
      ...(frame.previewWithheld ? [LINK_PREVIEW_NOTICE] : []),
      ...backup.notices,
      ...(shown.hidden ? [DIFF_HIDDEN_NOTICE] : []),
      ...(replacesCredential(outcome.edits) ? [REPLACED_CREDENTIAL_NOTICE] : []),
    ],
    edits: outcome.edits,
    roundTrips: outcome.roundTrips,
    formatting: outcome.roundTrips || outcome.refusal !== undefined ? 'preserved' : 'will-change',
    ...(options.root === undefined ? {} : { root: options.root }),
    ...(options.newFileMode === undefined ? {} : { newFileMode: options.newFileMode }),
  };
}

const refusedPlan = (frame: Frame, refused: PlanRefusal, detail: string): JsonPlan =>
  buildPlan(frame, {
    after: frame.text ?? '',
    edits: [],
    roundTrips: false,
    refusal: { refused, detail },
  });

/**
 * What `edits` make of the text in `frame`, with nothing read and nothing written: the part of
 * planning that is a function of the text. `planJsonEdits` is this after the path has been judged
 * and the file read, and `replayJsonPlan` is this on a plan's own text.
 */
function planJsonText(frame: Frame, requested: readonly JsonEdit[]): JsonPlan {
  const parsed: Parsed =
    frame.text === null
      ? { ok: true, doc: {}, layout: DEFAULT_LAYOUT, roundTrips: true }
      : parseJsonDocument(frame.text);
  if (!parsed.ok) return refusedPlan(frame, parsed.refused, parsed.detail);

  let doc = parsed.doc;
  let changed = false;
  const recorded: RecordedJsonEdit[] = [];
  for (const edit of requested) {
    const applied = applyEdit(doc, edit);
    if (!applied.ok) return refusedPlan(frame, 'type-conflict', applied.conflict);
    doc = applied.doc;
    changed ||= applied.changed;
    if (applied.record !== null) recorded.push(applied.record);
  }

  // Nothing to change is nothing to write: the file is not even laid out again.
  if (!changed) {
    return buildPlan(frame, {
      after: frame.text ?? '',
      edits: recorded,
      roundTrips: parsed.roundTrips,
    });
  }
  let after: string;
  try {
    after = serializeJson(doc, parsed.layout);
  } catch {
    return refusedPlan(frame, 'invalid-json', 'the file is nested too deeply to rewrite');
  }
  // Outside the `try`: a file too large to show a diff of is a typed error, and not a file that
  // is "nested too deeply".
  return buildPlan(frame, { after, edits: recorded, roundTrips: parsed.roundTrips });
}

/**
 * What would change in `file` if `edits` were made. It reads the file (through `options.read`,
 * with the real path) and writes nothing.
 *
 * The path is judged before the file is read, by the rules the write will apply (the root the
 * caller named, `init`'s rule, a link that points nowhere). A path that fails gives a plan that
 * is `refused` (`path-escapes-root` or `dangling-link`) and `read` is never called, so that no
 * diff can carry the content of a file the path only leads to. Such a plan has `existed: false`
 * and no text: it never looked.
 *
 * The plan carries the text before and after, the diff, the real path and every edit as it was
 * made: whether an array element was there already (`preexisting`), what a set value replaced
 * (`previous`). If the file cannot be edited safely the plan is `refused`, with `after` equal to
 * `before`, and applying it is an error. If it can be edited only by laying it out again, the
 * plan says `formatting: 'will-change'`.
 */
export function planJsonEdits(
  file: string,
  edits: readonly JsonEdit[],
  options: PlanOptions,
): JsonPlan {
  const requested = edits.map(validateEdit);
  const real = resolveRealPath(file);
  const refusal = pathRefusal(file, options.root);
  const notices = refusal === null ? linkNotices(file, real, options.root) : [];
  const frame: Frame = {
    file,
    real,
    text: refusal === null ? options.read(real) : null,
    options,
    notices,
    previewWithheld: notices.length > 0 && options.acknowledgeLink !== true,
  };
  if (refusal !== null) return refusedPlan(frame, refusal.refused, refusal.detail);
  return planJsonText(frame, requested);
}

/**
 * The plan that `plan`'s own edits make of `plan`'s own text, by the same code that made it, and
 * without touching the file system. A plan is plain data and can be anything; this is what a plan
 * made from that text and those edits actually says.
 */
export function replayJsonPlan(plan: JsonPlan): JsonPlan {
  const requested = plan.edits.map((edit) =>
    validateEdit({ kind: edit.kind, path: edit.path, value: edit.value }),
  );
  const frame: Frame = {
    file: plan.file,
    real: plan.real,
    text: plan.existed ? plan.before : null,
    options: {
      ...(plan.recipe === undefined ? {} : { recipe: plan.recipe }),
      ...(plan.root === undefined ? {} : { root: plan.root }),
      ...(plan.newFileMode === undefined ? {} : { newFileMode: plan.newFileMode }),
    },
    notices: [],
    previewWithheld: plan.previewWithheld === true,
  };
  return planJsonText(frame, requested);
}
