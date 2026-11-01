import { afterEach, describe, expect, it, vi } from 'vitest';
import { onInterrupt, runInterruptCleanups } from '../../../src/ui/cleanup.js';
import { abortableSleep, playGreeting, type PlayOptions } from '../../../src/ui/mascot/play.js';
import { renderCard, visibleWidth } from '../../../src/ui/mascot/render.js';
import { GREETING, GREETING_MAX_MS, totalMs } from '../../../src/ui/mascot/sprites.js';

const HIDE_CURSOR = '\u001b[?25l';
const SHOW_CURSOR = '\u001b[?25h';
const UP_10 = '\u001b[10A';
const TEXT = ['Hoo . stroq', 'I looked at your sessions.'];

const abortError = (): Error => Object.assign(new Error('aborted'), { name: 'AbortError' });

/** Everything playGreeting touches, made by hand: no stream, no timer, no waiting. */
interface Harness {
  readonly writes: string[];
  readonly sleeps: number[];
  readonly events: string[];
  readonly options: PlayOptions;
}

interface HarnessOptions {
  /** Throws on the write with this index (0 is the first), once. */
  readonly failWrite?: number;
  /** Throws on every write once the cursor-showing write is attempted after this index. */
  readonly failEverythingFrom?: number;
  /** Aborts this signal when the sleep with this index (0 is the first) starts. */
  readonly abortAt?: { readonly sleep: number; readonly controller: AbortController };
  /** Sleeps that never end, until the signal aborts. */
  readonly hang?: boolean;
  readonly extra?: Partial<PlayOptions>;
}

function harness(config: HarnessOptions = {}): Harness {
  const writes: string[] = [];
  const sleeps: number[] = [];
  const events: string[] = [];
  let failed = false;
  const write = (text: string): void => {
    const index = writes.length;
    writes.push(text);
    if (config.failWrite === index && !failed) {
      failed = true;
      throw new Error('EPIPE: the terminal went away');
    }
    if (config.failEverythingFrom !== undefined && index >= config.failEverythingFrom) {
      throw new Error('EPIPE: the terminal is gone');
    }
  };
  const sleep = async (ms: number, signal: AbortSignal): Promise<void> => {
    const index = sleeps.length;
    sleeps.push(ms);
    if (config.abortAt?.sleep === index) config.abortAt.controller.abort();
    if (config.hang === true) {
      await new Promise<void>((_, reject) => {
        if (signal.aborted) reject(abortError());
        signal.addEventListener('abort', () => reject(abortError()), { once: true });
      });
    }
    await Promise.resolve();
    if (signal.aborted) throw abortError();
  };
  const options: PlayOptions = {
    colorMode: 'truecolor',
    textLines: TEXT,
    write,
    sleep,
    onFinished: () => events.push('finished'),
    ...config.extra,
  };
  return { writes, sleeps, events, options };
}

const listeners = (): Record<string, number> => ({
  SIGINT: process.listenerCount('SIGINT'),
  SIGTERM: process.listenerCount('SIGTERM'),
  SIGHUP: process.listenerCount('SIGHUP'),
  exit: process.listenerCount('exit'),
});

afterEach(() => {
  vi.restoreAllMocks();
  runInterruptCleanups();
});

