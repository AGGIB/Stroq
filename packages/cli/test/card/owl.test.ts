import { describe, expect, it, vi } from 'vitest';
import { owlFrame, printCardWithOwl, type OwlWorld } from '../../src/card/owl.js';
import { card, moment } from './fixtures.js';

const LINES = ['Hoo checked 30 days of your agent sessions', '', '  12  commands your agent ran'];

/** A terminal as a test says it is; what was written is kept in `text` and `drawn`. */
function world(over: Partial<OwlWorld> = {}) {
  const text: string[] = [];
  const drawn: string[] = [];
  const marks: number[] = [];
  const play = vi.fn<OwlWorld['play']>(async () => 'finished' as const);
  const w: OwlWorld = {
    stdoutIsTTY: true,
    columns: 120,
    color: true,
    unicode: true,
    env: { COLORTERM: 'truecolor' },
    greetedBefore: () => false,
    markGreeted: () => {
      marks.push(1);
    },
    writeText: (t) => {
      text.push(t);
    },
    writeDrawn: (t) => {
      drawn.push(t);
    },
    play,
    ...over,
  };
  return { w, text, drawn, marks, play };
}

const strip = (s: string): string => s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');

describe('owlFrame', () => {
  it('stands idle when there was nothing to read', () => {
    expect(owlFrame(card({ coverage: { ...card().coverage, found: 0 } }))).toBe('idle');
  });
  it('looks alert when there is something worth a look, and happy when there is not', () => {
    expect(owlFrame(card({ moments: [moment(1)] }))).toBe('alert');
    expect(owlFrame(card())).toBe('happy');
  });
});

describe('printCardWithOwl', () => {
  it('prints the text alone, through the filter, when standard output is not a terminal', async () => {
    const t = world({ stdoutIsTTY: false });
    await printCardWithOwl(LINES, 'happy', {}, t.w);
    expect(t.text).toEqual([`${LINES.join('\n')}\n`]);
    expect(t.drawn).toEqual([]);
    expect(t.play).not.toHaveBeenCalled();
  });

  it('prints the text alone for --plain, NO_COLOR and STROQ_NO_MASCOT', async () => {
    for (const [flags, env] of [
      [{ plain: true }, { COLORTERM: 'truecolor' }],
      [{}, { NO_COLOR: '1' }],
      [{}, { STROQ_NO_MASCOT: '1' }],
    ] as const) {
      const t = world({ env });
      await printCardWithOwl(LINES, 'happy', flags, t.w);
      expect(t.text).toEqual([`${LINES.join('\n')}\n`]);
      expect(t.drawn).toEqual([]);
    }
  });

  it('plays the greeting once, ending on the result frame, and writes down that it was played', async () => {
    const t = world();
    await printCardWithOwl(LINES, 'alert', {}, t.w);
    expect(t.play).toHaveBeenCalledTimes(1);
    const options = t.play.mock.calls[0]?.[0];
    expect(options).toMatchObject({
      colorMode: 'truecolor',
      textLines: LINES,
      finalFrame: 'alert',
      columns: 120,
    });
    options?.onFinished?.();
    expect(t.marks).toEqual([1]);
  });

  it('draws one still frame after the first greeting, in CI and with --no-animation', async () => {
    for (const over of [
      { greetedBefore: () => true },
      { env: { COLORTERM: 'truecolor', CI: 'true' } },
    ] as const) {
      const t = world(over);
      await printCardWithOwl(LINES, 'happy', {}, t.w);
      expect(t.play).not.toHaveBeenCalled();
      expect(t.drawn).toHaveLength(1);
      expect(strip(t.drawn[0] ?? '')).toContain(LINES[0]);
    }
    const t = world();
    await printCardWithOwl(LINES, 'happy', { noAnimation: true }, t.w);
    expect(t.play).not.toHaveBeenCalled();
    expect(t.drawn).toHaveLength(1);
  });

  it('puts the owl above the text on a terminal too narrow for both side by side', async () => {
    const t = world({ columns: 50 });
    await printCardWithOwl(LINES, 'happy', {}, t.w);
    expect(t.play).not.toHaveBeenCalled();
    expect(t.drawn).toHaveLength(1);
    expect(strip(t.drawn[0] ?? '')).not.toContain(LINES[0]);
    expect(t.text).toEqual([`${LINES.join('\n')}\n`]);
  });

  it('fits a full card beside the owl in 80 columns', async () => {
    const wide = ['x'.repeat(55)];
    const t = world({ columns: 80, greetedBefore: () => true });
    await printCardWithOwl(wide, 'happy', {}, t.w);
    expect(t.text).toEqual([]);
    expect(
      Math.max(
        ...strip(t.drawn[0] ?? '')
          .split('\n')
          .map((l) => l.length),
      ),
    ).toBeLessThanOrEqual(80);
  });
});
