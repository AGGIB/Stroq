// Colour for the owl: `#rrggbb` into numbers, and the nearest colour in the two fixed palettes that
// terminals without 24-bit colour have: the xterm 256 colours, and the 16 basic ones.

export type Rgb = readonly [number, number, number];

const HEX_COLOUR = /^#[0-9a-fA-F]{6}$/u;

/**
 * `#rrggbb` as three numbers. Anything else is refused, because a palette colour ends up inside an
 * SVG attribute and inside an escape sequence, and neither takes a colour it has not checked.
 */
export function hexToRgb(hex: string): Rgb {
  if (!HEX_COLOUR.test(hex)) throw new RangeError(`not a #rrggbb colour: ${JSON.stringify(hex)}`);
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * The 16 basic colours as a terminal with the xterm defaults shows them, in the order of their SGR
 * codes: 0-7 are the normal colours (foreground 30-37, background 40-47) and 8-15 the bright ones
 * (90-97, 100-107). Terminals let the user change every one of these, so the table is a best guess
 * about what a colour will look like, and it is fixed so that the mapping is the same everywhere.
 *
 *   0 black    (0,0,0)        8  bright black    (127,127,127)
 *   1 red      (205,0,0)      9  bright red      (255,0,0)
 *   2 green    (0,205,0)      10 bright green    (0,255,0)
 *   3 yellow   (205,205,0)    11 bright yellow   (255,255,0)
 *   4 blue     (0,0,238)      12 bright blue     (92,92,255)
 *   5 magenta  (205,0,205)    13 bright magenta  (255,0,255)
 *   6 cyan     (0,205,205)    14 bright cyan     (0,255,255)
 *   7 white    (229,229,229)  15 bright white    (255,255,255)
 */
export const ANSI16_REFERENCE: readonly Rgb[] = Object.freeze([
  [0, 0, 0],
  [205, 0, 0],
  [0, 205, 0],
  [205, 205, 0],
  [0, 0, 238],
  [205, 0, 205],
  [0, 205, 205],
  [229, 229, 229],
  [127, 127, 127],
  [255, 0, 0],
  [0, 255, 0],
  [255, 255, 0],
  [92, 92, 255],
  [255, 0, 255],
  [0, 255, 255],
  [255, 255, 255],
] as const);

/** The greys among the 16: black, white, bright black, bright white. The rest are colours. */
const ACHROMATIC: ReadonlySet<number> = new Set([0, 7, 8, 15]);

/** Saturation (0 to 1) from which a colour is a colour and not a grey: (max - min) / max. */
const CHROMATIC_FROM = 0.3;

function isChromatic([r, g, b]: Rgb): boolean {
  const high = Math.max(r, g, b);
  return high > 0 && (high - Math.min(r, g, b)) / high >= CHROMATIC_FROM;
}

const distance = (a: Rgb, b: Rgb): number =>
  (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

/**
 * The index (0 to 15) of the basic colour nearest to `hex`, which is the same answer on every call:
 *
 *  1. A colour (saturation 0.3 or more) can only become one of the 12 colours, and a grey only one of
 *     the 4 greys. Plain distance would turn the light orange of the wing edge, which is closer to the
 *     grey 8 than to any red, into a grey owl.
 *  2. Among those, the nearest by squared distance in RGB.
 *  3. A tie goes to the lower index.
 */
export function nearestAnsi16(hex: string): number {
  const rgb = hexToRgb(hex);
  const wantColour = isChromatic(rgb);
  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  ANSI16_REFERENCE.forEach((reference, index) => {
    if (ACHROMATIC.has(index) === wantColour) return;
    const d = distance(rgb, reference);
    if (d < bestDistance) {
      best = index;
      bestDistance = d;
    }
  });
  return best;
}

/** The SGR code that sets basic colour `index` (0 to 15) as the foreground or the background. */
export function ansi16Code(index: number, layer: 'fg' | 'bg'): number {
  const base = index < 8 ? 30 + index : 90 + (index - 8);
  return layer === 'fg' ? base : base + 10;
}

const CUBE_LEVELS: readonly number[] = Object.freeze([0, 95, 135, 175, 215, 255]);
const CUBE_FIRST = 16;
const GREY_FIRST = 232;
const LAST_ANSI256 = 255;

/**
 * The colour xterm shows for entry `index` of its 256-colour palette: 16-231 are a 6x6x6 cube whose
 * red, green and blue take the levels 0, 95, 135, 175, 215 and 255 (index = 16 + 36r + 6g + b), and
 * 232-255 are a ramp of 24 greys from 8 to 238 in steps of 10. Entries 0-15 are the 16 basic colours,
 * which a theme may change, so they are not part of this palette and asking for one throws.
 */
export function ansi256Rgb(index: number): Rgb {
  if (!Number.isInteger(index) || index < CUBE_FIRST || index > LAST_ANSI256)
    throw new RangeError(`not an xterm colour from 16 to 255: ${String(index)}`);
  if (index >= GREY_FIRST) {
    const grey = 8 + 10 * (index - GREY_FIRST);
    return [grey, grey, grey];
  }
  const n = index - CUBE_FIRST;
  const level = (step: number): number => CUBE_LEVELS[step] ?? 0;
  return [level(Math.floor(n / 36)), level(Math.floor(n / 6) % 6), level(n % 6)];
}

const ANSI256_TABLE: readonly Rgb[] = Object.freeze(
  Array.from({ length: LAST_ANSI256 - CUBE_FIRST + 1 }, (_, i) => ansi256Rgb(CUBE_FIRST + i)),
);

/**
 * The index (16 to 255) of the xterm colour nearest to `hex` by squared distance in RGB, which is the
 * same answer on every call. The cube comes before the grey ramp, so a tie goes to the cube, and
 * within each to the lower index.
 *
 * For the orange palette (`sprites.ts`):
 *
 *   key  part           colour    index  xterm colour
 *   K    outline        #0d0e10   233    (18,18,18)
 *   B    body           #fe4813   202    (255,95,0)
 *   L    wing edge      #ff7a4d   209    (255,135,95)
 *   C    belly marks    #c93a0e   166    (215,95,0)
 *   W    face disc      #f1f2f0   255    (238,238,238)
 *   O    iris           #0d0e10   233    (18,18,18)
 *   P    pupil          #0d0e10   233    (18,18,18)
 *   H    eye highlight  #ffffff   231    (255,255,255)
 *   Y    beak           #ffb627   214    (255,175,0)
 *   y    beak shade     #d18208   172    (215,135,0)
 *   F    feet           #ffb627   214    (255,175,0)
 */
export function nearestAnsi256(hex: string): number {
  const rgb = hexToRgb(hex);
  let best = CUBE_FIRST;
  let bestDistance = Number.POSITIVE_INFINITY;
  ANSI256_TABLE.forEach((reference, offset) => {
    const d = distance(rgb, reference);
    if (d < bestDistance) {
      best = CUBE_FIRST + offset;
      bestDistance = d;
    }
  });
  return best;
}