describe('playGreeting: a greeting that runs to the end', () => {
  it('hides the cursor, draws the six frames in place, and shows the cursor again', async () => {
    const { writes, options } = harness();

    const outcome = await playGreeting(options);

    expect(outcome).toBe('finished');
    // hide, then six frames, then show.
    expect(writes).toHaveLength(1 + GREETING.length + 1);
    expect(writes[0]).toBe(HIDE_CURSOR);
    expect(writes.at(-1)).toBe(SHOW_CURSOR);
    // The first frame is drawn where the cursor is; each later one goes back up over it first.
    expect(writes[1]?.startsWith(UP_10)).toBe(false);
    for (const frame of writes.slice(2, -1)) expect(frame.startsWith(UP_10)).toBe(true);
  });

  it('draws the frames of the greeting in order, on the card', async () => {
    const { writes, options } = harness();

    await playGreeting(options);

    GREETING.forEach((beat, i) => {
      const card = renderCard(beat.frame, { colorMode: 'truecolor', textLines: TEXT }).join('\n');
      expect(writes[1 + i]?.replace(UP_10, '')).toBe(`${card}\n`);
    });
  });

  it('waits the milliseconds of the greeting, 1.35 seconds in all and never more than 1.5', async () => {
    const { sleeps, options } = harness();

    await playGreeting(options);

    expect(sleeps).toEqual(GREETING.map((beat) => beat.ms));
    const total = sleeps.reduce((sum, ms) => sum + ms, 0);
    expect(total).toBe(totalMs(GREETING));
    expect(total).toBeLessThanOrEqual(GREETING_MAX_MS);
    expect(total).toBeLessThanOrEqual(1500);
  });

  it('tells the caller it finished only after the cursor is back', async () => {
    const { events, writes, options } = harness({
      extra: {
        write: (text) => {
          events.push(text === SHOW_CURSOR ? 'show' : text === HIDE_CURSOR ? 'hide' : 'frame');
          writes.push(text);
        },
      },
    });

    await playGreeting(options);

    expect(events.at(-2)).toBe('show');
    expect(events.at(-1)).toBe('finished');
    expect(events.filter((event) => event === 'finished')).toHaveLength(1);
  });

  it('works in 16 colours, and moves up by as many lines as the card has', async () => {
    const tall = Array.from({ length: 13 }, (_, i) => `line ${i}`);
    const { writes, options } = harness({ extra: { colorMode: 'ansi16', textLines: tall } });

    await playGreeting(options);

    expect(writes[2]?.startsWith('\u001b[13A')).toBe(true);
    expect(writes[1]?.split('\n')).toHaveLength(13 + 1);
  });

  it('listens for signals only while it plays', async () => {
    const before = listeners();
    const { options } = harness();

    const playing = playGreeting(options);
    expect(listeners()).toEqual({
      SIGINT: before['SIGINT']! + 1,
      SIGTERM: before['SIGTERM']! + 1,
      SIGHUP: before['SIGHUP']! + 1,
      exit: before['exit']! + 1,
    });
    await playing;

    expect(listeners()).toEqual(before);
  });
});

