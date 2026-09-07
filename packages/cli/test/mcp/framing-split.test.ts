import { describe, expect, it } from 'vitest';
import { MAX_LINE_CHARS, createLineSplitter } from '../../src/mcp/framing.js';

const texts = (lines: readonly { text: string }[]) => lines.map((l) => l.text);

/** Every `text + eol` in arrival order — must reconstruct the input exactly. */
const rejoin = (lines: readonly { text: string; eol: string }[]): string =>
  lines.map((l) => l.text + l.eol).join('');

describe('the line splitter, which must never lose or invent a byte', () => {
  it('reassembles a message split across chunks', () => {
    // stdio framing is one message per line, but a pipe delivers whatever it likes:
    // a 200-byte JSON-RPC message routinely arrives as three chunks.
    const split = createLineSplitter();
    expect(split.push('{"jsonrpc"')).toEqual([]);
    expect(split.push(':"2.0","id"')).toEqual([]);
    expect(texts(split.push(':1}\n'))).toEqual(['{"jsonrpc":"2.0","id":1}']);
  });

  it('emits several lines from one chunk, in order', () => {
    const split = createLineSplitter();
    expect(texts(split.push('a\nb\nc'))).toEqual(['a', 'b']);
    expect(texts(split.flush())).toEqual(['c']);
  });

  it('keeps a carriage return and a blank line, because forwarding is byte-exact', () => {
    // A CRLF client leaves the `\r` inside the line text; re-adding only the `\n`
    // preserves it. A blank line between two messages is forwarded as a blank line.
    const split = createLineSplitter();
    expect(texts(split.push('{"a":1}\r\n\n{"b":2}\n'))).toEqual(['{"a":1}\r', '', '{"b":2}']);
  });

  it('marks a terminated line and an unterminated remainder differently', () => {
    // The remainder has no terminator of its own, so forwarding must not add one.
    const split = createLineSplitter();
    expect(split.push('one\ntwo')).toEqual([{ text: 'one', eol: '\n', oversize: false }]);
    expect(split.flush()).toEqual([{ text: 'two', eol: '', oversize: false }]);
    expect(split.flush()).toEqual([]);
  });

  it('flags a line past the parse bound and leaves its neighbours alone', () => {
    // The flag is a property of the line's OWN length: a small line that happens to
    // share a chunk with a huge one must not inherit the flag.
    const split = createLineSplitter();
    const huge = 'x'.repeat(MAX_LINE_CHARS + 1);
    const lines = split.push(`small\n${huge}\ntail\n`);
    expect(lines.map((l) => l.oversize)).toEqual([false, true, false]);
  });

  it('flags the exact boundary correctly: at the limit is not oversize, one past it is', () => {
    const atBound = 'x'.repeat(MAX_LINE_CHARS);
    const overBound = `${atBound}x`;
    expect(createLineSplitter().push(`${atBound}\n`)).toEqual([
      { text: atBound, eol: '\n', oversize: false },
    ]);
    expect(createLineSplitter().push(`${overBound}\n`)).toEqual([
      { text: overBound, eol: '\n', oversize: true },
    ]);
  });

  it('treats an empty push as a no-op', () => {
    expect(createLineSplitter().push('')).toEqual([]);
  });

  it('has nothing left to flush when the last chunk ends exactly on a terminator', () => {
    const split = createLineSplitter();
    expect(texts(split.push('foo\n'))).toEqual(['foo']);
    expect(split.flush()).toEqual([]);
  });

  it('round-trips a stream with CRLF, a blank line and an unterminated tail across three pushes', () => {
    const input = '{"a":1}\r\n' + '\n' + '{"b":2}\n' + 'tail, no newline';
    const split = createLineSplitter();
    const lines = [
      ...split.push(input.slice(0, 10)),
      ...split.push(input.slice(10, 20)),
      ...split.push(input.slice(20)),
      ...split.flush(),
    ];
    expect(rejoin(lines)).toBe(input);
  });
});

describe('a single oversize line delivered across many small chunks', () => {
  // `push` used to re-flatten the whole accumulated buffer on every chunk, which
  // made this quadratic: fine at small sizes, seconds at 32 MiB, unusable — and
  // eventually an unhandled RangeError — beyond that. Both modes below must stay
  // linear; streaming mode must also keep memory bounded near MAX_LINE_CHARS
  // instead of holding the whole line at once.
  const CHUNK_CHARS = 64 * 1024;
  const LINE_CHARS = 64 * 1024 * 1024;
  const TIME_BUDGET_MS = 2000;

  const chunksOf = (text: string): string[] => {
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += CHUNK_CHARS) chunks.push(text.slice(i, i + CHUNK_CHARS));
    return chunks;
  };

  it('buffers the whole line as a single SplitLine by default, and stays fast', () => {
    const input = `${'x'.repeat(LINE_CHARS)}\n`;
    const split = createLineSplitter();
    const started = Date.now();
    const lines = chunksOf(input).flatMap((chunk) => split.push(chunk));
    lines.push(...split.flush());
    expect(Date.now() - started).toBeLessThan(TIME_BUDGET_MS);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.oversize).toBe(true);
    expect(rejoin(lines)).toBe(input);
  });

  it('emits a run of oversize segments in streaming mode, and stays fast', () => {
    const input = `${'x'.repeat(LINE_CHARS)}\n`;
    const split = createLineSplitter({ streamOversize: true });
    const started = Date.now();
    const lines = chunksOf(input).flatMap((chunk) => split.push(chunk));
    lines.push(...split.flush());
    expect(Date.now() - started).toBeLessThan(TIME_BUDGET_MS);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((l) => l.oversize)).toBe(true);
    // Every segment but the last is unterminated; only the last carries the `\n`.
    expect(lines.slice(0, -1).every((l) => l.eol === '')).toBe(true);
    expect(lines.at(-1)?.eol).toBe('\n');
    expect(rejoin(lines)).toBe(input);
  });
});
