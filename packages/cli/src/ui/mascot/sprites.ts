// Hoo, the Stroq owl: one 20 by 20 pixel grid, and everything that draws it reads it from here.
//
// The terminal draws it with half blocks (`render.ts`), and the console and the site will draw the
// same data as SVG (`frameToSvg`) or generate their own from it, so nothing here knows how it is
// shown. Ported from the approved drafts (`reports/assets/mascot/sprites.js`), minus the palette that
// put the graphite owl on the orange share card.
//
// A frame is 20 rows of 20 characters. `.` is transparent; every other character is a key into a
// palette. The six frames are the same owl with different eyes, which is the whole animation.

/** The width and the height of the grid, in pixels. */
export const GRID_SIZE = 20;

/** What a transparent pixel is written as. */
export const TRANSPARENT = '.';

/** The parts of the owl that have a colour, as the keys a frame is written with. */
export type PaletteKey = 'K' | 'B' | 'L' | 'C' | 'W' | 'O' | 'P' | 'H' | 'Y' | 'y' | 'F';

/** The colour of each part, as `#rrggbb`. */
export type Palette = Readonly<Record<PaletteKey, string>>;

export type PaletteName = 'orange' | 'graphite';

/** One picture of the owl: `GRID_SIZE` rows of `GRID_SIZE` characters, each a `PaletteKey` or `.`. */
export type Frame = readonly string[];

export type FrameName = 'idle' | 'lookLeft' | 'lookRight' | 'blink' | 'happy' | 'alert';

/** A frame and how long it stays on the screen. */
export interface Beat {
  readonly frame: FrameName;
  readonly ms: number;
}

/** Every key a frame may use, with what it paints in the comment. */
export const PALETTE_KEYS: readonly PaletteKey[] = Object.freeze([
  'K', // outline
  'B', // body
  'L', // wing edge
  'C', // belly marks
  'W', // face disc
  'O', // iris
  'P', // pupil
  'H', // eye highlight
  'Y', // beak
  'y', // beak shade
  'F', // feet
] as const);

/** The orange owl is the one the owner chose. The graphite owl is a fallback and nothing uses it yet. */
export const PALETTES: Readonly<Record<PaletteName, Palette>> = Object.freeze({
  orange: Object.freeze({
    K: '#0d0e10',
    B: '#fe4813', // the brand orange
    L: '#ff7a4d',
    C: '#c93a0e',
    W: '#f1f2f0',
    O: '#0d0e10',
    P: '#0d0e10',
    H: '#ffffff',
    Y: '#ffb627',
    y: '#d18208',
    F: '#ffb627',
  }),
  graphite: Object.freeze({
    K: '#0d0e10',
    B: '#3a3d45',
    L: '#565a64',
    C: '#6a6f7a',
    W: '#f1f2f0',
    O: '#fe4813',
    P: '#0d0e10',
    H: '#ffffff',
    Y: '#ffb627',
    y: '#d18208',
    F: '#fe4813',
  }),
});

export const DEFAULT_PALETTE_NAME: PaletteName = 'orange';
export const DEFAULT_PALETTE: Palette = PALETTES[DEFAULT_PALETTE_NAME];

/** The first row of the eyes, how many rows they take, and the columns where each eye starts. */
const EYE_FIRST_ROW = 6;
const EYE_WIDTH = 4;
const LEFT_EYE_COLUMN = 4;
const RIGHT_EYE_COLUMN = 12;

const BASE: Frame = Object.freeze([
  '...KK..........KK...',
  '...KBK........KBK...',
  '...KBBKKKKKKKKBBK...',
  '..KBBBBBBBBBBBBBBK..',
  '..KBWWWWBBBBWWWWBK..',
  '.KBWWWWWWBBWWWWWWBK.',
  '.KBWWOOWWWWWWOOWWBK.',
  '.KBWOHPOWWWWOHPOWBK.',
  '.KBWOPPOWWWWOPPOWBK.',
  '.KBWWOOWWYYWWOOWWBK.',
  '..KBWWWWWyyWWWWWBK..',
  '..KBBWWWWWWWWWWBBK..',
  '..KBBBBBBBBBBBBBBK..',
  '.KLBBCBBCBBCBBCBBLK.',
  '.KLBBBCBBBBBBCBBBLK.',
  '.KLBBCBBCBBCBBCBBLK.',
  '..KLBBBBBBBBBBBBLK..',
  '...KBBBBBBBBBBBBK...',
  '....KKFFKKKKFFKK....',
  '.....F.F....F.F.....',
]);

/** The base owl with both eyes replaced by the four rows given (each `EYE_WIDTH` characters). */
function withEyes(eye: readonly [string, string, string, string]): Frame {
  return Object.freeze(
    BASE.map((line, row) => {
      const rows = eye[row - EYE_FIRST_ROW];
      if (rows === undefined) return line;
      return (
        line.slice(0, LEFT_EYE_COLUMN) +
        rows +
        line.slice(LEFT_EYE_COLUMN + EYE_WIDTH, RIGHT_EYE_COLUMN) +
        rows +
        line.slice(RIGHT_EYE_COLUMN + EYE_WIDTH)
      );
    }),
  );
}

export const FRAME_NAMES: readonly FrameName[] = Object.freeze([
  'idle',
  'lookLeft',
  'lookRight',
  'blink',
  'happy',
  'alert',
] as const);

export const FRAMES: Readonly<Record<FrameName, Frame>> = Object.freeze({
  idle: BASE,
  lookLeft: withEyes(['WOOW', 'HPOO', 'PPOO', 'WOOW']),
  lookRight: withEyes(['WOOW', 'OOHP', 'OOPP', 'WOOW']),
  blink: withEyes(['WBBW', 'BBBB', 'KKKK', 'WWWW']),
  happy: withEyes(['WWWW', 'WKKW', 'KWWK', 'WWWW']),
  alert: withEyes(['WOOW', 'OPPO', 'OPPO', 'WOOW']),
});

const beats = (...list: ReadonlyArray<readonly [FrameName, number]>): readonly Beat[] =>
  Object.freeze(list.map(([frame, ms]) => Object.freeze({ frame, ms })));

/** A loop for somewhere the owl stays on screen (the site, the console). */
export const IDLE_LOOP: readonly Beat[] = beats(
  ['idle', 1600],
  ['blink', 120],
  ['idle', 900],
  ['lookLeft', 500],
  ['idle', 250],
  ['lookRight', 500],
  ['idle', 1200],
  ['blink', 120],
);

/** The one-time greeting in the terminal: about 1.3 seconds, then it stops. */
export const GREETING: readonly Beat[] = beats(
  ['idle', 300],
  ['blink', 110],
  ['idle', 220],
  ['lookLeft', 230],
  ['lookRight', 230],
  ['happy', 260],
);

/** A greeting that takes longer than this is a wait, not a greeting. */
export const GREETING_MAX_MS = 1500;

/** How long a sequence takes. */
export function totalMs(sequence: readonly Beat[]): number {
  return sequence.reduce((sum, beat) => sum + beat.ms, 0);
}