describe('playGreeting: the cursor comes back whatever happens', () => {
  it('shows it after an error while drawing, and passes the error on', async () => {
    const { writes, options } = harness({ failWrite: 3 });
    const before = listeners();

    await expect(playGreeting(options)).rejects.toThrow('EPIPE: the terminal went away');

    expect(writes.at(-1)).toBe(SHOW_CURSOR);
    expect(writes.filter((text) => text === SHOW_CURSOR)).toHaveLength(1);
    expect(listeners()).toEqual(before);
  });

  it('does not tell the caller it finished when drawing failed', async () => {
    const { events, options } = harness({ failWrite: 2 });

    await expect(playGreeting(options)).rejects.toThrow('EPIPE');

    expect(events).toEqual([]);
  });

  it('passes on the error that started it, and not the one from showing the cursor, when the stream is gone', async () => {
    const { writes, options } = harness({ failEverythingFrom: 2 });

    await expect(playGreeting(options)).rejects.toThrow('EPIPE: the terminal is gone');

    expect(writes.at(-1)).toBe(SHOW_CURSOR);
  });

  it('does not hide the cursor again, or draw more, once it was interrupted', async () => {
    const controller = new AbortController();
    const { writes, sleeps, events, options } = harness({
      abortAt: { sleep: 2, controller },
      extra: { signal: controller.signal },
    });

    const outcome = await playGreeting(options);

    expect(outcome).toBe('interrupted');
    expect(sleeps).toHaveLength(3);
    expect(writes).toHaveLength(1 + 3 + 1);
    expect(writes.at(-1)).toBe(SHOW_CURSOR);
    expect(events).toEqual([]);
  });

  it('draws nothing, and hides nothing, when it is told to stop before it starts', async () => {
    const controller = new AbortController();
    controller.abort();
    const { writes, sleeps, events, options } = harness({ extra: { signal: controller.signal } });

    const outcome = await playGreeting(options);

    expect(outcome).toBe('interrupted');
    expect(writes).toEqual([]);
    expect(sleeps).toEqual([]);
    expect(events).toEqual([]);
  });

  it('shows the cursor if the process exits while the greeting plays', async () => {
    const known = new Set<unknown>(process.listeners('exit'));
    const controller = new AbortController();
    const { writes, options } = harness({ hang: true, extra: { signal: controller.signal } });

    const playing = playGreeting(options);
    const added = process.listeners('exit').filter((listener) => !known.has(listener));
    const written = writes.length;
    (added[0] as () => void)();

    expect(added).toHaveLength(1);
    expect(writes.slice(written)).toEqual([SHOW_CURSOR]);
    controller.abort();
    await expect(playing).resolves.toBe('interrupted');
    expect(writes.filter((text) => text === SHOW_CURSOR)).toHaveLength(1);
  });

  describe.each(['SIGINT', 'SIGTERM', 'SIGHUP'] as const)('when %s ends the process', (signal) => {
    it('shows the cursor, runs what is registered to be undone, and raises the signal again', async () => {
      const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
      const undo = vi.fn();
      onInterrupt(undo);
      const known = new Set<unknown>(process.listeners(signal));
      const { writes, options } = harness({ hang: true });
      const before = listeners();

      const playing = playGreeting(options);
      const added = process.listeners(signal).filter((listener) => !known.has(listener));
      const written = writes.length;
      // Called directly: emitting the signal would reach every listener there is.
      (added[0] as () => void)();

      expect(added).toHaveLength(1);
      expect(writes.slice(written)).toEqual([SHOW_CURSOR]);
      expect(undo).toHaveBeenCalledTimes(1);
      expect(kill).toHaveBeenCalledWith(process.pid, signal);
      await expect(playing).resolves.toBe('interrupted');
      // The loop stopped at once, and the cursor was shown once.
      expect(writes.filter((text) => text === SHOW_CURSOR)).toHaveLength(1);
      expect(writes.filter((text) => text.startsWith(UP_10))).toHaveLength(0);
      expect(listeners()).toEqual(before);
    });
  });

  it.skipIf(process.platform === 'win32')(
    'exits with 131 and does not raise the signal when Ctrl-\\ ends it',
    async () => {
      const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
      const known = new Set<unknown>(process.listeners('SIGQUIT'));
      const { writes, options } = harness({ hang: true });

      const playing = playGreeting(options);
      const added = process.listeners('SIGQUIT').filter((listener) => !known.has(listener));
      const written = writes.length;
      (added[0] as () => void)();

      expect(writes.slice(written)).toEqual([SHOW_CURSOR]);
      expect(exit).toHaveBeenCalledWith(131);
      expect(kill).not.toHaveBeenCalled();
      await expect(playing).resolves.toBe('interrupted');
    },
  );
});

describe('playGreeting: a card that does not fit', () => {
  it('draws one still frame, without moving the cursor, when a line is wider than the terminal', async () => {
    const { writes, sleeps, events, options } = harness({ extra: { columns: 30 } });

    const outcome = await playGreeting(options);

    expect(outcome).toBe('still');
    expect(writes).toHaveLength(1);
    expect(writes[0]).not.toContain(HIDE_CURSOR);
    expect(writes[0]).not.toContain('\u001b[10A');
    expect(writes[0]?.endsWith('\n')).toBe(true);
    expect(sleeps).toEqual([]);
    expect(events).toEqual([]);
  });

  it('animates when the widest line fits exactly', async () => {
    const width = Math.max(
      ...renderCard('idle', { colorMode: 'truecolor', textLines: TEXT }).map(visibleWidth),
    );
    const { options } = harness({ extra: { columns: width } });

    await expect(playGreeting(options)).resolves.toBe('finished');
  });

  it('animates when it is not told how wide the terminal is', async () => {
    const { options } = harness({ extra: { textLines: ['x'.repeat(500)] } });

    await expect(playGreeting(options)).resolves.toBe('finished');
  });
});

describe('abortableSleep', () => {
  it('waits for the time given, a few milliseconds', async () => {
    const started = performance.now();

    await abortableSleep(5, new AbortController().signal);

    expect(performance.now() - started).toBeGreaterThanOrEqual(3);
  });

  it('stops with an AbortError when the signal aborts, and does not wait for the rest', async () => {
    const controller = new AbortController();
    const sleeping = abortableSleep(60_000, controller.signal);

    controller.abort();

    await expect(sleeping).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('stops at once when the signal had aborted already', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(abortableSleep(60_000, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});
