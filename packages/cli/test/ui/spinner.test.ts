import { afterEach, describe, expect, it, vi } from 'vitest';
import { FRAME_MS, startStep } from '../../src/ui/spinner.js';
import { styleFor } from '../../src/ui/style.js';
import { symbolsFor } from '../../src/ui/symbols.js';
import { fakeTerminal, fakeTimers } from '../helpers/fake-terminal.js';

const ESC = '\u001b';
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const CLEAR_LINE = `\r${ESC}[2K`;
const LABEL = 'Installing hooks';

const PLAIN = styleFor({ color: false, color256: false });
const COLOURED = styleFor({ color: true, color256: true });
const ASCII = symbolsFor(false);
const DRAWN = symbolsFor(true);

/** What one turn of the frame writes. */
const frameLine = (frame: string, label = LABEL): string => `${CLEAR_LINE}  ${frame} ${label}`;

describe('a step where nothing can animate', () => {
  it('prints nothing until the step ends', () => {
    const fake = fakeTerminal({ interactive: false });
    const clock = fakeTimers();

    startStep(fake.term, PLAIN, ASCII, LABEL, clock.timers);

    expect(fake.writes).toEqual([]);
  });

  it.each([
    ['succeed', '+'],
    ['fail', 'x'],
    ['skip', '-'],
  ] as const)('leaves exactly one plain line when it is told to %s', (finish, mark) => {
    const fake = fakeTerminal({ interactive: false });
    const step = startStep(fake.term, PLAIN, ASCII, LABEL, fakeTimers().timers);

    step[finish]();

    expect(fake.writes).toEqual([`  ${mark} ${LABEL}\n`]);
  });

  it('puts the text it is given on the line instead of the label', () => {
    const fake = fakeTerminal({ interactive: false });
    const step = startStep(fake.term, PLAIN, ASCII, LABEL, fakeTimers().timers);

    step.succeed('Claude Code  installed');

    expect(fake.out()).toBe('  + Claude Code  installed\n');
  });

  it('writes no escape sequence at all with colour off', () => {
    const fake = fakeTerminal({ interactive: false });
    const step = startStep(fake.term, PLAIN, DRAWN, LABEL, fakeTimers().timers);

    step.succeed();

    expect(fake.out()).not.toContain(ESC);
    expect(fake.out()).not.toContain('\r');
  });

  it('writes only the colour of the mark when colour is on: no cursor, no carriage return', () => {
    const fake = fakeTerminal({ interactive: false });
    const step = startStep(fake.term, COLOURED, ASCII, LABEL, fakeTimers().timers);

    step.succeed();

    expect(fake.out()).toBe(`  ${COLOURED.good('+')} ${LABEL}\n`);
    expect(fake.out()).not.toContain('\r');
    expect(fake.out()).not.toContain('?25');
  });

  it('starts no timer', () => {
    const fake = fakeTerminal({ interactive: false });
    const clock = fakeTimers();

    const step = startStep(fake.term, PLAIN, ASCII, LABEL, clock.timers);
    step.succeed();

    expect(clock.started).toHaveLength(0);
    expect(clock.cleared).toHaveLength(0);
  });

  it('does not listen for the end of the process', () => {
    const fake = fakeTerminal({ interactive: false });
    const before = process.listenerCount('exit');

    const step = startStep(fake.term, PLAIN, ASCII, LABEL, fakeTimers().timers);

    expect(process.listenerCount('exit')).toBe(before);
    step.succeed();
  });

  it('ignores a second finish', () => {
    const fake = fakeTerminal({ interactive: false });
    const step = startStep(fake.term, PLAIN, ASCII, LABEL, fakeTimers().timers);

    step.succeed();
    step.fail('too late');
    step.skip();

    expect(fake.writes).toEqual([`  + ${LABEL}\n`]);
  });
});

