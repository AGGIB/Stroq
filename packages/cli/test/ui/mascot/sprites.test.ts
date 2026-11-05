import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PALETTE_NAME,
  FRAME_NAMES,
  FRAMES,
  GREETING,
  GREETING_MAX_MS,
  GRID_SIZE,
  IDLE_LOOP,
  PALETTE_KEYS,
  PALETTES,
  TRANSPARENT,
  totalMs,
} from '../../../src/ui/mascot/sprites.js';

/** The approved drafts say it: the eyes are rows 6 to 9, columns 4 to 7 and 12 to 15. */
const EYE_ROWS = [6, 7, 8, 9];
const EYE_COLUMNS = [4, 5, 6, 7, 12, 13, 14, 15];

const cellAt = (frameName: (typeof FRAME_NAMES)[number], row: number, column: number): string =>
  FRAMES[frameName][row]?.[column] ?? '?';

describe('the grid', () => {
  it('is 20 by 20', () => {
    expect(GRID_SIZE).toBe(20);
  });

  it('has exactly the six frames of the approved draft', () => {
    expect([...FRAME_NAMES].sort()).toEqual(
      ['alert', 'blink', 'happy', 'idle', 'lookLeft', 'lookRight'].sort(),
    );
    expect(Object.keys(FRAMES).sort()).toEqual([...FRAME_NAMES].sort());
  });

  it.each(FRAME_NAMES)('frame %s is 20 rows of 20 known palette keys', (name) => {
    const frame = FRAMES[name];

    expect(frame).toHaveLength(20);
    for (const row of frame) {
      expect(row).toHaveLength(20);
      for (const cell of row) expect([...PALETTE_KEYS, TRANSPARENT]).toContain(cell);
    }
  });

  it('draws the left and right eye the same in every frame', () => {
    for (const name of FRAME_NAMES) {
      for (const row of EYE_ROWS) {
        const line = FRAMES[name][row] ?? '';
        expect(line.slice(4, 8), `${name} row ${row}`).toBe(line.slice(12, 16));
      }
    }
  });
});

describe('the frames differ only in the eyes', () => {
  it.each(FRAME_NAMES.filter((name) => name !== 'idle'))(
    '%s differs from idle in eye cells and nowhere else',
    (name) => {
      const changed: Array<[number, number]> = [];
      for (let row = 0; row < GRID_SIZE; row += 1) {
        for (let column = 0; column < GRID_SIZE; column += 1) {
          if (cellAt(name, row, column) !== cellAt('idle', row, column))
            changed.push([row, column]);
        }
      }

      expect(changed.length).toBeGreaterThan(0);
      for (const [row, column] of changed) {
        expect(EYE_ROWS, `row ${row}`).toContain(row);
        expect(EYE_COLUMNS, `column ${column}`).toContain(column);
      }
    },
  );

  it('closes the eyes in blink and smiles in happy', () => {
    expect(FRAMES.blink[8]?.slice(4, 8)).toBe('KKKK');
    expect(FRAMES.happy[7]?.slice(4, 8)).toBe('WKKW');
    expect(FRAMES.happy[8]?.slice(4, 8)).toBe('KWWK');
  });

  it('looks left and right with the highlight on the side it looks to', () => {
    expect(FRAMES.lookLeft[7]?.slice(4, 8)).toBe('HPOO');
    expect(FRAMES.lookRight[7]?.slice(4, 8)).toBe('OOHP');
  });
});

describe('the palettes', () => {
  it('are orange (the owner chose it, and it is the default) and graphite (a fallback), and no others', () => {
    expect(Object.keys(PALETTES).sort()).toEqual(['graphite', 'orange']);
    expect(DEFAULT_PALETTE_NAME).toBe('orange');
    expect('onOrange' in PALETTES).toBe(false);
  });

  it.each(['orange', 'graphite'] as const)(
    '%s has a #rrggbb colour for every key a frame uses',
    (name) => {
      const palette = PALETTES[name];

      for (const key of PALETTE_KEYS) expect(palette[key]).toMatch(/^#[0-9a-f]{6}$/);
      const used = new Set(FRAME_NAMES.flatMap((frame) => FRAMES[frame].join('').split('')));
      used.delete(TRANSPARENT);
      for (const key of used) expect(PALETTE_KEYS).toContain(key);
    },
  );

  it('paints the orange owl the brand orange with a dark outline', () => {
    expect(PALETTES.orange.B).toBe('#fe4813');
    expect(PALETTES.orange.K).toBe('#0d0e10');
    expect(PALETTES.orange.W).toBe('#f1f2f0');
  });
});

describe('the sequences', () => {
  it('play only frames that exist, each for a positive whole number of milliseconds', () => {
    for (const beat of [...GREETING, ...IDLE_LOOP]) {
      expect(FRAME_NAMES).toContain(beat.frame);
      expect(Number.isInteger(beat.ms)).toBe(true);
      expect(beat.ms).toBeGreaterThan(0);
    }
  });

  it('greets in about 1.3 seconds and never in more than 1.5', () => {
    expect(totalMs(GREETING)).toBe(1350);
    expect(totalMs(GREETING)).toBeLessThanOrEqual(GREETING_MAX_MS);
    expect(GREETING_MAX_MS).toBe(1500);
  });

  it('greets with the draft: idle, blink, idle, left, right, happy', () => {
    expect(GREETING.map((beat) => beat.frame)).toEqual([
      'idle',
      'blink',
      'idle',
      'lookLeft',
      'lookRight',
      'happy',
    ]);
  });

  it('sums the milliseconds of any sequence', () => {
    expect(totalMs([])).toBe(0);
    expect(
      totalMs([
        { frame: 'idle', ms: 5 },
        { frame: 'blink', ms: 7 },
      ]),
    ).toBe(12);
  });
});

describe('the data cannot be changed', () => {
  it('is frozen all the way down', () => {
    expect(Object.isFrozen(FRAMES)).toBe(true);
    expect(Object.isFrozen(FRAMES.idle)).toBe(true);
    expect(Object.isFrozen(PALETTES)).toBe(true);
    expect(Object.isFrozen(PALETTES.orange)).toBe(true);
    expect(Object.isFrozen(GREETING)).toBe(true);
    expect(Object.isFrozen(GREETING[0])).toBe(true);
    expect(Object.isFrozen(IDLE_LOOP)).toBe(true);
    expect(Object.isFrozen(PALETTE_KEYS)).toBe(true);
    expect(Object.isFrozen(FRAME_NAMES)).toBe(true);
  });

  it('throws when someone tries (modules are strict)', () => {
    expect(() => {
      (FRAMES.idle as string[])[0] = 'x';
    }).toThrow(TypeError);
    expect(() => {
      (PALETTES.orange as Record<string, string>)['B'] = '#000000';
    }).toThrow(TypeError);
  });
});
