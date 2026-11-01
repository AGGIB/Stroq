import { describe, expect, it } from 'vitest';
import {
  ANSI16_REFERENCE,
  ansi16Code,
  hexToRgb,
  nearestAnsi16,
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
