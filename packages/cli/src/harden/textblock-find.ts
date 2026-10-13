/**
 * Finding the block Stroq owns in the text of a line-oriented file: its two marker lines, the lines
 * between them, and where each of them starts and ends. Planning a block and undoing one read a
 * file the same way, so both come through here.
 */

export const BEGIN_PREFIX = '# >>> stroq harden:';
export const END_PREFIX = '# <<< stroq harden:';

/** The two lines that bound the block called `id`. */
export function blockMarkers(id: string): { readonly begin: string; readonly end: string } {
  return { begin: `${BEGIN_PREFIX} ${id} >>>`, end: `${END_PREFIX} ${id} <<<` };
}

export interface Row {
  /** Where the line starts, where its text ends (before the line break), where the next starts. */
  readonly start: number;
  readonly end: number;
  readonly next: number;
  readonly content: string;
}

/** The lines of `text`, each with its place in it. A line break is `\n` or `\r\n`. */
export function rowsOf(text: string): Row[] {
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

export type Found =
  | { readonly kind: 'none' }
  | { readonly kind: 'damaged'; readonly detail: string }
  | { readonly kind: 'found'; readonly begin: Row; readonly end: Row; readonly body: string[] };

/**
 * The block called `id` in `text`. A marker line is one that equals the marker once its trailing
 * white space is gone, which editors add and remove. A block that is not a clean pair is
 * `damaged`: removing or replacing it would be a guess about what the owner meant.
 */
export function findBlock(text: string, id: string): Found {
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
export function lineBreakOf(text: string): '\n' | '\r\n' {
  const newline = text.indexOf('\n');
  return newline > 0 && text[newline - 1] === '\r' ? '\r\n' : '\n';
}
