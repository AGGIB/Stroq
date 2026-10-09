import { resolveRealPath } from './atomic.js';
import { planBackup } from './backup.js';
import { unifiedDiff } from './diff.js';
import {
  HardenError,
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
 */

const DEFAULT_RECIPE = 'custom';
const REPLACEMENT_CHARACTER = '\u{FFFD}';
/** What a block id may be: a plain name, so that it cannot end its own marker line early. */
export const BLOCK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const BEGIN_PREFIX = '# >>> stroq harden:';
const END_PREFIX = '# <<< stroq harden:';

/** The two lines that bound the block called `id`. */
export function blockMarkers(id: string): { readonly begin: string; readonly end: string } {
  return { begin: `${BEGIN_PREFIX} ${id} >>>`, end: `${END_PREFIX} ${id} <<<` };
}

const invalid = (message: string): HardenError => new HardenError('invalid-edit', message);

function validateBlock(block: { readonly id: string; readonly lines: readonly string[] }): void {
  if (typeof block.id !== 'string' || !BLOCK_ID_PATTERN.test(block.id)) {
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
 */
function separatorFor(text: string, eol: string): string {
  if (text === '') return '';
  const unterminated = !text.endsWith('\n');
  const terminated = unterminated ? `${text}${eol}` : text;
  return `${unterminated ? eol : ''}${endsWithBlankLine(terminated) ? '' : eol}`;
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
  readonly text: string | null;
  readonly options: PlanOptions;
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
  const backup = planBackup(text);
  return {
    kind: 'text-block',
    recipe: options.recipe ?? DEFAULT_RECIPE,
    file,
    real,
    existed: text !== null,
    before,
    after,
    diff: changed
      ? unifiedDiff(before, after, { path: file, ...(text === null ? { oldMissing: true } : {}) })
      : '',
    changed,
    ...(refusal === undefined ? {} : { refused: refusal.refused, refusedDetail: refusal.detail }),
    backup: backup.backup,
    notices: backup.notices,
    edits,
    ...(options.root === undefined ? {} : { root: options.root }),
    ...(options.newFileMode === undefined ? {} : { newFileMode: options.newFileMode }),
  };
}

/**
 * What would change in `file` if the block `id` held `lines`. It reads the file (through
 * `options.read`, with the real path) and writes nothing.
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
  const frame: Frame = { file, real, text: options.read(real), options };
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

  const prefix = separatorFor(text, eol);
  const edit: RecordedTextBlockEdit = {
    kind: 'text-block',
    id: block.id,
    lines,
    previous: null,
    prefix,
  };
  return buildPlan(frame, `${text}${prefix}${blockText(block.id, lines, eol)}${eol}`, [edit]);
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

/**
 * Whether the `prefix` Stroq wrote before a block is still the text right before it, and safe to
 * take away with the block. What would be left must still end with a line break, so that this
 * never eats the end of a line that is the owner's; the one exception is when Stroq itself ended
 * the owner's last line (a prefix of two line breaks), and then both are Stroq's.
 */
function prefixIsOurs(before: string, prefix: string): boolean {
  if (prefix === '' || !before.endsWith(prefix)) return false;
  const eol = prefix.startsWith('\r\n') ? '\r\n' : '\n';
  const remaining = before.slice(0, before.length - prefix.length);
  return prefix === eol + eol || remaining === '' || remaining.endsWith('\n');
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
  const before = text.slice(0, found.begin.start);
  const keep = prefixIsOurs(before, edit.prefix)
    ? before.slice(0, before.length - edit.prefix.length)
    : before;
  const out = keep + text.slice(found.end.next);
  return { outcome: 'edited', text: out, kept: [], empty: isBlank(out) };
}
