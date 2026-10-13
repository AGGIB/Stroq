// The stream of `claude -p --output-format stream-json`, read as it arrives.
//
// The driver feeds this what the host prints, in whatever pieces a pipe delivers it, and acts on the answer
// of each piece: a host that says in its first message that it is paid for by an API key, or that the plan
// has moved on to extra usage, is stopped before it answers, because a request that is made is paid for.
// What each line means is `claude-message.ts`'s; this assembles lines and holds what they add up to.
//
// The object keeps state (the text of a line that has not ended, the events so far) because a stream is read
// over time; everything it hands out is a copy that nothing here changes afterwards.
import { interpretMessage, type StreamFacts, type StreamStop } from './claude-message.js';
import type { StreamEvent } from '../types.js';

export type { StreamStop } from './claude-message.js';

export interface StreamLimits {
  /** The most characters read from the stream in all: a host that prints more is stopped. */
  readonly maxChars: number;
  /** The most characters of one line that are held to be read: a longer one is skipped, and counted. */
  readonly maxLineChars: number;
}

/** A request of a few lines is a few KiB; these are far above any, and bound what a runaway host costs. */
export const DEFAULT_STREAM_LIMITS: StreamLimits = {
  maxChars: 8 * 1024 * 1024,
  maxLineChars: 2 * 1024 * 1024,
};

/** What a whole stream, or the part of it that was read, comes to. */
export interface ParsedStream extends StreamFacts {
  readonly stream: readonly StreamEvent[];
  /** How many lines were not read: not JSON, not an object, or in a shape a call could hide in. */
  readonly unparsedLines: number;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export class ClaudeStreamParser {
  private pending = '';
  /** Inside a line that was too long to hold: everything up to its end is thrown away. */
  private skipping = false;
  private seen = 0;
  private stopped: StreamStop | null = null;
  private events: StreamEvent[] = [];
  private facts: StreamFacts = {};
  private unparsed = 0;

  constructor(private readonly limits: StreamLimits = DEFAULT_STREAM_LIMITS) {}

  /**
   * Reads more of the stream. Returns why the host is to be stopped, once the lines so far say so: from
   * then on nothing more is read (what a host prints after that is not what it did before), and the same
   * answer is returned.
   */
  push(text: string): StreamStop | null {
    if (this.stopped !== null) return this.stopped;
    this.seen += text.length;
    if (this.seen > this.limits.maxChars) {
      this.unparsed += 1;
      this.stopped = {
        kind: 'too-much-output',
        detail: 'the host printed more than the check reads, so it was stopped',
      };
      return this.stopped;
    }
    this.consume(text);
    return this.stopped;
  }

  /** The end of the stream: a last line without its newline is read as it is. */
  finish(): ParsedStream {
    if (this.stopped === null && !this.skipping && this.pending !== '') this.readLine(this.pending);
    this.pending = '';
    return this.snapshot();
  }

  /** What has been read so far. */
  snapshot(): ParsedStream {
    return { ...this.facts, stream: [...this.events], unparsedLines: this.unparsed };
  }

  private consume(text: string): void {
    let start = 0;
    while (this.stopped === null) {
      const end = text.indexOf('\n', start);
      if (end === -1) {
        this.hold(text.slice(start));
        return;
      }
      this.endLine(text.slice(start, end));
      start = end + 1;
    }
  }

  /** Text of a line that goes on past this piece. */
  private hold(rest: string): void {
    if (this.skipping) return;
    this.pending += rest;
    if (this.pending.length > this.limits.maxLineChars) {
      this.pending = '';
      this.skipping = true;
      this.unparsed += 1;
    }
  }

  private endLine(last: string): void {
    if (this.skipping) {
      this.skipping = false;
      return;
    }
    const line = this.pending + last;
    this.pending = '';
    if (line.length > this.limits.maxLineChars) this.unparsed += 1;
    else this.readLine(line);
  }

  private readLine(raw: string): void {
    const text = raw.trim();
    if (text === '') return;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      this.unparsed += 1;
      return;
    }
    if (!isObject(value)) {
      this.unparsed += 1;
      return;
    }
    const read = interpretMessage(value);
    if (read.unreadable) this.unparsed += 1;
    this.events.push(...read.events);
    this.facts = { ...this.facts, ...read.facts };
    if (read.stop !== null) this.stopped = read.stop;
  }
}

/** A whole stream at once: for a test, and for a stream that is already complete. */
export function parseClaudeStream(
  text: string,
  limits: StreamLimits = DEFAULT_STREAM_LIMITS,
): { readonly parsed: ParsedStream; readonly stop: StreamStop | null } {
  const parser = new ClaudeStreamParser(limits);
  const stop = parser.push(text);
  return { parsed: parser.finish(), stop };
}
