import { HardenError } from './types.js';

/**
 * A unified diff of two texts, in house.
 *
 * `stroq harden` must show what it is about to change, and the people who read that are looking
 * at a config file of a few dozen lines. A line diff of that size is a page of code, and a
 * dependency for it would be the CLI's third; so this is Myers' shortest-edit algorithm with the
 * common head and tail cut off first, bounded on both sides:
 *
 * - inputs above `MAX_DIFF_BYTES` / `MAX_DIFF_LINES` are refused, with a typed error. A change
 *   the owner cannot be shown is a change the engine should not make.
 * - past `MAX_EDIT_DISTANCE` changed lines the middle is shown as one block removed and one block
 *   added. That is still a correct patch, only not the smallest, and it keeps the memory the
 *   algorithm needs (it grows with the square of the distance) bounded.
 *
 * The output is what `diff -u` prints, with `a/` and `b/` labels and no timestamps, so it is
 * deterministic.
 */

export const MAX_DIFF_BYTES = 512 * 1024;
export const MAX_DIFF_LINES = 20_000;
/** Changed lines (removed plus added) up to which the diff is the shortest one. */
export const MAX_EDIT_DISTANCE = 3_000;

const DEFAULT_CONTEXT = 3;
const NO_NEWLINE = '\\ No newline at end of file';

/**
 * Whether the line at `index` (counting from 0 in the text it belongs to) must not be shown. It
 * is asked only of lines that appear in the diff, `line` being the line without its line break.
 */
export type HideLine = (index: number, line: string) => boolean;

/** What a hidden line is shown as, whatever it said: the diff keeps its shape and loses the text. */
export const HIDDEN_LINE = '[credential-shaped text hidden]';

export interface DiffOptions {
  /** Shown in the headers. It is a label, not a place to open: control characters are replaced. */
  readonly path: string;
  /** Lines of context around each change. Default 3. */
  readonly context?: number;
  /** The old side is a file that did not exist: its header is `/dev/null`. */
  readonly oldMissing?: boolean;
  /** The new side is a file that is gone. */
  readonly newMissing?: boolean;
  /**
   * Lines to show as `HIDDEN_LINE` instead of their text, for the old and the new text. A context
   * line is hidden if either side asks for it. The hunk headers are the same with or without.
   */
  readonly hide?: { readonly old?: HideLine; readonly new?: HideLine };
}

/** A diff and how many of its lines were hidden. */
export interface DiffResult {
  readonly text: string;
  readonly hidden: number;
}

type Tag = ' ' | '-' | '+';

/** One line of the edit script. `line` keeps its terminator, so "x" and "x\n" are different. */
interface Op {
  readonly tag: Tag;
  readonly line: string;
}

const op = (tag: Tag, line: string): Op => ({ tag, line });

/** The lines of a text with their terminators kept; an empty text has none. */
const splitLines = (text: string): string[] => text.split(/(?<=\n)/).filter((line) => line !== '');

/** Throws `diff-too-large` for a text the preview is not willing to compute a diff of. */
export function assertDiffable(text: string): void {
  let lines = 0;
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) lines += 1;
  if (text.length > 0 && !text.endsWith('\n')) lines += 1;
  // A character is at least one byte, so a string longer than the limit is over it without
  // counting; only the ones that might be under it need their bytes measured.
  const tooBig = text.length > MAX_DIFF_BYTES || Buffer.byteLength(text, 'utf8') > MAX_DIFF_BYTES;
  if (tooBig || lines > MAX_DIFF_LINES) {
    throw new HardenError(
      'diff-too-large',
      `the text is too large to show a diff of (the limit is ${MAX_DIFF_BYTES} bytes or ${MAX_DIFF_LINES} lines)`,
    );
  }
}

/**
 * Myers' forward search. Returns, for each number of changes `d`, the furthest point reached on
 * every diagonal before that step (the trace the backtrack reads), or `null` when more than
 * `maxD` changes are needed. Lines are compared as numbers: `a` and `b` are interned.
 */
function shortestEdit(
  a: readonly number[],
  b: readonly number[],
  maxD: number,
): Int32Array[] | null {
  const n = a.length;
  const m = b.length;
  const limit = Math.min(n + m, maxD);
  const offset = limit + 1;
  const reach = new Int32Array(2 * limit + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= limit; d += 1) {
    trace.push(reach.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      const down =
        k === -d || (k !== d && (reach[offset + k - 1] ?? 0) < (reach[offset + k + 1] ?? 0));
      let x = down ? (reach[offset + k + 1] ?? 0) : (reach[offset + k - 1] ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      reach[offset + k] = x;
      if (x >= n && y >= m) return trace;
    }
  }
  return null;
}

/** Walks the trace from the end back to the start and returns the edit script, in order. */
function backtrack(a: readonly string[], b: readonly string[], trace: Int32Array[]): Op[] {
  const script: Op[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = trace.length - 1; d >= 0; d -= 1) {
    const before = trace[d] ?? new Int32Array(0);
    const at = (k: number): number => before[k + d + 1] ?? 0;
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      script.push(op(' ', a[x - 1] ?? ''));
      x -= 1;
      y -= 1;
    }
    if (d > 0) script.push(down ? op('+', b[prevY] ?? '') : op('-', a[prevX] ?? ''));
    x = prevX;
    y = prevY;
  }
  return script.reverse();
}

