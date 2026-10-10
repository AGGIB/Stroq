import { resolveRealPath } from './atomic.js';
import { planBackup } from './backup.js';
import { DIFF_HIDDEN_NOTICE, maskedDiff } from './diff-mask.js';
import { pathRefusal } from './plan-support.js';
import {
  HardenError,
  ID_PATTERN,
  type PlanOptions,
  type PlanRefusal,
  type RecordedTextBlockEdit,
  type TextBlockPlan,
} from './types.js';

/**
 * Editing a line-oriented file (an ignore file) by owning a stretch of it: a block between two
 * marker lines that carry an id. The block is appended when it is not there and replaced where it
 * stands when it is, and nothing outside the markers is ever read as ours, so what the owner wrote
 * above and below it stays exactly as they wrote it.
 *
 * When a block is appended the engine writes up to three things around it, and records each of
 * them as the exact bytes it wrote: the line break that ends the owner's last line if it had none,
 * a blank line to set the block off unless one was there, and a line break after the end marker.
 * Undo takes away those bytes and no others.
 */

const DEFAULT_RECIPE = 'custom';
const REPLACEMENT_CHARACTER = '\u{FFFD}';
const BEGIN_PREFIX = '# >>> stroq harden:';
const END_PREFIX = '# <<< stroq harden:';

/** The two lines that bound the block called `id`. */
export function blockMarkers(id: string): { readonly begin: string; readonly end: string } {
  return { begin: `${BEGIN_PREFIX} ${id} >>>`, end: `${END_PREFIX} ${id} <<<` };
}

const invalid = (message: string): HardenError => new HardenError('invalid-edit', message);

function validateBlock(block: { readonly id: string; readonly lines: readonly string[] }): void {
  if (typeof block.id !== 'string' || !ID_PATTERN.test(block.id)) {
    throw invalid('a block id is letters, digits, dots, hyphens and underscores, 64 at most');
  }
  for (const line of block.lines) {
    if (typeof line !== 'string' || /[\r\n]/.test(line)) {
      throw invalid('every line of a block has to be a string without a line break in it');
    }
    // A line that looks like a marker would end, or start, a block that is not ours.
    if (line.startsWith(BEGIN_PREFIX) || line.startsWith(END_PREFIX)) {
      throw invalid('a line of a block cannot be a Stroq marker');
    }
  }
}

interface Row {
  /** Where the line starts, where its text ends (before the line break), where the next starts. */
  readonly start: number;
  readonly end: number;
  readonly next: number;
  readonly content: string;
}

/** The lines of `text`, each with its place in it. A line break is `\n` or `\r\n`. */
function rowsOf(text: string): Row[] {
  const out: Row[] = [];
  for (let start = 0; start < text.length;) {
    const newline = text.indexOf('\n', start);
    const next = newline === -1 ? text.length : newline + 1;
    let end = newline === -1 ? text.length : newline;
    if (newline !== -1 && end > start && text[end - 1] === '\r') end -= 1;
    out.push({ start, end, next, content: text.slice(start, end) });
    start = next;
  }
  return out;
}

type Found =
  | { readonly kind: 'none' }
  | { readonly kind: 'damaged'; readonly detail: string }
  | { readonly kind: 'found'; readonly begin: Row; readonly end: Row; readonly body: string[] };

/**
 * The block called `id` in `text`. A marker line is one that equals the marker once its trailing
 * white space is gone, which editors add and remove. A block that is not a clean pair is
 * `damaged`: removing or replacing it would be a guess about what the owner meant.
 */
function findBlock(text: string, id: string): Found {
  const { begin, end } = blockMarkers(id);
  const rows = rowsOf(text);
  const begins = rows.flatMap((row, i) => (row.content.trimEnd() === begin ? [i] : []));
  const first = begins[0];
  if (first === undefined) return { kind: 'none' };
  if (begins.length > 1) {
    return { kind: 'damaged', detail: `the block ${id} appears more than once in the file` };
  }
  const last = rows.findIndex((row, i) => i > first && row.content.trimEnd() === end);
  const beginRow = rows[first];
  const endRow = rows[last];
  if (beginRow === undefined || endRow === undefined) {
    return {
      kind: 'damaged',
      detail: `the block ${id} has a begin marker but no end marker after it`,
    };
  }
  return {
    kind: 'found',
    begin: beginRow,
    end: endRow,
    body: rows.slice(first + 1, last).map((row) => row.content),
  };
}

/** The line break the file uses: that of its first line. */
function lineBreakOf(text: string): '\n' | '\r\n' {
  const newline = text.indexOf('\n');
  return newline > 0 && text[newline - 1] === '\r' ? '\r\n' : '\n';
}

/** Whether the last line of `terminated` (a text ending in a line break) is empty or only blank. */
function endsWithBlankLine(terminated: string): boolean {
  let i = terminated.length - 2;
  if (terminated[i] === '\r') i -= 1;
  while (i >= 0 && (terminated[i] === ' ' || terminated[i] === '\t')) i -= 1;
  return i < 0 || terminated[i] === '\n';
}

