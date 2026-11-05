import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The left panel is as tall as the page and sticks to the top of the window. It used to be fixed to
// the window, which draws it only as tall as the window: on a page taller than the screen a full-page
// screenshot showed it ending under "On this machine" while the page went on. A browser cannot be run
// in this suite, so these hold the rules that make it so; the layout was checked in a real browser.

const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8');

/** What is between the braces that open at `open`, and where they close. */
function braces(text: string, open: number): { body: string; end: number } {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    if (text[i] === '}' && (depth -= 1) === 0) return { body: text.slice(open + 1, i), end: i };
  }
  throw new Error('unbalanced braces');
}

/** The declarations of the rule for `selector` (as the whole of a selector list's tail) in `text`. */
function rule(text: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|[\\s}])${escaped}\\s*\\{`, 'm').exec(text);
  if (match === null) throw new Error(`no rule for ${selector}`);
  return braces(text, match.index + match[0].length - 1).body;
}

/** The inside of the `@media` block that opens with `query`. */
function media(query: string): string {
  const at = css.indexOf(`@media (${query}) {`);
  if (at === -1) throw new Error(`no @media (${query})`);
  return braces(css, css.indexOf('{', at)).body;
}

describe('the left panel', () => {
  it('is a column of the page, as tall as the page, and not fixed to the window', () => {
    const shell = rule(css, '.platform-shell');
    expect(shell).toMatch(/display:\s*grid/);
    expect(shell).toMatch(/grid-template-columns:\s*var\(--sidebar-width\)\s+minmax\(0,\s*1fr\)/);
    const panel = rule(css, '.desktop-sidebar');
    expect(panel).not.toMatch(/position:\s*fixed/);
    expect(panel).toMatch(/position:\s*relative/);
    expect(panel).toMatch(/background:\s*var\(--sidebar\)/);
    expect(panel).toMatch(/border-right:/);
    // The page no longer makes room for it with a margin: the grid column does.
    expect(css).not.toMatch(/\.workspace-main\s*\{[^}]*margin-left/);
  });

  it('keeps what it holds at the top of the window, a window tall, scrolling by itself', () => {
    const inner = rule(css, '.sidebar-sticky');
    expect(inner).toMatch(/position:\s*sticky/);
    expect(inner).toMatch(/top:\s*0/);
    expect(inner).toMatch(/height:\s*100vh/);
    expect(inner).toMatch(/height:\s*100dvh/);
    expect(inner).toMatch(/overflow-y:\s*auto/);
    expect(inner).toMatch(/display:\s*flex/);
    expect(inner).toMatch(/flex-direction:\s*column/);
  });

  it('takes its colour from a variable the light and the dark theme both define', () => {
    const definitions = css.match(/^\s*--sidebar:\s*#[0-9a-f]{3,8};/gm) ?? [];
    expect(definitions.length).toBeGreaterThanOrEqual(4);
    expect(css).toMatch(/\.dark\s*\{[^}]*--sidebar:/);
    expect(css).toMatch(/:root\s*\{[^}]*--sidebar:/);
  });

  it('is narrower on a narrow window, through the grid column', () => {
    const narrow = media('max-width: 1150px');
    expect(rule(narrow, '.platform-shell')).toMatch(/--sidebar-width:\s*216px/);
    expect(rule(narrow, '.sidebar-sticky')).toMatch(/padding-inline:\s*12px/);
  });

  it('is gone on a phone, where the menu opens from the top bar and the page has the whole width', () => {
    const phone = media('max-width: 650px');
    expect(rule(phone, '.desktop-sidebar')).toMatch(/display:\s*none/);
    expect(rule(phone, '.platform-shell')).toMatch(/display:\s*block/);
    // Nothing keeps a margin for a panel that is not there.
    expect(phone).not.toMatch(/\.workspace-main/);
  });
});
