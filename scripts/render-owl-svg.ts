// Writes the owl on the landing page (site/index.html) and the three owls of the console's Check
// screen (console/public/hoo/) from the same grid and palette the terminal draws it from, so neither
// is a copy that can drift from packages/cli/src/ui/mascot/sprites.ts. The default mode replaces what
// stands between the two `owl:` comments in the page and writes the console's files; `--check` (CI)
// draws them in memory and exits 1 when anything on disk holds something else, writing nothing.
//
//   pnpm owl:svg            rewrite the owl in site/index.html and console/public/hoo/
//   pnpm owl:svg --check    fail if either is not what sprites.ts draws
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { frameToSvg } from '../packages/cli/src/ui/mascot/render.js';
import { FRAMES, PALETTES } from '../packages/cli/src/ui/mascot/sprites.js';

const root = resolve(import.meta.dirname, '..');
const page = resolve(root, 'site/index.html');
const consoleOwls = resolve(root, 'console/public/hoo');

const BEGIN =
  '<!-- owl:begin (written by scripts/render-owl-svg.ts from sprites.ts; do not edit) -->';
const END = '<!-- owl:end -->';

/** The grid is 20 pixels wide: a whole number of screen pixels for each, so that the edges stay sharp. */
export const SCALE = 6;

/** The console's Check screen shows the owl that says the result: found something, nothing, or no sessions. */
export const CONSOLE_FRAMES = ['alert', 'happy', 'idle'] as const;

/** The console draws it larger, still in whole multiples of the grid. */
export const CONSOLE_SCALE = 8;

/** The files of `console/public/hoo/`, by name. */
export const consoleOwlFiles = (): Readonly<Record<string, string>> =>
  Object.fromEntries(
    CONSOLE_FRAMES.map((frame) => [
      `${frame}.svg`,
      `${frameToSvg(FRAMES[frame], PALETTES.orange, CONSOLE_SCALE)}\n`,
    ]),
  );

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
  const check = process.argv.includes('--check');
  const current = readFileSync(page, 'utf8');
  const next = withOwl(current, owlSvg());
  const stale: string[] = next === current ? [] : ['site/index.html'];
  if (!check && next !== current) writeFileSync(page, next);
  for (const [name, svg] of Object.entries(consoleOwlFiles())) {
    const file = resolve(consoleOwls, name);
    if (existsSync(file) && readFileSync(file, 'utf8') === svg) continue;
    stale.push(`console/public/hoo/${name}`);
    if (!check) {
      mkdirSync(consoleOwls, { recursive: true });
      writeFileSync(file, svg);
    }
  }
  if (check && stale.length > 0) {
    process.stderr.write(
      `${stale.join(', ')}: the owl is not what sprites.ts draws; run \`pnpm owl:svg\`\n`,
    );
    return 1;
  }
  return 0;
}

process.exitCode = main();
