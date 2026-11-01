import { describe, expect, it } from 'vitest';
import {
  ANSI16_REFERENCE,
  ansi16Code,
  ansi256Rgb,
  hexToRgb,
  nearestAnsi16,
  nearestAnsi256,
} from '../../../src/ui/mascot/color.js';
import { PALETTE_KEYS, PALETTES } from '../../../src/ui/mascot/sprites.js';

const toHex = (rgb: readonly [number, number, number]): string =>
  `#${rgb.map((part) => part.toString(16).padStart(2, '0')).join('')}`;

describe('hexToRgb', () => {
  it('reads #rrggbb in either case', () => {
    expect(hexToRgb('#fe4813')).toEqual([254, 72, 19]);
    expect(hexToRgb('#FE4813')).toEqual([254, 72, 19]);
    expect(hexToRgb('#000000')).toEqual([0, 0, 0]);
  });

  it.each(['fe4813', '#fe481', '#fe48133', '#gg0000', 'red', '', '#fe4813; fill:red'])(
    'refuses %j, because the colour ends up in SVG and in escape sequences',
    (text) => {
      expect(() => hexToRgb(text)).toThrow(RangeError);
    },
  );
});

describe('the 16 basic colours', () => {
  it('are the xterm defaults, in the order of the SGR codes: 8 normal, then 8 bright', () => {
    expect(ANSI16_REFERENCE).toHaveLength(16);
    expect(ANSI16_REFERENCE[0]).toEqual([0, 0, 0]);
    expect(ANSI16_REFERENCE[1]).toEqual([205, 0, 0]);
    expect(ANSI16_REFERENCE[7]).toEqual([229, 229, 229]);
    expect(ANSI16_REFERENCE[8]).toEqual([127, 127, 127]);
    expect(ANSI16_REFERENCE[9]).toEqual([255, 0, 0]);
    expect(ANSI16_REFERENCE[15]).toEqual([255, 255, 255]);
  });

  it('are sent with the SGR codes 30-37 and 90-97, and 40-47 and 100-107 behind them', () => {
    expect([0, 1, 7].map((index) => ansi16Code(index, 'fg'))).toEqual([30, 31, 37]);
    expect([8, 9, 15].map((index) => ansi16Code(index, 'fg'))).toEqual([90, 91, 97]);
    expect([0, 1, 7].map((index) => ansi16Code(index, 'bg'))).toEqual([40, 41, 47]);
    expect([8, 9, 15].map((index) => ansi16Code(index, 'bg'))).toEqual([100, 101, 107]);
  });
});

describe('nearestAnsi16', () => {
  it('gives each of the 16 colours back for its own value', () => {
    ANSI16_REFERENCE.forEach((rgb, index) => {
      expect(nearestAnsi16(toHex(rgb))).toBe(index);
    });
  });

  it('is deterministic: the same colour gives the same answer every time', () => {
    for (const key of PALETTE_KEYS) {
      const colour = PALETTES.orange[key];
      expect(nearestAnsi16(colour)).toBe(nearestAnsi16(colour));
    }
  });

  it('breaks a tie towards the lower index', () => {
    // (242,242,242) is as far from white (229) as from bright white (255).
    expect(nearestAnsi16('#f2f2f2')).toBe(7);
  });

  it('keeps a grey among the greys and a colour among the colours', () => {
    // Plain distance would turn the light orange of the wing edge into the grey 8.
    expect(nearestAnsi16('#ff7a4d')).not.toBe(8);
    expect(nearestAnsi16('#565a64')).toBe(8);
    expect(nearestAnsi16('#3a3d45')).toBe(0);
    expect(nearestAnsi16('#0d0e10')).toBe(0);
  });

  it('maps the orange palette the way the documentation says', () => {
    const mapped = Object.fromEntries(
      PALETTE_KEYS.map((key) => [key, nearestAnsi16(PALETTES.orange[key])]),
    );

    expect(mapped).toEqual({
      K: 0, // outline: black
      B: 9, // body: bright red, the nearest hue to the brand orange
      L: 3, // wing edge: yellow, the nearest chromatic colour to light orange
      C: 1, // belly marks: red
      W: 7, // face disc: white
      O: 0, // iris: black
      P: 0, // pupil: black
      H: 15, // eye highlight: bright white
      Y: 3, // beak: yellow
      y: 3, // beak shade: yellow
      F: 3, // feet: yellow
    });
  });

  it('maps the graphite palette the way the documentation says', () => {
    const mapped = Object.fromEntries(
      PALETTE_KEYS.map((key) => [key, nearestAnsi16(PALETTES.graphite[key])]),
    );

    expect(mapped).toMatchObject({ K: 0, B: 0, L: 8, C: 8, W: 7, H: 15, F: 9 });
  });
});

