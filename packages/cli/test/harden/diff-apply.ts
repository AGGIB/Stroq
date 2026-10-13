/**
 * A small `patch`, for tests only: applies the unified diff `unifiedDiff` printed to the text it
 * was made from. If a diff applies cleanly and gives back the other text, the hunks, their
 * numbers, the context and the "no newline" markers are all consistent with one another, which
 * is what the golden outputs cannot show for inputs nobody wrote down.
 *
 * It is strict on purpose: a context or removed line that does not match the source throws.
 */

import { unifiedDiff } from '../../src/harden/diff.js';

/** `unifiedDiff` with the label every diff test uses and the context left to its default. */
export const diff = (a: string, b: string, context?: number): string =>
  unifiedDiff(a, b, { path: 'f.txt', ...(context === undefined ? {} : { context }) });

/** Rows as lines, each with its newline. */
export const lines = (...rows: string[]): string => rows.map((row) => `${row}\n`).join('');

/** The numbers from `from` to `to` as strings, one per line. */
export const numbers = (from: number, to: number): string[] =>
  Array.from({ length: to - from + 1 }, (_, i) => String(from + i));

interface Entry {
  readonly tag: ' ' | '-' | '+';
  readonly text: string;
  terminated: boolean;
}

const HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@$/;

/** Lines with their terminators kept; an empty text has no lines. */
const linesOf = (text: string): string[] => text.split(/(?<=\n)/).filter((line) => line !== '');

export function applyUnifiedDiff(original: string, diff: string): string {
  if (diff === '') return original;
  const source = linesOf(original);
  const out: string[] = [];
  let at = 0;

  const body = diff.split('\n');
  let i = body.findIndex((line) => line.startsWith('@@'));
  if (i === -1) throw new Error('no hunk in the diff');
  while (i < body.length) {
    const line = body[i] ?? '';
    if (line === '' && i === body.length - 1) break;
    const header = HEADER.exec(line);
    if (header === null) throw new Error(`bad hunk header: ${line}`);
    const oldStart = Number(header[1]);
    const oldCount = header[2] === undefined ? 1 : Number(header[2]);
    // An empty old range names the line BEFORE the hunk; any other starts at its first line.
    const hunkAt = oldCount === 0 ? oldStart : oldStart - 1;
    while (at < hunkAt) out.push(source[at++] ?? '');

    const entries: Entry[] = [];
    for (i += 1; i < body.length && !(body[i] ?? '').startsWith('@@'); i += 1) {
      const row = body[i] ?? '';
      if (row === '' && i === body.length - 1) break;
      if (row.startsWith('\\')) {
        const last = entries[entries.length - 1];
        if (last === undefined) throw new Error('marker before any line');
        last.terminated = false;
        continue;
      }
      const tag = row.charAt(0);
      if (tag !== ' ' && tag !== '-' && tag !== '+') throw new Error(`bad diff line: ${row}`);
      entries.push({ tag, text: row.slice(1), terminated: true });
    }

    for (const entry of entries) {
      const text = entry.terminated ? `${entry.text}\n` : entry.text;
      if (entry.tag === '+') {
        out.push(text);
        continue;
      }
      if (source[at] !== text) {
        throw new Error(
          `${entry.tag === ' ' ? 'context' : 'removed'} line does not match: ${text}`,
        );
      }
      if (entry.tag === ' ') out.push(text);
      at += 1;
    }
  }
  while (at < source.length) out.push(source[at++] ?? '');
  return out.join('');
}
