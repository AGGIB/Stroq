import { describe, expect, it } from 'vitest';
import { mascotPlan, type MascotFacts, type MascotFlags } from '../../../src/ui/mascot/play.js';

type Env = Readonly<Record<string, string | undefined>>;

/** A person at a colour terminal that draws UTF-8, in a world with nothing set. */
const TERMINAL: MascotFacts = { stdoutIsTTY: true, color: true, unicode: true };

const planFor = (
  env: Env = {},
  options: { facts?: Partial<MascotFacts>; flags?: MascotFlags; greeted?: boolean } = {},
) =>
  mascotPlan({ ...TERMINAL, ...options.facts }, env, options.flags ?? {}, options.greeted ?? false);

describe('mascotPlan: a person at a terminal, the first time', () => {
  it('animates, in 16 colours when the terminal does not say it has more', () => {
    expect(planFor()).toEqual({ kind: 'animate', colorMode: 'ansi16' });
  });

  it.each(['truecolor', '24bit', 'TrueColor', '24BIT'])(
    'animates in 24-bit colour when COLORTERM is %s',
    (colorterm) => {
      expect(planFor({ COLORTERM: colorterm })).toEqual({
        kind: 'animate',
        colorMode: 'truecolor',
      });
    },
  );

  it.each(['', '256color', 'yes', '1'])('stays at 16 colours when COLORTERM is %j', (colorterm) => {
    expect(planFor({ COLORTERM: colorterm }).colorMode).toBe('ansi16');
  });

  it('does not look at TERM for colour depth: only COLORTERM says truecolor', () => {
    expect(planFor({ TERM: 'xterm-direct' }).colorMode).toBe('ansi16');
    expect(planFor({ TERM: 'xterm-256color' }).colorMode).toBe('ansi16');
  });
});

describe('mascotPlan: none (screen readers and plain output)', () => {
  const NONE = { kind: 'none', colorMode: 'none' } as const;

  it('draws nothing when standard output is not a terminal', () => {
    expect(planFor({}, { facts: { stdoutIsTTY: false } })).toEqual(NONE);
    expect(planFor({ COLORTERM: 'truecolor' }, { facts: { stdoutIsTTY: false } })).toEqual(NONE);
  });

  it('draws nothing when NO_COLOR is set to anything but empty', () => {
    expect(planFor({ NO_COLOR: '1' })).toEqual(NONE);
    expect(planFor({ NO_COLOR: 'anything' })).toEqual(NONE);
    expect(planFor({ NO_COLOR: '0' })).toEqual(NONE);
    expect(planFor({ NO_COLOR: '' }).kind).toBe('animate');
  });

  it('draws nothing when TERM is dumb', () => {
    expect(planFor({ TERM: 'dumb' })).toEqual(NONE);
    expect(planFor({ TERM: 'xterm' }).kind).toBe('animate');
  });

  it('draws nothing when the terminal facts say no colour (FORCE_COLOR=0, say)', () => {
    expect(planFor({}, { facts: { color: false } })).toEqual(NONE);
  });

  it('draws nothing where the half blocks would not show (no UTF-8)', () => {
    expect(planFor({}, { facts: { unicode: false } })).toEqual(NONE);
  });

  it.each(['1', 'true', 'yes', 'on'])('draws nothing when STROQ_NO_MASCOT is %s', (value) => {
    expect(planFor({ STROQ_NO_MASCOT: value })).toEqual(NONE);
  });

  it.each([undefined, '', '0', 'false', 'FALSE'])(
    'draws on when STROQ_NO_MASCOT is %j',
    (value) => {
      expect(planFor({ STROQ_NO_MASCOT: value }).kind).toBe('animate');
    },
  );

  it('draws nothing when the caller asks for plain output', () => {
    expect(planFor({}, { flags: { plain: true } })).toEqual(NONE);
    expect(planFor({}, { flags: { plain: false } }).kind).toBe('animate');
  });

  it('wins over every reason to draw a still frame', () => {
    expect(planFor({ CI: '1' }, { facts: { stdoutIsTTY: false } })).toEqual(NONE);
    expect(planFor({ NO_COLOR: '1' }, { greeted: true })).toEqual(NONE);
    expect(planFor({ STROQ_NO_ANIMATION: '1', TERM: 'dumb' })).toEqual(NONE);
    expect(planFor({}, { flags: { plain: true, noAnimation: true }, greeted: true })).toEqual(NONE);
  });
});