/**
 * What goes between the file as it is and a block appended to it: the line break that ends a last
 * line which had none, and one blank line to set the block off, unless one is there already.
 * The two are kept apart because undo treats them differently.
 */
function separatorFor(
  text: string,
  eol: string,
): { readonly lineEnd: string; readonly gap: string } {
  if (text === '') return { lineEnd: '', gap: '' };
  const unterminated = !text.endsWith('\n');
  const terminated = unterminated ? `${text}${eol}` : text;
  return {
    lineEnd: unterminated ? eol : '',
    gap: endsWithBlankLine(terminated) ? '' : eol,
  };
}

const sameLines = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((line, i) => line === b[i]);

function blockText(id: string, lines: readonly string[], eol: string): string {
  const { begin, end } = blockMarkers(id);
  return [begin, ...lines, end].join(eol);
}

interface Frame {
  readonly file: string;
  readonly real: string;
  /** The file's text, or `null` when there is no file (or it was never opened). */
  readonly text: string | null;
  readonly options: Pick<PlanOptions, 'recipe' | 'root' | 'newFileMode'>;
}

function buildPlan(
  frame: Frame,
  after: string,
  edits: readonly RecordedTextBlockEdit[],
  refusal?: { readonly refused: PlanRefusal; readonly detail: string },
): TextBlockPlan {
  const { file, real, text, options } = frame;
  const before = text ?? '';
  const changed = after !== before;
  // The diff first: a file too large to show is refused before it is read for credentials.
  const shown = changed ? maskedDiff(text, after, file) : { diff: '', hidden: false };
  const backup = planBackup(text);
  return {
    kind: 'text-block',
    recipe: options.recipe ?? DEFAULT_RECIPE,
    file,
    real,
    existed: text !== null,
    before,
    after,
    diff: shown.diff,
    changed,
    ...(refusal === undefined ? {} : { refused: refusal.refused, refusedDetail: refusal.detail }),
    backup: backup.backup,
    notices: [...backup.notices, ...(shown.hidden ? [DIFF_HIDDEN_NOTICE] : [])],
    edits,
    ...(options.root === undefined ? {} : { root: options.root }),
    ...(options.newFileMode === undefined ? {} : { newFileMode: options.newFileMode }),
  };
}

/**
 * What the block `block` makes of the text in `frame`, with nothing read and nothing written: the
 * part of planning that is a function of the text. `planTextBlock` is this after the path has been
 * judged and the file read, and `replayTextBlockPlan` is this on a plan's own text.
 */
function planBlockText(
  frame: Frame,
  block: { readonly id: string; readonly lines: readonly string[] },
): TextBlockPlan {
  validateBlock(block);
  const text = frame.text ?? '';
  const unchanged = (refused: PlanRefusal, detail: string): TextBlockPlan =>
    buildPlan(frame, text, [], { refused, detail });

  if (text.includes(REPLACEMENT_CHARACTER)) {
    return unchanged(
      'not-utf8',
      'the file is not valid UTF-8, so it cannot be rewritten as it was',
    );
  }
  const lines = [...block.lines];
  const eol = lineBreakOf(text);
  const found = findBlock(text, block.id);
  if (found.kind === 'damaged') return unchanged('markers-damaged', found.detail);

  if (found.kind === 'found') {
    const edit: RecordedTextBlockEdit = {
      kind: 'text-block',
      id: block.id,
      lines,
      previous: found.body,
      prefix: '',
      closesLastLine: false,
      suffix: '',
    };
    if (sameLines(found.body, lines)) return buildPlan(frame, text, [edit]);
    // The block keeps the line break after its end marker, or the lack of one at the end of the file.
    const tail = found.end.next > found.end.end ? eol : '';
    const replaced = blockText(block.id, lines, eol) + tail;
    return buildPlan(
      frame,
      text.slice(0, found.begin.start) + replaced + text.slice(found.end.next),
      [edit],
    );
  }

  const { lineEnd, gap } = separatorFor(text, eol);
  const edit: RecordedTextBlockEdit = {
    kind: 'text-block',
    id: block.id,
    lines,
    previous: null,
    prefix: `${lineEnd}${gap}`,
    closesLastLine: lineEnd !== '',
    suffix: eol,
  };
  return buildPlan(frame, `${text}${edit.prefix}${blockText(block.id, lines, eol)}${edit.suffix}`, [
    edit,
  ]);
}

/**
 * What would change in `file` if the block `id` held `lines`. It reads the file (through
 * `options.read`, with the real path) and writes nothing.
 *
 * The path is judged before the file is read, by the rules the write will apply (the root the
 * caller named, `init`'s rule, a link that points nowhere). A path that fails gives a plan that is
 * `refused` (`path-escapes-root` or `dangling-link`) and `read` is never called, so that no diff
 * can carry the content of a file the path only leads to. Such a plan has `existed: false` and no
 * text: it never looked.
 *
 * A block with that id is replaced in place; otherwise one is appended, a blank line after the
 * rest. If the markers are not a clean pair the plan is `refused`.
 */