describe('a step on a terminal where it animates', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('hides the cursor and draws the first frame at once, before any tick', () => {
    const fake = fakeTerminal({ interactive: true });

    startStep(fake.term, PLAIN, ASCII, LABEL, fakeTimers().timers);

    expect(fake.writes).toEqual([HIDE_CURSOR, frameLine(ASCII.frames[0] ?? '')]);
  });

  it('turns the frame every FRAME_MS, and starts only one timer', () => {
    const fake = fakeTerminal({ interactive: true });
    const clock = fakeTimers();

    startStep(fake.term, PLAIN, ASCII, LABEL, clock.timers);

    expect(clock.started).toHaveLength(1);
    expect(clock.started[0]?.ms).toBe(FRAME_MS);
    expect(FRAME_MS).toBeGreaterThan(0);
  });

  it('draws the next frame on each tick', () => {
    const fake = fakeTerminal({ interactive: true });
    const clock = fakeTimers();
    startStep(fake.term, PLAIN, ASCII, LABEL, clock.timers);

    clock.tick();
    clock.tick();

    expect(fake.writes.slice(1)).toEqual([
      frameLine(ASCII.frames[0] ?? ''),
      frameLine(ASCII.frames[1] ?? ''),
      frameLine(ASCII.frames[2] ?? ''),
    ]);
  });

  it.each([
    ['plain', ASCII],
    ['drawn', DRAWN],
  ])('cycles through the %s frames and starts over', (_name, symbols) => {
    const fake = fakeTerminal({ interactive: true });
    const clock = fakeTimers();
    const turns = symbols.frames.length * 2 + 1;
    startStep(fake.term, PLAIN, symbols, LABEL, clock.timers);

    clock.tick(turns);

    const drawn = fake.writes.slice(1);
    expect(drawn).toHaveLength(turns + 1);
    drawn.forEach((line, i) => {
      expect(line).toBe(frameLine(symbols.frames[i % symbols.frames.length] ?? ''));
    });
  });

  it('clears the line before each frame and never ends it while it spins', () => {
    const fake = fakeTerminal({ interactive: true });
    const clock = fakeTimers();
    startStep(fake.term, PLAIN, ASCII, LABEL, clock.timers);

    clock.tick(6);

    for (const line of fake.writes.slice(1)) {
      expect(line.startsWith(CLEAR_LINE)).toBe(true);
      expect(line).not.toContain('\n');
    }
  });

  it('colours the frame with the accent', () => {
    const fake = fakeTerminal({ interactive: true });

    startStep(fake.term, COLOURED, DRAWN, LABEL, fakeTimers().timers);

    expect(fake.writes[1]).toContain(`${ESC}[38;5;208m${DRAWN.frames[0]}${ESC}[39m`);
  });

  describe('when it ends', () => {
    it('clears the timer it started, once', () => {
      const fake = fakeTerminal({ interactive: true });
      const clock = fakeTimers();
      const step = startStep(fake.term, PLAIN, ASCII, LABEL, clock.timers);

      step.succeed();

      expect(clock.cleared).toEqual([clock.started[0]?.handle]);
    });

    it('replaces the frame with its line and shows the cursor again, in one write', () => {
      const fake = fakeTerminal({ interactive: true });
      const step = startStep(fake.term, PLAIN, ASCII, LABEL, fakeTimers().timers);

      step.succeed();

      expect(fake.writes.at(-1)).toBe(`${CLEAR_LINE}  + ${LABEL}\n${SHOW_CURSOR}`);
    });

    it('uses the label when it is not given a text, and the text when it is', () => {
      const bare = fakeTerminal({ interactive: true });
      const texted = fakeTerminal({ interactive: true });

      startStep(bare.term, PLAIN, ASCII, LABEL, fakeTimers().timers).succeed();
      startStep(texted.term, PLAIN, ASCII, LABEL, fakeTimers().timers).succeed('all done');

      expect(bare.writes.at(-1)).toBe(`${CLEAR_LINE}  + ${LABEL}\n${SHOW_CURSOR}`);
      expect(texted.writes.at(-1)).toBe(`${CLEAR_LINE}  + all done\n${SHOW_CURSOR}`);
    });

    it.each([
      ['fail', 'x'],
      ['skip', '-'],
    ] as const)('marks %s with %s, and shows the cursor again', (finish, mark) => {
      const fake = fakeTerminal({ interactive: true });
      const step = startStep(fake.term, PLAIN, ASCII, LABEL, fakeTimers().timers);

      step[finish]('the text');

      expect(fake.writes.at(-1)).toBe(`${CLEAR_LINE}  ${mark} the text\n${SHOW_CURSOR}`);
    });

    it('marks fail and skip with the bad mark and the dash when it is not told what to say', () => {
      const failed = fakeTerminal({ interactive: true });
      const skipped = fakeTerminal({ interactive: true });

      startStep(failed.term, PLAIN, DRAWN, LABEL, fakeTimers().timers).fail();
      startStep(skipped.term, PLAIN, DRAWN, LABEL, fakeTimers().timers).skip();

      expect(failed.writes.at(-1)).toBe(`${CLEAR_LINE}  ✘ ${LABEL}\n${SHOW_CURSOR}`);
      expect(skipped.writes.at(-1)).toBe(`${CLEAR_LINE}  – ${LABEL}\n${SHOW_CURSOR}`);
    });

    it('colours the mark: green for success, red for failure, dim for nothing', () => {
      const ok = fakeTerminal({ interactive: true });
      const bad = fakeTerminal({ interactive: true });
      const none = fakeTerminal({ interactive: true });

      startStep(ok.term, COLOURED, ASCII, LABEL, fakeTimers().timers).succeed();
      startStep(bad.term, COLOURED, ASCII, LABEL, fakeTimers().timers).fail();
      startStep(none.term, COLOURED, ASCII, LABEL, fakeTimers().timers).skip();

      expect(ok.writes.at(-1)).toContain(`${ESC}[32m+${ESC}[39m`);
      expect(bad.writes.at(-1)).toContain(`${ESC}[31mx${ESC}[39m`);
      expect(none.writes.at(-1)).toContain(`${ESC}[2m-${ESC}[22m`);
    });

    it('draws no more frames after it', () => {
      const fake = fakeTerminal({ interactive: true });
      const clock = fakeTimers();
      const step = startStep(fake.term, PLAIN, ASCII, LABEL, clock.timers);
      step.succeed();
      const written = fake.writes.length;

      clock.tick(5);

      expect(fake.writes).toHaveLength(written);
    });

    it('ignores a second finish: one line, one clear, one show of the cursor', () => {
      const fake = fakeTerminal({ interactive: true });
      const clock = fakeTimers();
      const step = startStep(fake.term, PLAIN, ASCII, LABEL, clock.timers);

      step.succeed();
      step.fail('too late');
      step.skip();
      step.succeed('again');

      expect(clock.cleared).toHaveLength(1);
      expect(fake.out().split(SHOW_CURSOR)).toHaveLength(2);
      expect(fake.out().split('\n')).toHaveLength(2);
      expect(fake.out()).not.toContain('too late');
    });
  });

  describe('the end of the process', () => {
    it('is listened for while the cursor is hidden, and no longer after the step ends', () => {
      const fake = fakeTerminal({ interactive: true });
      const before = process.listenerCount('exit');

      const step = startStep(fake.term, PLAIN, ASCII, LABEL, fakeTimers().timers);
      const during = process.listenerCount('exit');
      step.succeed();

      expect(during).toBe(before + 1);
      expect(process.listenerCount('exit')).toBe(before);
    });

    it('restores the cursor if the process is left in the middle of a step', () => {
      const fake = fakeTerminal({ interactive: true });
      const known = new Set<unknown>(process.listeners('exit'));
      const step = startStep(fake.term, PLAIN, ASCII, LABEL, fakeTimers().timers);
      const added = process.listeners('exit').filter((listener) => !known.has(listener));
      const written = fake.writes.length;

      added[0]?.(0);

      expect(added).toHaveLength(1);
      expect(fake.writes.slice(written)).toEqual([SHOW_CURSOR]);
      step.succeed();
    });

    // A signal ends the process without an `exit` event, and a cursor that was hidden stays hidden.
    it.each(['SIGINT', 'SIGTERM'] as const)(
      'restores the cursor and raises %s again when the process is interrupted in a step',
      (signal) => {
        const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
        const fake = fakeTerminal({ interactive: true });
        const known = new Set<unknown>(process.listeners(signal));
        const step = startStep(fake.term, PLAIN, ASCII, LABEL, fakeTimers().timers);
        const added = process.listeners(signal).filter((listener) => !known.has(listener));
        const written = fake.writes.length;

        // The listener is called directly: emitting the signal would reach every listener there is.
        (added[0] as () => void)();

        expect(added).toHaveLength(1);
        expect(fake.writes.slice(written)).toEqual([SHOW_CURSOR]);
        expect(kill).toHaveBeenCalledWith(process.pid, signal);
        step.succeed();
        kill.mockRestore();
      },
    );

    it('does not listen for signals once the step has ended, or in a step that does not animate', () => {
      const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];

      const animated = startStep(
        fakeTerminal({ interactive: true }).term,
        PLAIN,
        ASCII,
        LABEL,
        fakeTimers().timers,
      );
      expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual([
        (before[0] as number) + 1,
        (before[1] as number) + 1,
      ]);
      animated.succeed();
      startStep(fakeTerminal({ interactive: false }).term, PLAIN, ASCII, LABEL).succeed();

      expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(before);
    });

    it('does not leave listeners behind when many steps run one after another', () => {
      const fake = fakeTerminal({ interactive: true });
      const before = process.listenerCount('exit');

      for (let i = 0; i < 15; i += 1)
        startStep(fake.term, PLAIN, ASCII, LABEL, fakeTimers().timers).succeed();

      expect(process.listenerCount('exit')).toBe(before);
    });
  });

  describe('where glyphs cannot be drawn', () => {
    it('writes ASCII only: the frames, the marks and the cursor sequences', () => {
      const fake = fakeTerminal({ interactive: true, unicode: false });
      const clock = fakeTimers();
      const step = startStep(fake.term, PLAIN, symbolsFor(fake.term.unicode), LABEL, clock.timers);

      clock.tick(8);
      step.succeed();

      expect(fake.out()).toMatch(/^[\x00-\x7f]*$/);
    });

    it('draws braille frames where they can be drawn', () => {
      const fake = fakeTerminal({ interactive: true, unicode: true });

      startStep(fake.term, PLAIN, symbolsFor(fake.term.unicode), LABEL, fakeTimers().timers);

      expect(fake.writes[1]).toContain('⠋');
    });
  });

  describe('on the real clock', () => {
    it('turns the frame every FRAME_MS when it is given no timers, and stops when it ends', () => {
      vi.useFakeTimers();
      const fake = fakeTerminal({ interactive: true });
      const step = startStep(fake.term, PLAIN, ASCII, LABEL);

      vi.advanceTimersByTime(FRAME_MS * 3);
      const spinning = fake.writes.length;
      step.succeed();
      const ended = fake.writes.length;
      vi.advanceTimersByTime(FRAME_MS * 5);

      // The hidden cursor and the first frame, then three turns.
      expect(spinning).toBe(2 + 3);
      expect(ended).toBe(spinning + 1);
      expect(fake.writes).toHaveLength(ended);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it('draws a blank, not "undefined", for a symbol set that has no frames', () => {
    const fake = fakeTerminal({ interactive: true });

    startStep(fake.term, PLAIN, { ...ASCII, frames: [] }, LABEL, fakeTimers().timers);

    expect(fake.out()).not.toContain('undefined');
    expect(fake.writes[1]).toBe(`${CLEAR_LINE}   ${LABEL}`);
  });
});
