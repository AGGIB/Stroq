import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { frameToSvg } from '../../packages/cli/src/ui/mascot/render.js';
import { FRAMES, PALETTES } from '../../packages/cli/src/ui/mascot/sprites.js';

// Hoo on the landing page is not a picture somebody drew for the site: scripts/render-owl-svg.ts
// writes it from the grid and the palette the terminal draws it from. These checks hold the page to
// that, and hold the hero's words to the first screen of the README.

const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8');

const html = read('site/index.html');
const css = read('site/styles.css') + '\n' + read('site/home.css');
const readme = read('README.md');

/** The scale the script draws it at; the page sizes it in CSS, in whole multiples of the grid. */
const SCALE = 6;

const BEGIN = '<!-- owl:begin (written by scripts/render-owl-svg.ts from sprites.ts; do not edit) -->';
const END = '<!-- owl:end -->';
const between = html.slice(html.indexOf(BEGIN) + BEGIN.length, html.indexOf(END)).trim();

const textOf = (markup: string): string =>
  markup
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();

describe('Hoo on the landing page', () => {
  it('is what sprites.ts draws: the idle frame, in the orange palette', () => {
    expect(html.split(BEGIN)).toHaveLength(2);
    expect(html.split(END)).toHaveLength(2);
    expect(between).toBe(frameToSvg(FRAMES.idle, PALETTES.orange, SCALE));
    expect(between).toContain(`fill="${PALETTES.orange.B}"`);
  });

  it('stands in the hero, above the headline', () => {
    const hero = html.slice(html.indexOf('<section class="hero"'), html.indexOf('</section>'));
    expect(hero.indexOf('<div class="hoo">')).toBeGreaterThan(-1);
    expect(hero.indexOf('<div class="hoo">')).toBeLessThan(hero.indexOf('<h1'));
  });

  it('is a drawing with a name and nothing it could run or fetch', () => {
    expect(between).toMatch(/^<svg [^>]*role="img" aria-label="Hoo, the Stroq owl"/);
    expect(between).not.toMatch(/<script|<style|<image|<use|<foreignObject|href=|\son[a-z]+=|style=/i);
  });

  it('does not move', () => {
    const rules = [...css.matchAll(/([^{}]*\.hoo[^{}]*)\{([^{}]*)\}/g)];
    expect(rules.length, 'no rule for .hoo: did the stylesheet move?').toBeGreaterThan(0);
    for (const [, selector, body] of rules)
      expect(body, selector).not.toMatch(/animation|transition|@keyframes/);
  });
});

describe('the hero says what the README says', () => {
  const lead = /<p class="lead">([\s\S]*?)<\/p>/.exec(html)?.[1] ?? '';
  const promise = /<\/div>\n\n(Stroq reads[^\n]*)\n/.exec(readme)?.[1] ?? '';

  it('asks the question the README asks, as its headline', () => {
    expect(html).toContain('<h1 id="hero-title">Who is really in charge of your agent?</h1>');
    expect(readme).toContain('### Who is really in charge of your agent?');
  });

  it('has the README promise as its lead', () => {
    expect(promise, 'the README promise was not found').not.toBe('');
    expect(textOf(lead)).toBe(promise);
  });

  it('offers the same one line to run, in the text and in the copy button', () => {
    const pill = /id="install-cmd">[\s\S]*?<\/span>([^<]+)<\/code>\s*<button[^>]*data-copy="([^"]+)"/.exec(html);
    expect(pill?.[1]).toBe('npx @stroq/cli');
    expect(pill?.[2]).toBe('npx @stroq/cli');
  });
});
