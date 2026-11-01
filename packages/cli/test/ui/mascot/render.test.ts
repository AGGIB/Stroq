import { describe, expect, it } from 'vitest';
import { ANSI16_REFERENCE, hexToRgb, nearestAnsi16 } from '../../../src/ui/mascot/color.js';
import {
  composeWithText,
  frameToSvg,
  renderCard,
  renderFrame,
  visibleWidth,
} from '../../../src/ui/mascot/render.js';
import {
  FRAME_NAMES,
  FRAMES,
  GRID_SIZE,
  PALETTES,
  type Frame,
  type Palette,
} from '../../../src/ui/mascot/sprites.js';

const ESC = '\u001b';
const SGR = /\u001b\[([0-9;]*)m/gu;

/** What a terminal shows for a cell: its glyph and the colours in force. `null` is "the default". */
interface Cell {
  readonly glyph: string;
  readonly fg: string | null;
  readonly bg: string | null;
}

/** Reads a line the way a terminal does: SGR sequences change the state, other characters are cells. */
function decodeLine(line: string): Cell[] {
  const cells: Cell[] = [];
  let fg: string | null = null;
  let bg: string | null = null;
  for (const match of line.matchAll(/\u001b\[([0-9;]*)m|(.)/gsu)) {
    if (match[2] !== undefined) {
      cells.push({ glyph: match[2], fg, bg });
      continue;
    }
    const params = (match[1] ?? '').split(';').map((part) => (part === '' ? 0 : Number(part)));
    for (let i = 0; i < params.length; i += 1) {
      const code = params[i] ?? 0;
      if (code === 0) {
        fg = null;
        bg = null;
      } else if (code === 38 || code === 48) {
        const rgb = `rgb(${params[i + 2]},${params[i + 3]},${params[i + 4]})`;
        if (params[i + 1] !== 2) throw new Error('only 24-bit colour is expected');
        if (code === 38) fg = rgb;
        else bg = rgb;
        i += 4;
      } else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
        fg = `ansi(${code >= 90 ? code - 90 + 8 : code - 30})`;
      } else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
        bg = `ansi(${code >= 100 ? code - 100 + 8 : code - 40})`;
      } else throw new Error(`unexpected SGR parameter ${code}`);
    }
  }
  return cells;
}

/** Two pixels per cell, as the half blocks draw them: back to a 20 by 20 grid of colours. */
function decodePixels(lines: readonly string[]): Array<Array<string | null>> {
  const rows: Array<Array<string | null>> = [];
  for (const line of lines) {
    const top: Array<string | null> = [];
    const bottom: Array<string | null> = [];
    for (const cell of decodeLine(line)) {
      if (cell.glyph === ' ') {
        top.push(null);
        bottom.push(null);
      } else if (cell.glyph === '▀') {
        top.push(cell.fg);
        bottom.push(cell.bg);
      } else if (cell.glyph === '▄') {
        top.push(null);
        bottom.push(cell.fg);
      } else throw new Error(`unexpected glyph ${cell.glyph}`);
    }
    rows.push(top, bottom);
  }
  return rows;
}

const expectedPixels = (
  frame: Frame,
  palette: Palette,
  colour: (hex: string) => string,
): Array<Array<string | null>> =>
  frame.map((row) =>
    [...row].map((key) => (key === '.' ? null : colour(palette[key as keyof Palette]))),
  );

const truecolor = (hex: string): string => `rgb(${hexToRgb(hex).join(',')})`;
const ansi16 = (hex: string): string => `ansi(${nearestAnsi16(hex)})`;