/** The edit script for two stretches that share no head and no tail. */
function middleScript(a: readonly string[], b: readonly string[]): Op[] {
  if (a.length === 0) return b.map((line) => op('+', line));
  if (b.length === 0) return a.map((line) => op('-', line));
  const ids = new Map<string, number>();
  const intern = (line: string): number => {
    const known = ids.get(line);
    if (known !== undefined) return known;
    ids.set(line, ids.size);
    return ids.size - 1;
  };
  const trace = shortestEdit(a.map(intern), b.map(intern), MAX_EDIT_DISTANCE);
  if (trace !== null) return backtrack(a, b, trace);
  return [...a.map((line) => op('-', line)), ...b.map((line) => op('+', line))];
}

function editScript(a: readonly string[], b: readonly string[]): Op[] {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1;
  }
  return [
    ...a.slice(0, head).map((line) => op(' ', line)),
    ...middleScript(a.slice(head, a.length - tail), b.slice(head, b.length - tail)),
    ...a.slice(a.length - tail).map((line) => op(' ', line)),
  ];
}

/** `start,count` as `diff -u` writes it: no count for one line, and the line BEFORE for none. */
function range(before: number, count: number): string {
  if (count === 0) return `${before},0`;
  return count === 1 ? String(before + 1) : `${before + 1},${count}`;
}

/** What the hunks of a diff came to: their rows, and how many lines were hidden. */
interface Hunks {
  readonly rows: string[];
  hidden: number;
}

/** The text of a line as the predicate sees it: no line break, no carriage return. */
const bare = (content: string): string => (content.endsWith('\r') ? content.slice(0, -1) : content);

/** The hunks of an edit script: changes with `context` lines around them, close ones joined. */
function hunks(script: readonly Op[], context: number, hide: DiffOptions['hide']): Hunks {
  const made: Hunks = { rows: [], hidden: 0 };
  const changed: number[] = [];
  script.forEach((entry, i) => {
    if (entry.tag !== ' ') changed.push(i);
  });
  const first = changed[0];
  if (first === undefined) return made;

  // Changes belong to one hunk while no more than twice the context lies between them.
  const groups: [number, number][] = [];
  let from = first;
  let last = first;
  for (const at of changed.slice(1)) {
    if (at - last - 1 > 2 * context) {
      groups.push([from, last]);
      from = at;
    }
    last = at;
  }
  groups.push([from, last]);

  const consumedA: number[] = [0];
  const consumedB: number[] = [0];
  for (const entry of script) {
    consumedA.push((consumedA[consumedA.length - 1] ?? 0) + (entry.tag === '+' ? 0 : 1));
    consumedB.push((consumedB[consumedB.length - 1] ?? 0) + (entry.tag === '-' ? 0 : 1));
  }

  for (const [firstChange, lastChange] of groups) {
    const start = Math.max(0, firstChange - context);
    const end = Math.min(script.length, lastChange + context + 1);
    const part = script.slice(start, end);
    const oldCount = part.filter((entry) => entry.tag !== '+').length;
    const newCount = part.filter((entry) => entry.tag !== '-').length;
    made.rows.push(
      `@@ -${range(consumedA[start] ?? 0, oldCount)} +${range(consumedB[start] ?? 0, newCount)} @@`,
    );
    part.forEach((entry, offset) => {
      const terminated = entry.line.endsWith('\n');
      const content = terminated ? entry.line.slice(0, -1) : entry.line;
      // How many lines of each text came before this one: its own index in the text it is from.
      const oldIndex = consumedA[start + offset] ?? 0;
      const newIndex = consumedB[start + offset] ?? 0;
      const seen = bare(content);
      const hidden =
        (entry.tag !== '+' && hide?.old?.(oldIndex, seen) === true) ||
        (entry.tag !== '-' && hide?.new?.(newIndex, seen) === true);
      if (hidden) made.hidden += 1;
      made.rows.push(`${entry.tag}${hidden ? HIDDEN_LINE : content}`);
      if (!terminated) made.rows.push(NO_NEWLINE);
    });
  }
  return made;
}

/** A path as a label: no control character that could end the line, `/` for `\`, no root. */
const labelOf = (path: string): string =>
  path
    .replace(/[\u0000-\u001f\u007f]/g, '?')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');

/**
 * The unified diff from `a` to `b` (`text` is `''` when they are the same text), and how many of
 * its lines were hidden by `options.hide`.
 *
 * Throws `HardenError('diff-too-large')` for an input above `MAX_DIFF_BYTES` or `MAX_DIFF_LINES`.
 */
export function diffText(a: string, b: string, options: DiffOptions): DiffResult {
  assertDiffable(a);
  assertDiffable(b);
  const flagged = options.oldMissing === true || options.newMissing === true;
  if (a === b && !flagged) return { text: '', hidden: 0 };

  const label = labelOf(options.path);
  const made = hunks(
    editScript(splitLines(a), splitLines(b)),
    options.context ?? DEFAULT_CONTEXT,
    options.hide,
  );
  const rows = [
    options.oldMissing === true ? '--- /dev/null' : `--- a/${label}`,
    options.newMissing === true ? '+++ /dev/null' : `+++ b/${label}`,
    ...made.rows,
  ];
  return { text: `${rows.join('\n')}\n`, hidden: made.hidden };
}

/** The unified diff from `a` to `b`, or `''` when they are the same text. See `diffText`. */
export const unifiedDiff = (a: string, b: string, options: DiffOptions): string =>
  diffText(a, b, options).text;
