// What an update changes, as lines a person can read before typing a digest.
//
// The change list of an update names the files; it does not say what they now say. A skill is the text its
// agent follows, so one added sentence in `SKILL.md` is the whole change, and a server that gains one
// `net.connect` has the same passport as before. So each changed text file is shown as a diff against the
// version in the store: removed lines marked `-`, added lines marked `+`, no context. The view is bounded
// (40 lines of one file, 200 in all) and says how many lines it did not show, and every line goes through
// the same helper as the passport screen, so a control or direction character in a changed line is written
// out and cannot act on the terminal.
import { lineText } from '../commands/vet-text.js';
import { changedFiles } from './material.js';
import type { Tree, TreeEntry } from './types.js';

export const DIFF_LINES_PER_FILE = 40;
export const DIFF_LINES_TOTAL = 200;
const LINE_MAX = 160;
const PATH_MAX = 260;
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
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { kind: 'binary' };
  }
  if (text.includes('\u0000')) return { kind: 'binary' };
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return { kind: 'text', lines };
}

const marked = (mark: Row['mark'], lines: readonly string[], room: number): Row[] =>
  lines.slice(0, Math.max(0, room)).map((text) => ({ mark, text }));

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
  const push = (row: Row): void => {
    total += 1;
    if (rows.length < room) rows.push(row);
  };
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) {
      i += 1;
      j += 1;
    } else if (
      j >= y.length ||
      (i < x.length && (common[(i + 1) * width + j] ?? 0) >= (common[i * width + j + 1] ?? 0))
    ) {
      push({ mark: '-', text: x[i] ?? '' });
      i += 1;
    } else {
      push({ mark: '+', text: y[j] ?? '' });
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
  readonly hidden: number;
}

function viewFile(
  change: string,
  path: string,
  before: TreeEntry | undefined,
  after: TreeEntry | undefined,
  room: number,
  cells: { left: number },
): FileView {
  const lines = [`  ${change} ${lineText(path, PATH_MAX)}`, ...execNote(before, after)];
  const old = contentOf(before);
  const next = contentOf(after);
  if (old.kind === 'binary' || next.kind === 'binary') {
    return { lines: [...lines, '    (not text: not compared)'], hidden: 0 };
  }
  if (old.kind === 'large' || next.kind === 'large') {
    const count = (c: Exclude<Content, { kind: 'binary' }>): number =>
      c.kind === 'large' ? c.lines : c.lines.length;
    return {
      lines: [...lines, `    (over ${TEXT_MAX_BYTES} bytes: not compared)`],
      hidden: count(old) + count(next),
    };
  }
  const { rows, total } = compare(
    old.lines,
    next.lines,
    Math.min(room, DIFF_LINES_PER_FILE),
    cells,
  );
  const shown = rows.map((row) => `    ${row.mark} ${lineText(row.text, LINE_MAX)}`);
  return { lines: [...lines, ...shown], hidden: total - rows.length };
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
  const cells = { left: CELLS_TOTAL };
  let room = DIFF_LINES_TOTAL;
  let hidden = 0;
  const out: string[] = [];
  for (const { path, change } of files) {
    const view = viewFile(change, path, old.get(path), next.get(path), room, cells);
    out.push(...view.lines);
    room -= view.lines.filter((line) => /^ {4}[+-] /.test(line)).length;
    hidden += view.hidden;
  }
  out.push(
    hidden === 0
      ? '  every changed line is shown'
      : `  ${hidden} diff ${hidden === 1 ? 'line' : 'lines'} not shown (at most ${DIFF_LINES_PER_FILE} per file and ${DIFF_LINES_TOTAL} in all)`,
  );
  return out;
}
