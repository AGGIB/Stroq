// What an update changes, as lines a person can read before typing a digest.
//
// The change list of an update names the files; it does not say what they now say. A skill is the text its
// agent follows, so one added sentence in `SKILL.md` is the whole change, and a server that gains one
// `net.connect` has the same passport as before. So each changed text file is shown as a diff against the
// version in the store: removed lines marked `-`, added lines marked `+`, no context. The view is bounded
// (40 lines of one file, 200 in all, 20,000 characters in all) and says how many lines it did not show, and
// every line goes through the same helper as the passport screen, so a control or direction character in a
// changed line is written out and cannot act on the terminal.
//
// A long line is not cut at its start: one sentence added to a paragraph of 300 characters would be past any
// cut that keeps a screen readable. A removed line and the added line that replaces it are compared, and what
// is shown is the part that differs, with a little of the text on each side and `\u2026` where unchanged text was
// left out. A part that is still longer than 2,000 characters is cut, and the last line says so; the words
// "every changed line is shown" are said only when nothing was left out and nothing was cut.
import { lineText } from '../commands/vet-text.js';
import { textOf } from './text-of.js';
import { changedFiles } from './material.js';
import type { Tree, TreeEntry } from './types.js';

export const DIFF_LINES_PER_FILE = 40;
export const DIFF_LINES_TOTAL = 200;
const PATH_MAX = 260;
/** A row is wrapped at this width. */
const WRAP = 160;
/** How much of a changed part of a line is shown; a longer part is cut and counted. */
const SPAN_MAX = 2000;
/** The unchanged text kept on each side of the changed part of a line. */
const CONTEXT = 30;
/** All the characters of changed lines one update shows. */
const CHARS_TOTAL = 20_000;
const ELLIPSIS = '\u2026';
/** A text file over this is named and not compared. */
const TEXT_MAX_BYTES = 1024 * 1024;
/** The table of one comparison, in cells (lines of one file times lines of the other, after the common ends are cut). */
const CELLS_PER_FILE = 1_000_000;
/** The cells of all the comparisons of one update. */
const CELLS_TOTAL = 20_000_000;
const NEWLINE = 0x0a;

interface Row {
  readonly mark: '+' | '-';
  readonly text: string;
  /** Rows of one run of changes between lines that are the same: a removed line is paired with an added one. */
  readonly hunk: number;
}

interface Compared {
  /** The first rows, at most the room the caller has. */
  readonly rows: readonly Row[];
  /** All the rows there are, shown or not. */
  readonly total: number;
}

type Content =
  | { readonly kind: 'text'; readonly lines: readonly string[] }
  | { readonly kind: 'binary' }
  | { readonly kind: 'large'; readonly lines: number };

const countLines = (bytes: Uint8Array): number =>
  bytes.reduce((n, b) => n + (b === NEWLINE ? 1 : 0), 1);

function contentOf(entry: TreeEntry | undefined): Content {
  const bytes = entry?.bytes ?? new Uint8Array();
  if (bytes.byteLength > TEXT_MAX_BYTES) return { kind: 'large', lines: countLines(bytes) };
  const text = textOf(bytes);
  if (text === null) return { kind: 'binary' };
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return { kind: 'text', lines };
}

const marked = (mark: Row['mark'], lines: readonly string[], room: number): Row[] =>
  lines.slice(0, Math.max(0, room)).map((text) => ({ mark, text, hunk: 0 }));

/** Cuts the lines both versions start and end with, and compares what is left. */
function compare(
  before: readonly string[],
  after: readonly string[],
  room: number,
  cells: { left: number },
): Compared {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start])
    start += 1;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore -= 1;
    endAfter -= 1;
  }
  const x = before.slice(start, endBefore);
  const y = after.slice(start, endAfter);
  const size = (x.length + 1) * (y.length + 1);
  if (x.length === 0 || y.length === 0 || size > CELLS_PER_FILE || size > cells.left) {
    // One side is empty, or the comparison is more work than a screen of lines is worth: every line is a change.
    const rows = [...marked('-', x, room), ...marked('+', y, room - x.length)];
    return { rows: rows.slice(0, Math.max(0, room)), total: x.length + y.length };
  }
  cells.left -= size;
  return walk(x, y, room);
}