describe('renderFrame: truecolor', () => {
  it.each(FRAME_NAMES)('draws %s as 10 lines of 20 cells', (name) => {
    const lines = renderFrame(FRAMES[name], { colorMode: 'truecolor' });

    expect(lines).toHaveLength(GRID_SIZE / 2);
    for (const line of lines) expect(decodeLine(line)).toHaveLength(GRID_SIZE);
  });

  it.each(FRAME_NAMES)('draws %s so that every pixel decodes to its palette colour', (name) => {
    const lines = renderFrame(FRAMES[name], { colorMode: 'truecolor' });

    expect(decodePixels(lines)).toEqual(expectedPixels(FRAMES[name], PALETTES.orange, truecolor));
  });

  it('uses the orange palette unless told another', () => {
    const graphite = renderFrame(FRAMES.idle, {
      colorMode: 'truecolor',
      palette: PALETTES.graphite,
    });

    expect(decodePixels(graphite)).toEqual(
      expectedPixels(FRAMES.idle, PALETTES.graphite, truecolor),
    );
    expect(graphite).not.toEqual(renderFrame(FRAMES.idle, { colorMode: 'truecolor' }));
  });

  it('writes 24-bit SGR for a few cells we can read by eye', () => {
    const lines = renderFrame(FRAMES.idle, { colorMode: 'truecolor' });

    // Row 0 is "...KK....": two cells of outline over the body at row 1 "...KBK...".
    expect(lines[0]).toContain(`${ESC}[38;2;13;14;16;48;2;13;14;16m▀${ESC}[0m`);
    expect(lines[0]?.startsWith(`   ${ESC}[`)).toBe(true);
    // Row 2 and 3 of the sprite: body orange on body orange.
    expect(lines[1]).toContain('38;2;254;72;19');
  });

  it('draws a half block with one pixel as the glyph that fills that half', () => {
    const top = renderFrame(['K.', '..'], { colorMode: 'truecolor' });
    const bottom = renderFrame(['..', '.K'], { colorMode: 'truecolor' });
    const blank = renderFrame(['..', '..'], { colorMode: 'truecolor' });

    expect(top).toEqual([`${ESC}[38;2;13;14;16m▀${ESC}[0m `]);
    expect(bottom).toEqual([` ${ESC}[38;2;13;14;16m▄${ESC}[0m`]);
    expect(blank).toEqual(['  ']);
  });

  it('writes nothing but colour sequences and the three characters it draws with', () => {
    for (const name of FRAME_NAMES) {
      for (const line of renderFrame(FRAMES[name], { colorMode: 'truecolor' })) {
        expect(line.replace(SGR, '')).toMatch(/^[ ▀▄]{20}$/u);
      }
    }
  });
});

describe('renderFrame: ansi16', () => {
  it.each(FRAME_NAMES)('draws %s with the nearest of the 16 colours for every pixel', (name) => {
    const lines = renderFrame(FRAMES[name], { colorMode: 'ansi16' });

    expect(lines).toHaveLength(10);
    expect(decodePixels(lines)).toEqual(expectedPixels(FRAMES[name], PALETTES.orange, ansi16));
  });

  it('uses only the basic SGR codes: reset, 30-37, 90-97, 40-47 and 100-107', () => {
    const allowed = new Set([
      0,
      ...range(30, 37),
      ...range(90, 97),
      ...range(40, 47),
      ...range(100, 107),
    ]);
    const used = new Set<number>();
    for (const name of FRAME_NAMES) {
      for (const palette of Object.values(PALETTES)) {
        for (const line of renderFrame(FRAMES[name], { colorMode: 'ansi16', palette })) {
          for (const match of line.matchAll(SGR)) {
            for (const part of (match[1] ?? '').split(';'))
              used.add(part === '' ? 0 : Number(part));
          }
        }
      }
    }

    expect(used.size).toBeGreaterThan(3);
    for (const code of used) expect(allowed.has(code), `SGR ${code}`).toBe(true);
    expect(used.has(38)).toBe(false);
    expect(used.has(48)).toBe(false);
  });

  it('is the same on every call', () => {
    const first = renderFrame(FRAMES.happy, { colorMode: 'ansi16' });
    const second = renderFrame(FRAMES.happy, { colorMode: 'ansi16' });

    expect(second).toEqual(first);
  });

  it('draws the orange body as bright red (SGR 91) and the outline as black (SGR 30)', () => {
    const [line] = renderFrame(['KB', 'KB'], { colorMode: 'ansi16' });

    expect(line).toBe(`${ESC}[30;40m▀${ESC}[0m${ESC}[91;101m▀${ESC}[0m`);
  });

  it('knows 16 reference colours', () => {
    expect(ANSI16_REFERENCE).toHaveLength(16);
  });
});

describe('renderFrame: none', () => {
  it('returns no lines at all, so that the caller prints text only', () => {
    for (const name of FRAME_NAMES) {
      expect(renderFrame(FRAMES[name], { colorMode: 'none' })).toEqual([]);
    }
  });
});

describe('renderFrame: the input', () => {
  it('is not changed, and the frames can be frozen', () => {
    const before = JSON.stringify(FRAMES);

    renderFrame(FRAMES.alert, { colorMode: 'truecolor' });
    renderFrame(FRAMES.alert, { colorMode: 'ansi16' });

    expect(JSON.stringify(FRAMES)).toBe(before);
  });

  it('refuses a palette whose colour is not #rrggbb', () => {
    const bad: Palette = { ...PALETTES.orange, B: 'orange' };

    expect(() => renderFrame(FRAMES.idle, { colorMode: 'truecolor', palette: bad })).toThrow(
      RangeError,
    );
  });

  it('treats a letter the palette does not know as transparent', () => {
    expect(renderFrame(['Z.', '..'], { colorMode: 'truecolor' })).toEqual(['  ']);
  });
});