describe('the xterm 256-colour palette', () => {
  it('is the 6x6x6 cube at 16-231 and the grey ramp at 232-255', () => {
    expect(ansi256Rgb(16)).toEqual([0, 0, 0]);
    expect(ansi256Rgb(17)).toEqual([0, 0, 95]);
    expect(ansi256Rgb(21)).toEqual([0, 0, 255]);
    expect(ansi256Rgb(22)).toEqual([0, 95, 0]);
    expect(ansi256Rgb(46)).toEqual([0, 255, 0]);
    expect(ansi256Rgb(196)).toEqual([255, 0, 0]);
    expect(ansi256Rgb(202)).toEqual([255, 95, 0]);
    expect(ansi256Rgb(214)).toEqual([255, 175, 0]);
    expect(ansi256Rgb(231)).toEqual([255, 255, 255]);
    expect(ansi256Rgb(232)).toEqual([8, 8, 8]);
    expect(ansi256Rgb(244)).toEqual([128, 128, 128]);
    expect(ansi256Rgb(255)).toEqual([238, 238, 238]);
  });

  it('has no entry below 16, which are the 16 basic colours a theme may change, or above 255', () => {
    expect(() => ansi256Rgb(15)).toThrow(RangeError);
    expect(() => ansi256Rgb(256)).toThrow(RangeError);
    expect(() => ansi256Rgb(1.5)).toThrow(RangeError);
  });
});

describe('nearestAnsi256', () => {
  it('gives each of the 240 colours it may use back for its own value', () => {
    for (let index = 16; index <= 255; index += 1) {
      expect(nearestAnsi256(toHex(ansi256Rgb(index))), `index ${index}`).toBe(index);
    }
  });

  it('only ever answers from 16 to 255', () => {
    for (const hex of [
      '#000000',
      '#ffffff',
      '#0d0e10',
      '#fe4813',
      '#010203',
      '#7f7f7f',
      '#fefefe',
    ]) {
      const index = nearestAnsi256(hex);
      expect(index, hex).toBeGreaterThanOrEqual(16);
      expect(index, hex).toBeLessThanOrEqual(255);
    }
  });

  it('is the entry with the smallest RGB distance, checked against a plain search', () => {
    const colours = ['#fe4813', '#ff7a4d', '#c93a0e', '#f1f2f0', '#ffb627', '#d18208', '#565a64'];
    for (const hex of colours) {
      const [r, g, b] = hexToRgb(hex);
      let best = 16;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (let index = 16; index <= 255; index += 1) {
        const [er, eg, eb] = ansi256Rgb(index);
        const distance = (r - er) ** 2 + (g - eg) ** 2 + (b - eb) ** 2;
        if (distance < bestDistance) {
          best = index;
          bestDistance = distance;
        }
      }
      expect(nearestAnsi256(hex), hex).toBe(best);
    }
  });

  it('is deterministic: the same colour gives the same answer every time', () => {
    for (const key of PALETTE_KEYS) {
      expect(nearestAnsi256(PALETTES.orange[key])).toBe(nearestAnsi256(PALETTES.orange[key]));
    }
  });

  it('breaks a tie towards the lower index', () => {
    // (13,13,13) is as far from the grey 8 (index 232) as from the grey 18 (index 233).
    expect(nearestAnsi256('#0d0d0d')).toBe(232);
  });

  it('maps the orange palette the way the documentation says', () => {
    const mapped = Object.fromEntries(
      PALETTE_KEYS.map((key) => [key, nearestAnsi256(PALETTES.orange[key])]),
    );

    expect(mapped).toEqual({
      K: 233, // outline #0d0e10: the grey (18,18,18)
      B: 202, // body #fe4813: (255,95,0), orange
      L: 209, // wing edge #ff7a4d: (255,135,95), light orange
      C: 166, // belly marks #c93a0e: (215,95,0), dark orange
      W: 255, // face disc #f1f2f0: the grey (238,238,238)
      O: 233, // iris #0d0e10: the grey (18,18,18)
      P: 233, // pupil #0d0e10: the grey (18,18,18)
      H: 231, // eye highlight #ffffff: white
      Y: 214, // beak #ffb627: (255,175,0), amber
      y: 172, // beak shade #d18208: (215,135,0), dark amber
      F: 214, // feet #ffb627: (255,175,0), amber
    });
  });

  it('keeps the orange owl in orange: body, wing edge and belly marks are three different entries', () => {
    const { B, L, C } = PALETTES.orange;

    expect(new Set([B, L, C].map(nearestAnsi256)).size).toBe(3);
  });
});
