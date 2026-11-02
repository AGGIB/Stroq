// Writes the owl on the landing page (site/index.html) from the same grid and palette the terminal
// draws it from, so the site's owl is never a copy that can drift from packages/cli/src/ui/mascot/
// sprites.ts. The default mode replaces what stands between the two `owl:` comments in the page;
// `--check` (CI) draws it in memory and exits 1 when the page holds something else, writing nothing.
//
//   pnpm owl:svg            rewrite the owl in site/index.html
//   pnpm owl:svg --check    fail if the owl in site/index.html is not what sprites.ts draws
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { frameToSvg } from '../packages/cli/src/ui/mascot/render.js';
import { FRAMES, PALETTES } from '../packages/cli/src/ui/mascot/sprites.js';

const root = resolve(import.meta.dirname, '..');
const page = resolve(root, 'site/index.html');

const BEGIN =
  '<!-- owl:begin (written by scripts/render-owl-svg.ts from sprites.ts; do not edit) -->';
const END = '<!-- owl:end -->';

/** The grid is 20 pixels wide: a whole number of screen pixels for each, so that the edges stay sharp. */
export const SCALE = 6;

/** The owl as the site shows it: the idle frame, in the orange palette the owner chose. */
export const owlSvg = (): string => frameToSvg(FRAMES.idle, PALETTES.orange, SCALE);

/** `html` with whatever stands between the two comments replaced by `svg`; throws if they are not there once each. */
export function withOwl(html: string, svg: string): string {
  const start = html.indexOf(BEGIN);
  const end = html.indexOf(END);
  if (start === -1 || end === -1 || end < start || html.indexOf(BEGIN, start + 1) !== -1)
    throw new Error(`${page} must hold exactly one "${BEGIN}" before one "${END}"`);
  return `${html.slice(0, start + BEGIN.length)}\n${svg}\n${html.slice(end)}`;
}

function main(): number {
  const current = readFileSync(page, 'utf8');
  const next = withOwl(current, owlSvg());
  if (process.argv.includes('--check')) {
    if (next === current) return 0;
    process.stderr.write(
      'site/index.html: the owl is not what sprites.ts draws; run `pnpm owl:svg`\n',
    );
    return 1;
  }
  if (next !== current) writeFileSync(page, next);
  return 0;
}

process.exitCode = main();