describe('visibleWidth', () => {
  it('counts the characters a terminal shows, and not the colour sequences', () => {
    expect(visibleWidth('abc')).toBe(3);
    expect(visibleWidth('')).toBe(0);
    expect(visibleWidth(`${ESC}[1mbold${ESC}[0m text`)).toBe(9);
    expect(visibleWidth(`${ESC}[38;2;1;2;3;48;2;4;5;6m▀${ESC}[0m`)).toBe(1);
    expect(visibleWidth(renderFrame(FRAMES.idle, { colorMode: 'truecolor' })[3] ?? '')).toBe(20);
  });
});

describe('composeWithText', () => {
  const owl = ['AAAA', 'BBBB', 'CCCC'];

  it('puts the owl on the left and the text on the right, a gap between', () => {
    expect(composeWithText(owl, ['one', 'two', 'three'], 2)).toEqual([
      'AAAA  one',
      'BBBB  two',
      'CCCC  three',
    ]);
  });

  it('pads with blanks under the owl when the text is longer', () => {
    expect(composeWithText(owl, ['1', '2', '3', '4', '5'], 1)).toEqual([
      'AAAA 1',
      'BBBB 2',
      'CCCC 3',
      '     4',
      '     5',
    ]);
  });

  it('leaves the owl alone, with no trailing blanks, when the owl is longer', () => {
    expect(composeWithText(owl, ['only'], 3)).toEqual(['AAAA   only', 'BBBB', 'CCCC']);
  });

  it('does not pad a row whose text is empty', () => {
    expect(composeWithText(owl, ['x', '', 'z'], 1)).toEqual(['AAAA x', 'BBBB', 'CCCC z']);
  });

  it('lines the text up when the owl rows are not all the same width', () => {
    expect(composeWithText(['AA', 'BBBB', 'C'], ['1', '2', '3'], 1)).toEqual([
      'AA   1',
      'BBBB 2',
      'C    3',
    ]);
  });

  it('measures what is seen, so a coloured owl lines the text up at column 20 plus the gap', () => {
    const lines = renderFrame(FRAMES.idle, { colorMode: 'truecolor' });
    const text = Array.from({ length: 12 }, (_, i) => `line ${i}`);

    const card = composeWithText(lines, text, 3);

    expect(card).toHaveLength(12);
    card.forEach((line, i) => {
      const at = line.lastIndexOf('line');
      expect(visibleWidth(line.slice(0, at))).toBe(23);
      expect(line.endsWith(`line ${i}`)).toBe(true);
    });
    // Under the owl the blanks are plain blanks.
    expect(card[11]).toBe(`${' '.repeat(23)}line 11`);
  });

  it('measures coloured text too, when the text itself is styled', () => {
    const styled = `${ESC}[1mHoo${ESC}[0m`;

    const card = composeWithText(owl, [styled], 2);

    expect(card[0]).toBe(`AAAA  ${styled}`);
  });

  it('prints the text alone when there is no owl (colour mode none)', () => {
    const none = renderFrame(FRAMES.idle, { colorMode: 'none' });

    expect(composeWithText(none, ['Hoo . stroq', 'nothing to report'], 3)).toEqual([
      'Hoo . stroq',
      'nothing to report',
    ]);
  });

  it('prints the owl alone when there is no text', () => {
    expect(composeWithText(owl, [], 3)).toEqual(owl);
  });

  it('treats a gap that is negative or not a whole number as the nearest whole number of at least 0', () => {
    expect(composeWithText(['A'], ['t'], -4)).toEqual(['At']);
    expect(composeWithText(['A'], ['t'], 2.9)).toEqual(['A  t']);
    expect(composeWithText(['A'], ['t'], Number.NaN)).toEqual(['At']);
  });

  it('returns new arrays and leaves its inputs alone', () => {
    const text = ['x'];
    const copy = composeWithText([], text, 1);
    const frozenOwl = Object.freeze(['A']);

    expect(copy).not.toBe(text);
    expect(() => composeWithText(frozenOwl, Object.freeze(['t']), 1)).not.toThrow();
  });
});

describe('renderCard', () => {
  it('is the owl in colour, indented, with the text beside it', () => {
    const card = renderCard('idle', { colorMode: 'ansi16', textLines: ['Hoo'], gap: 3, indent: 2 });

    expect(card).toHaveLength(10);
    expect(card[0]?.startsWith('  ')).toBe(true);
    expect(card[0]?.endsWith('   Hoo')).toBe(true);
    expect(visibleWidth(card[1] ?? '')).toBe(2 + 20);
  });

  it('is the text alone, not indented, in mode none', () => {
    expect(
      renderCard('idle', { colorMode: 'none', textLines: ['Hoo', 'ok'], gap: 3, indent: 2 }),
    ).toEqual(['Hoo', 'ok']);
  });

  it('puts two spaces in front of the owl and three between it and the text unless told otherwise', () => {
    const card = renderCard('blink', { colorMode: 'truecolor', textLines: ['Hoo'] });

    expect(card[0]?.startsWith('  ')).toBe(true);
    expect(card[0]?.endsWith('   Hoo')).toBe(true);
  });
});

