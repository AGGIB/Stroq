import { vi, type Mock } from 'vitest';
import type { Timers } from '../../src/ui/spinner.js';
import type { Terminal, TerminalFacts } from '../../src/ui/terminal.js';

/**
 * A terminal that is only what a test says it is: the five facts, a place the writes go, and a
 * queue of what "the person" types. Nothing here touches a stream, so a test of the first-run
 * screen can say what the world is without owning a terminal.
 */
export interface FakeTerminalOptions extends Partial<TerminalFacts> {
  /**
   * What the person types, one entry for each question; `null` is the end of the input. A question
   * asked after these have run out finds the input closed.
   */
  readonly answers?: readonly (string | null)[];
}

export interface FakeTerminal {
  readonly term: Terminal;
  /** Everything written so far, as one string. */
  out(): string;
  /** Each call of `write`, in order. */
  readonly writes: string[];
  /** The answers still to be given: push more to answer a later question. */
  readonly answers: (string | null)[];
  /** The prompts `readLine` was asked, in order. */
  readonly prompts: string[];
  /** `readLine` itself, a spy: for how often it was asked, and when. */
  readonly read: Mock<Terminal['readLine']>;
}

/** A plain terminal: nobody to animate for, no colour, glyphs that draw, 80 columns. */
const PLAIN: TerminalFacts = {
  interactive: false,
  color: false,
  color256: false,
  unicode: true,
  columns: 80,
};

export function fakeTerminal(options: FakeTerminalOptions = {}): FakeTerminal {
  const { answers: given = [], ...facts } = options;
  const writes: string[] = [];
  const prompts: string[] = [];
  const answers: (string | null)[] = [...given];
  const read = vi.fn<Terminal['readLine']>(async (prompt) => {
    prompts.push(prompt);
    return answers.length === 0 ? null : (answers.shift() ?? null);
  });
  const term: Terminal = {
    ...PLAIN,
    ...facts,
    write: (text) => {
      writes.push(text);
    },
    readLine: read,
  };
  return { term, out: () => writes.join(''), writes, answers, prompts, read };
}

/** What `setInterval` was given. */
export interface StartedInterval {
  readonly fn: () => void;
  readonly ms: number;
  readonly handle: object;
}

export interface FakeTimers {
  readonly timers: Timers;
  /** Every interval that was started, in order. */
  readonly started: StartedInterval[];
  /** The handles that were cleared, in order. */
  readonly cleared: unknown[];
  /** Fires every interval that has not been cleared, `times` times, with no waiting. */
  tick(times?: number): void;
}

/** A clock that never runs by itself: a test turns it, so that no test sleeps. */
export function fakeTimers(): FakeTimers {
  const started: StartedInterval[] = [];
  const cleared: unknown[] = [];
  const timers: Timers = {
    setInterval: (fn, ms) => {
      const handle = {};
      started.push({ fn, ms, handle });
      return handle;
    },
    clearInterval: (handle) => {
      cleared.push(handle);
    },
  };
  const tick = (times = 1): void => {
    for (let i = 0; i < times; i += 1)
      for (const interval of started) if (!cleared.includes(interval.handle)) interval.fn();
  };
  return { timers, started, cleared, tick };
}