/** The rows of a longest-common-subsequence comparison, in the order of the text. */
function walk(x: readonly string[], y: readonly string[], room: number): Compared {
  const width = y.length + 1;
  const common = new Uint32Array((x.length + 1) * width);
  for (let i = x.length - 1; i >= 0; i -= 1) {
    for (let j = y.length - 1; j >= 0; j -= 1) {
      common[i * width + j] =
        x[i] === y[j]
          ? (common[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(common[(i + 1) * width + j] ?? 0, common[i * width + j + 1] ?? 0);
    }
  }
  const rows: Row[] = [];
  let total = 0;
  let i = 0;
  let j = 0;
  let hunk = 0;
  let changing = false;
  const push = (mark: Row['mark'], text: string): void => {
    total += 1;
    changing = true;
    if (rows.length < room) rows.push({ mark, text, hunk });
  };
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) {
      if (changing) hunk += 1;
      changing = false;
      i += 1;
      j += 1;
    } else if (
      j >= y.length ||
      (i < x.length && (common[(i + 1) * width + j] ?? 0) >= (common[i * width + j + 1] ?? 0))
    ) {
      push('-', x[i] ?? '');
      i += 1;
    } else {
      push('+', y[j] ?? '');
      j += 1;
    }
  }
  return { rows, total };
}

const execNote = (before: TreeEntry | undefined, after: TreeEntry | undefined): string[] => {
  const was = before?.exec === true;
  const is = after?.exec === true;
  if (before === undefined) return is ? ['    (executable)'] : [];
  if (after === undefined || was === is) return [];
  return [`    (executable bit: ${was ? 'yes' : 'no'} -> ${is ? 'yes' : 'no'})`];
};

interface FileView {
  readonly lines: string[];
  /** Diff lines left out: more than the room, more than the characters, or a file that was not compared. */
  readonly hidden: number;
  /** Diff lines shown with their changed part cut. */
  readonly cut: number;
  /** Diff lines shown. */
  readonly shown: number;
}

interface Budget {
  cells: number;
  chars: number;
}

/** The common start and end of two strings, never inside a surrogate pair. */
function commonEnds(a: string, b: string): { start: number; end: number } {
  const most = Math.min(a.length, b.length);
  let start = 0;
  while (start < most && a.charCodeAt(start) === b.charCodeAt(start)) start += 1;
  if (start > 0 && (a.charCodeAt(start - 1) & 0xfc00) === 0xd800) start -= 1;
  let end = 0;
  while (
    end < most - start &&
    a.charCodeAt(a.length - 1 - end) === b.charCodeAt(b.length - 1 - end)
  )
    end += 1;
  if (end > 0 && (a.charCodeAt(a.length - end) & 0xfc00) === 0xdc00) end -= 1;
  return { start, end };
}

/** What of a line is shown: the part that differs from its partner, with some of the text around it. */
function windowOf(text: string, partner: string | null): { shown: string; cut: boolean } {
  const { start, end } = partner === null ? { start: 0, end: 0 } : commonEnds(text, partner);
  const span = text.slice(start, text.length - end);
  const lead =
    start > CONTEXT ? `${ELLIPSIS}${text.slice(start - CONTEXT, start)}` : text.slice(0, start);
  if (span.length > SPAN_MAX)
    return { shown: `${lead}${span.slice(0, SPAN_MAX)}${ELLIPSIS}`, cut: true };
  const rest = text.slice(text.length - end);
  const trail = rest.length > CONTEXT ? `${rest.slice(0, CONTEXT)}${ELLIPSIS}` : rest;
  return { shown: `${lead}${span}${trail}`, cut: false };
}

/** The partner of each row: the nth removed line of a run of changes is paired with the nth added one. */
function partners(rows: readonly Row[]): (string | null)[] {
  const byHunk = new Map<number, { removed: number[]; added: number[] }>();
  rows.forEach((row, at) => {
    const group = byHunk.get(row.hunk) ?? { removed: [], added: [] };
    (row.mark === '-' ? group.removed : group.added).push(at);
    byHunk.set(row.hunk, group);
  });
  const out: (string | null)[] = rows.map(() => null);
  for (const { removed, added } of byHunk.values()) {
    removed.forEach((at, n) => {
      const other = added[n];
      if (other !== undefined) {
        out[at] = rows[other]?.text ?? null;
        out[other] = rows[at]?.text ?? null;
      }
    });
  }
  return out;
}