describe('frameToSvg', () => {
  /** Reads the rectangles back into a 20 by 20 grid of colours. */
  function svgPixels(svg: string): Array<Array<string | null>> {
    const grid: Array<Array<string | null>> = Array.from({ length: GRID_SIZE }, () =>
      Array.from({ length: GRID_SIZE }, () => null),
    );
    for (const match of svg.matchAll(
      /<rect x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)" fill="(#[0-9a-f]{6})"\/>/gu,
    )) {
      const [x, y, width, height] = match.slice(1, 5).map(Number) as [
        number,
        number,
        number,
        number,
      ];
      for (let row = y; row < y + height; row += 1) {
        for (let column = x; column < x + width; column += 1) {
          const line = grid[row];
          if (line === undefined) throw new Error('rect outside the grid');
          if (line[column] !== null) throw new Error('two rects on one pixel');
          line[column] = match[5] ?? null;
        }
      }
    }
    return grid;
  }

  /** The number of runs of one colour on a row, counted by looking at the colours and not the keys. */
  function countRuns(frame: Frame, palette: Palette): number {
    let runs = 0;
    for (const row of frame) {
      let previous: string | null = null;
      for (const key of row) {
        const colour = key === '.' ? null : palette[key as keyof Palette].toLowerCase();
        if (colour !== null && colour !== previous) runs += 1;
        previous = colour;
      }
    }
    return runs;
  }

  it.each(FRAME_NAMES)('draws %s pixel for pixel', (name) => {
    const svg = frameToSvg(FRAMES[name], PALETTES.orange, 8);

    expect(svgPixels(svg)).toEqual(
      expectedPixels(FRAMES[name], PALETTES.orange, (hex) => hex.toLowerCase()),
    );
  });

  it.each(FRAME_NAMES)('makes one rect for each run of one colour on a row (%s)', (name) => {
    const svg = frameToSvg(FRAMES[name], PALETTES.orange, 4);

    expect(svg.match(/<rect /gu)).toHaveLength(countRuns(FRAMES[name], PALETTES.orange));
    for (const match of svg.matchAll(/<rect [^>]*height="(\d+)"/gu)) expect(match[1]).toBe('1');
  });

  it('is a standalone image: the right viewBox, scaled size, crisp pixels, a name', () => {
    const svg = frameToSvg(FRAMES.idle, PALETTES.orange, 12);

    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" ')).toBe(true);
    expect(svg).toContain('viewBox="0 0 20 20"');
    expect(svg).toContain('width="240"');
    expect(svg).toContain('height="240"');
    expect(svg).toContain('shape-rendering="crispEdges"');
    expect(svg).toContain('role="img"');
    expect(svg).toContain('aria-label="Hoo, the Stroq owl"');
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
  });

  it('has no script, no link, no external reference and no event handler', () => {
    for (const name of FRAME_NAMES) {
      for (const palette of Object.values(PALETTES)) {
        const svg = frameToSvg(FRAMES[name], palette, 5);

        expect(svg).not.toMatch(/<script/iu);
        expect(svg).not.toMatch(/href/iu);
        expect(svg).not.toMatch(/url\(/iu);
        expect(svg).not.toMatch(/\son[a-z]+\s*=/iu);
        expect(svg).not.toMatch(/<(image|use|foreignObject|style|link)\b/iu);
        // The one address in it is the XML namespace, which names the language and fetches nothing.
        expect(svg.match(/https?:/gu)).toHaveLength(1);
      }
    }
  });

  it('writes the colours in lower case #rrggbb whatever case the palette had', () => {
    const shouting: Palette = { ...PALETTES.orange, B: '#FE4813' };

    expect(frameToSvg(FRAMES.idle, shouting, 1)).toContain('fill="#fe4813"');
  });

  it('leaves transparent cells empty', () => {
    expect(frameToSvg(['..', '.K'], PALETTES.orange, 1)).toContain(
      '<rect x="1" y="1" width="1" height="1" fill="#0d0e10"/>',
    );
    expect(frameToSvg(['..', '..'], PALETTES.orange, 1)).not.toContain('<rect');
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses a scale of %s, which would blur the pixels or draw nothing',
    (scale) => {
      expect(() => frameToSvg(FRAMES.idle, PALETTES.orange, scale)).toThrow(RangeError);
    },
  );

  it('refuses a palette whose colour is not #rrggbb, which would end up inside an attribute', () => {
    const bad: Palette = { ...PALETTES.orange, B: '#fe4813" onload="x' };

    expect(() => frameToSvg(FRAMES.idle, bad, 1)).toThrow(RangeError);
  });
});

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}
