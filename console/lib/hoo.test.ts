import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { frameToSvg } from '../../packages/cli/src/ui/mascot/render';
import { FRAMES, PALETTES } from '../../packages/cli/src/ui/mascot/sprites';
import { OWL_FRAMES, owlSrc } from './card';

const read = (frame: string): string =>
  readFileSync(join(process.cwd(), 'public', 'hoo', `${frame}.svg`), 'utf8');

describe('the owl on the Check screen', () => {
  it.each(OWL_FRAMES)(
    'is what the terminal draws for %s: the same grid, the orange palette',
    (frame) => {
      expect(read(frame)).toBe(`${frameToSvg(FRAMES[frame], PALETTES.orange, 8)}\n`);
    },
  );

  it.each(OWL_FRAMES)('%s is a drawing and nothing it could run or fetch', (frame) => {
    const svg = read(frame);
    expect(svg).toMatch(/^<svg [^>]*role="img"/);
    expect(svg).not.toMatch(/<script|<style|<image|<use|<foreignObject|href=|\son[a-z]+=|style=/i);
  });

  it('is served from one folder, by frame', () => {
    expect(OWL_FRAMES.map(owlSrc)).toEqual(['/hoo/alert.svg', '/hoo/happy.svg', '/hoo/idle.svg']);
  });
});