/** A neutralised line cut into rows of the width of a screen; the continuation rows have no mark. */
function wrapped(mark: string, text: string): string[] {
  const rows: string[] = [];
  for (let at = 0; at < Math.max(text.length, 1); at += WRAP)
    rows.push(`${at === 0 ? `    ${mark} ` : '      '}${text.slice(at, at + WRAP)}`);
  return rows;
}

function renderRows(
  rows: readonly Row[],
  budget: Budget,
): Omit<FileView, 'hidden'> & { dropped: number } {
  const pair = partners(rows);
  const lines: string[] = [];
  let cut = 0;
  let shown = 0;
  rows.forEach((row, at) => {
    const view = windowOf(row.text, pair[at] ?? null);
    const text = lineText(view.shown, 12 * SPAN_MAX);
    if (text.length > budget.chars) return;
    budget.chars -= text.length;
    lines.push(...wrapped(row.mark, text));
    shown += 1;
    if (view.cut) cut += 1;
  });
  return { lines, cut, shown, dropped: rows.length - shown };
}

function viewFile(
  change: string,
  path: string,
  before: TreeEntry | undefined,
  after: TreeEntry | undefined,
  room: number,
  budget: Budget,
): FileView {
  const head = [`  ${change} ${lineText(path, PATH_MAX)}`, ...execNote(before, after)];
  const old = contentOf(before);
  const next = contentOf(after);
  if (old.kind === 'binary' || next.kind === 'binary')
    return { lines: [...head, '    (not text: not compared)'], hidden: 0, cut: 0, shown: 0 };
  if (old.kind === 'large' || next.kind === 'large') {
    const count = (c: Exclude<Content, { kind: 'binary' }>): number =>
      c.kind === 'large' ? c.lines : c.lines.length;
    return {
      lines: [...head, `    (over ${TEXT_MAX_BYTES} bytes: not compared)`],
      hidden: count(old) + count(next),
      cut: 0,
      shown: 0,
    };
  }
  const cells = { left: budget.cells };
  const { rows, total } = compare(
    old.lines,
    next.lines,
    Math.min(room, DIFF_LINES_PER_FILE),
    cells,
  );
  budget.cells = cells.left;
  const drawn = renderRows(rows, budget);
  return {
    lines: [...head, ...drawn.lines],
    hidden: total - rows.length + drawn.dropped,
    cut: drawn.cut,
    shown: drawn.shown,
  };
}

/**
 * The lines to print for an update from `before` (the version in the store) to `after`: each changed file,
 * the lines of it that changed, and a last line that says how many were left out. Empty when the trees hold
 * the same files.
 */
export function updateDiffLines(before: Tree, after: Tree): string[] {
  const old = new Map(before.entries.map((entry) => [entry.path, entry]));
  const next = new Map(after.entries.map((entry) => [entry.path, entry]));
  const files = changedFiles(before, after);
  if (files.length === 0) return [];
  const budget: Budget = { cells: CELLS_TOTAL, chars: CHARS_TOTAL };
  let room = DIFF_LINES_TOTAL;
  let hidden = 0;
  let cut = 0;
  const out: string[] = [];
  for (const { path, change } of files) {
    const view = viewFile(change, path, old.get(path), next.get(path), room, budget);
    out.push(...view.lines);
    room -= view.shown;
    hidden += view.hidden;
    cut += view.cut;
  }
  out.push(footer(hidden, cut));
  return out;
}

/** The last line: what was left out and what was cut, or that nothing was. */
function footer(hidden: number, cut: number): string {
  if (hidden === 0 && cut === 0) return '  every changed line is shown';
  const parts = [
    ...(hidden > 0
      ? [
          `${hidden} diff ${hidden === 1 ? 'line' : 'lines'} not shown (at most ${DIFF_LINES_PER_FILE} per file, ${DIFF_LINES_TOTAL} in all and ${CHARS_TOTAL} characters)`,
        ]
      : []),
    ...(cut > 0
      ? [
          `${cut} shown ${cut === 1 ? 'line is' : 'lines are'} cut where the changed part passes ${SPAN_MAX} characters`,
        ]
      : []),
  ];
  return `  ${parts.join('; ')}`;
}