describe('mascotPlan: still (one frame, no animation)', () => {
  it.each(['1', 'true', 'yes', 'TRUE', 'github'])('shows one frame when CI is %s', (ci) => {
    expect(planFor({ CI: ci })).toEqual({ kind: 'still', colorMode: 'ansi16' });
  });

  it.each([undefined, '', '0', 'false'])('animates when CI is %j', (ci) => {
    expect(planFor({ CI: ci }).kind).toBe('animate');
  });

  it('shows one frame when STROQ_NO_ANIMATION is on, and not when it is off', () => {
    expect(planFor({ STROQ_NO_ANIMATION: '1' }).kind).toBe('still');
    expect(planFor({ STROQ_NO_ANIMATION: 'true' }).kind).toBe('still');
    expect(planFor({ STROQ_NO_ANIMATION: '0' }).kind).toBe('animate');
    expect(planFor({ STROQ_NO_ANIMATION: '' }).kind).toBe('animate');
  });

  it('shows one frame for --no-animation', () => {
    expect(planFor({}, { flags: { noAnimation: true } }).kind).toBe('still');
    expect(planFor({}, { flags: { noAnimation: false } }).kind).toBe('animate');
  });

  it('shows one frame to someone who has been greeted before', () => {
    expect(planFor({}, { greeted: true }).kind).toBe('still');
  });

  it('keeps the colour depth the terminal has', () => {
    expect(planFor({ CI: '1', COLORTERM: 'truecolor' })).toEqual({
      kind: 'still',
      colorMode: 'truecolor',
    });
    expect(planFor({}, { greeted: true, flags: { noAnimation: true } }).colorMode).toBe('ansi16');
  });
});

describe('mascotPlan: the whole matrix', () => {
  const tty = [true, false];
  const noColor = [undefined, '1'];
  const term = [undefined, 'dumb', 'xterm-256color'];
  const ci = [undefined, '', '0', 'false', '1', 'true'];
  const noMascot = [undefined, '1'];
  const noAnimation = [undefined, '1'];
  const flagNoAnimation = [false, true];
  const plain = [false, true];
  const greeted = [false, true];
  const colorterm = [undefined, 'truecolor'];

  it('follows the rules in the order none, still, animate, for every combination', () => {
    let combinations = 0;
    for (const isTty of tty)
      for (const nc of noColor)
        for (const t of term)
          for (const c of ci)
            for (const nm of noMascot)
              for (const na of noAnimation)
                for (const fna of flagNoAnimation)
                  for (const p of plain)
                    for (const g of greeted)
                      for (const ct of colorterm) {
                        const env: Env = {
                          NO_COLOR: nc,
                          TERM: t,
                          CI: c,
                          STROQ_NO_MASCOT: nm,
                          STROQ_NO_ANIMATION: na,
                          COLORTERM: ct,
                        };
                        const none = !isTty || nc !== undefined || t === 'dumb' || nm === '1' || p;
                        const ciOn = c === '1' || c === 'true';
                        const still = ciOn || na === '1' || fna || g;
                        const plan = planFor(env, {
                          facts: { stdoutIsTTY: isTty },
                          flags: { plain: p, noAnimation: fna },
                          greeted: g,
                        });

                        const expected = none
                          ? { kind: 'none', colorMode: 'none' }
                          : {
                              kind: still ? 'still' : 'animate',
                              colorMode: ct === 'truecolor' ? 'truecolor' : 'ansi16',
                            };
                        expect(plan, JSON.stringify({ isTty, env, p, fna, g })).toEqual(expected);
                        combinations += 1;
                      }

    expect(combinations).toBe(2 * 2 * 3 * 6 * 2 * 2 * 2 * 2 * 2 * 2);
  });
});

describe('mascotPlan: purity', () => {
  it('does not read the process environment: only the env it is given', () => {
    const before = process.env['NO_COLOR'];
    process.env['NO_COLOR'] = '1';
    try {
      expect(planFor({}).kind).toBe('animate');
    } finally {
      if (before === undefined) delete process.env['NO_COLOR'];
      else process.env['NO_COLOR'] = before;
    }
  });

  it('accepts frozen inputs and does not change them', () => {
    const facts = Object.freeze({ ...TERMINAL });
    const env = Object.freeze({ COLORTERM: 'truecolor' });
    const flags = Object.freeze({ plain: false });

    expect(() => mascotPlan(facts, env, flags, false)).not.toThrow();
    expect(mascotPlan(facts, env, flags, false)).toEqual(mascotPlan(facts, env, flags, false));
  });
});