export function planTextBlock(
  file: string,
  block: { readonly id: string; readonly lines: readonly string[] },
  options: PlanOptions,
): TextBlockPlan {
  validateBlock(block);
  const real = resolveRealPath(file);
  const refusal = pathRefusal(file, options.root);
  const frame: Frame = {
    file,
    real,
    text: refusal === null ? options.read(real) : null,
    options,
  };
  if (refusal !== null) return buildPlan(frame, '', [], refusal);
  return planBlockText(frame, block);
}

/**
 * The plan that `plan`'s own edit makes of `plan`'s own text, by the same code that made it, and
 * without touching the file system; `null` when the plan does not hold exactly one edit, which no
 * planner makes.
 */
export function replayTextBlockPlan(plan: TextBlockPlan): TextBlockPlan | null {
  const [edit, ...rest] = plan.edits;
  if (edit === undefined || rest.length > 0) return null;
  const frame: Frame = {
    file: plan.file,
    real: plan.real,
    text: plan.existed ? plan.before : null,
    options: {
      ...(plan.recipe === undefined ? {} : { recipe: plan.recipe }),
      ...(plan.root === undefined ? {} : { root: plan.root }),
      ...(plan.newFileMode === undefined ? {} : { newFileMode: plan.newFileMode }),
    },
  };
  return planBlockText(frame, { id: edit.id, lines: edit.lines });
}

export type TextUndo =
  | {
      readonly outcome: 'edited';
      /** The text with the block out. Exactly the text given when there was nothing to take out. */
      readonly text: string;
      readonly kept: readonly string[];
      /** Nothing but white space is left. */
      readonly empty: boolean;
    }
  | { readonly outcome: 'blocked'; readonly refused: PlanRefusal; readonly detail: string };

const isBlank = (text: string): boolean => /^\s*$/.test(text);

/** The line break `prefix` begins with: the one that ended the owner's last line, when it did. */
const leadingBreak = (prefix: string): string =>
  prefix.startsWith('\r\n') ? '\r\n' : prefix.startsWith('\n') ? '\n' : '';

/**
 * The text before the block, with the bytes Stroq wrote in front of it taken away, or `null` when
 * they are not there to take.
 *
 * What was written is `edit.prefix`. It is taken only if it is exactly what is in front of the
 * block, and only if what is left in front of it is what the owner's file ended with when Stroq
 * wrote it: a file that ended in a line break still ends in one, a file that did not still does
 * not. If the owner has changed that, the bytes are no longer provably Stroq's, and none of them
 * is taken.
 */
function withoutPrefix(head: string, edit: RecordedTextBlockEdit): string | null {
  if (edit.prefix === '' || !head.endsWith(edit.prefix)) return null;
  const owners = head.slice(0, head.length - edit.prefix.length);
  const endsInBreak = owners.endsWith('\n');
  const asWritten = edit.closesLastLine
    ? owners !== '' && !endsInBreak
    : owners === '' || endsInBreak;
  return asWritten ? owners : null;
}

/**
 * The text with an appended block taken out, and exactly the bytes Stroq wrote around it with it:
 *
 * - the blank line in front of the block always goes;
 * - the line break that ended the owner's last line (when the file had none) goes only if nothing
 *   follows the block. If the owner has written something after it, that line break is what keeps
 *   the owner's last line and the owner's new text apart, and it stays: it is no longer only
 *   Stroq's;
 * - the line break after the end marker goes with the block's last line.
 */
function withoutAppended(text: string, begin: Row, end: Row, edit: RecordedTextBlockEdit): string {
  const head = text.slice(0, begin.start);
  const tail = text.slice(end.next);
  const owners = withoutPrefix(head, edit);
  if (owners === null) return head + tail;
  const lineEnd = edit.closesLastLine ? leadingBreak(edit.prefix) : '';
  return owners + (tail === '' ? '' : lineEnd) + tail;
}

/**
 * Takes the block Stroq wrote out of `text`, whatever the owner has done to the rest of the file
 * since. A block whose lines the owner edited is no longer Stroq's and is left, and said so.
 * Markers that are no longer a clean pair leave the file `blocked`, untouched.
 */
export function undoTextBlock(text: string, edit: RecordedTextBlockEdit): TextUndo {
  const found = findBlock(text, edit.id);
  if (found.kind === 'damaged') {
    return { outcome: 'blocked', refused: 'markers-damaged', detail: found.detail };
  }
  if (found.kind === 'none') return { outcome: 'edited', text, kept: [], empty: isBlank(text) };
  if (!sameLines(found.body, edit.lines)) {
    const kept = `${edit.id}: the block was edited since Stroq wrote it, so it was left as it is`;
    return { outcome: 'edited', text, kept: [kept], empty: isBlank(text) };
  }

  const eol = lineBreakOf(text);
  if (edit.previous !== null) {
    const restored =
      blockText(edit.id, edit.previous, eol) + (found.end.next > found.end.end ? eol : '');
    const out = text.slice(0, found.begin.start) + restored + text.slice(found.end.next);
    return { outcome: 'edited', text: out, kept: [], empty: isBlank(out) };
  }
  const out = withoutAppended(text, found.begin, found.end, edit);
  return { outcome: 'edited', text: out, kept: [], empty: isBlank(out) };
}
