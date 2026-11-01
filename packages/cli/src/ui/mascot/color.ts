// Colour for the owl: `#rrggbb` into numbers, and the nearest of the 16 basic terminal colours for
// terminals that have nothing better.

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
