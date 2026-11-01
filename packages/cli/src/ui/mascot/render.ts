// Drawing the owl: terminal lines for a frame, the owl beside a block of text, and standalone SVG.
//
// Everything here is a pure function of its arguments. Nothing writes to a stream: that is
// `play.ts`, and it writes through the unfiltered writers, because the lines made here hold escape
// sequences that the safe-output filter (`terminal-safe.ts`) would write out as text.

import { ansi16Code, hexToRgb, nearestAnsi16 } from './color.js';
import {
  DEFAULT_PALETTE,
  TRANSPARENT,
  type Frame,
  type FrameName,
  type Palette,
  FRAMES,
} from './sprites.js';

/** The colours a terminal can show: 24-bit, or the 16 basic colours. */
export type ColorDepth = 'truecolor' | 'ansi16';

/** `none` is for a terminal that must not get colour, and draws no owl at all: the caller prints text only. */
export type ColorMode = ColorDepth | 'none';

export interface RenderOptions {
  readonly colorMode: ColorMode;
  /** The orange owl unless told otherwise. */
  readonly palette?: Palette;
}

const ESC = '\u001b';
const RESET = `${ESC}[0m`;
const UPPER_HALF = '▀';
const LOWER_HALF = '▄';
/** Matches the colour sequences this module writes, and any other SGR. */
const SGR = /\u001b\[[0-9;]*m/gu;

/** The SGR parameters that set a colour as the foreground and as the background. */
interface Paint {
  readonly fg: string;
  readonly bg: string;
}

function paintFor(hex: string, depth: ColorDepth): Paint {
  if (depth === 'truecolor') {
    const rgb = hexToRgb(hex).join(';');
    return { fg: `38;2;${rgb}`, bg: `48;2;${rgb}` };
  }
  const index = nearestAnsi16(hex);
  return { fg: String(ansi16Code(index, 'fg')), bg: String(ansi16Code(index, 'bg')) };
}

/** Every key of the palette with its paint, checked once: a bad colour throws before anything is drawn. */
function paints(palette: Palette, depth: ColorDepth): ReadonlyMap<string, Paint> {
  return new Map(Object.entries(palette).map(([key, hex]) => [key, paintFor(hex, depth)]));
}

/**
 * The terminal lines of a frame, two pixels to a character cell: the upper half block takes the
 * colour of the pixel above as its foreground and the pixel below as its background, so a 20 by 20
 * frame is 10 lines of 20 cells. A cell with only a lower pixel is the lower half block. Every cell
 * ends with a reset, so a line can be followed by anything without taking a colour with it.
 *
 * `colorMode` `none` returns no lines (there is no owl without colour; the caller prints text only).
 * A character the palette does not know is transparent.
 */
export function renderFrame(frame: Frame, options: RenderOptions): readonly string[] {
  if (options.colorMode === 'none') return [];
  const paint = paints(options.palette ?? DEFAULT_PALETTE, options.colorMode);
  const lines: string[] = [];
  for (let row = 0; row < frame.length; row += 2) {
    const upper = frame[row] ?? '';
    const lower = frame[row + 1] ?? '';
    const width = Math.max(upper.length, lower.length);
    let line = '';
    for (let column = 0; column < width; column += 1) {
      const top = paint.get(upper[column] ?? TRANSPARENT);
      const bottom = paint.get(lower[column] ?? TRANSPARENT);
      if (top === undefined && bottom === undefined) line += ' ';
      else if (top !== undefined && bottom === undefined)
        line += `${ESC}[${top.fg}m${UPPER_HALF}${RESET}`;
      else if (top === undefined && bottom !== undefined)
        line += `${ESC}[${bottom.fg}m${LOWER_HALF}${RESET}`;
      else line += `${ESC}[${top?.fg};${bottom?.bg}m${UPPER_HALF}${RESET}`;
    }
    lines.push(line);
  }
  return lines;
}

/**
 * How many characters a terminal shows for `text`: its colour sequences take no room. Counts code
 * points and not display columns, which is right for the owl, for ASCII and for the box and arrow
 * glyphs the cards use, and not for wide (CJK) characters.
 */
export function visibleWidth(text: string): number {
  return [...text.replace(SGR, '')].length;
}

/**
 * The owl on the left and the text on the right, `gap` blanks between. The owl's lines are padded
 * to the width of its widest one, so the text starts in one column; a row with no text is just the
 * owl, with no blanks after it, and an owl shorter than the text leaves blanks under it. With no owl
 * lines (`colorMode` `none`) it is the text alone, as it was given.
 */
export function composeWithText(
  owlLines: readonly string[],
  textLines: readonly string[],
  gap: number,
): string[] {
  if (owlLines.length === 0) return [...textLines];
  const owlWidth = Math.max(...owlLines.map(visibleWidth));
  const between = ' '.repeat(Number.isFinite(gap) ? Math.max(0, Math.floor(gap)) : 0);
  const rows = Math.max(owlLines.length, textLines.length);
  const lines: string[] = [];
  for (let row = 0; row < rows; row += 1) {
    const owl = owlLines[row] ?? '';
    const text = textLines[row] ?? '';
    lines.push(
      text === '' ? owl : `${owl}${' '.repeat(owlWidth - visibleWidth(owl))}${between}${text}`,
    );
  }
  return lines;
}

/** What a card is made of beside the owl. */
export interface CardOptions {
  readonly colorMode: ColorMode;
  readonly textLines: readonly string[];
  readonly palette?: Palette;
  /** Blanks between the owl and the text. */
  readonly gap?: number;
  /** Blanks in front of the owl. */
  readonly indent?: number;
}

export const DEFAULT_GAP = 3;
export const DEFAULT_INDENT = 2;

/** A named frame with the text beside it, as the lines to print. In mode `none` it is the text alone. */
export function renderCard(frame: FrameName, options: CardOptions): string[] {
  const owl = renderFrame(FRAMES[frame], options);
  const indent = ' '.repeat(Math.max(0, Math.floor(options.indent ?? DEFAULT_INDENT)));
  const lines = composeWithText(owl, options.textLines, options.gap ?? DEFAULT_GAP);
  return owl.length === 0 ? lines : lines.map((line) => `${indent}${line}`);
}

/** The caption a screen reader gives the picture. */
const SVG_LABEL = 'Hoo, the Stroq owl';

/**
 * A standalone SVG of a frame, for the site and the console. The grid is the `viewBox` (one unit a
 * pixel), the image is `scale` times as large, and `shape-rendering` is `crispEdges` so that the
 * pixels stay square. One `<rect>` for each run of one colour along a row. No script, no style, no
 * link and no reference to anything outside the string. The scale must be a whole number of at
 * least 1, which is what keeps the pixels from blurring.
 */
export function frameToSvg(frame: Frame, palette: Palette, scale: number): string {
  if (!Number.isInteger(scale) || scale < 1)
    throw new RangeError(`scale must be a whole number of at least 1, not ${String(scale)}`);
  const colours = new Map(
    Object.entries(palette).map(([key, hex]) => {
      hexToRgb(hex);
      return [key, hex.toLowerCase()];
    }),
  );
  const columns = Math.max(0, ...frame.map((row) => row.length));
  const rects: string[] = [];
  frame.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const colour = colours.get(row[x] ?? TRANSPARENT);
      let end = x + 1;
      while (end < row.length && colours.get(row[end] ?? TRANSPARENT) === colour) end += 1;
      if (colour !== undefined)
        rects.push(`<rect x="${x}" y="${y}" width="${end - x}" height="1" fill="${colour}"/>`);
      x = end;
    }
  });
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${columns} ${frame.length}" ` +
      `width="${columns * scale}" height="${frame.length * scale}" ` +
      `shape-rendering="crispEdges" role="img" aria-label="${SVG_LABEL}">`,
    ...rects,
    '</svg>',
  ].join('\n');
}
