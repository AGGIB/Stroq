import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8');

const html = read('docs/index.html');
const docsCss = read('docs/docs.css');
const docsJs = read('docs/docs.js');
const mainCss = read('styles.css');

describe('the docs page survives its own CSP', () => {
  // Same policy, same failure mode as the landing page (see csp-safe.test.ts):
  // an inline style="" attribute is silently dropped, not an error the author
  // sees, and the page still renders — just wrong.
  it('has no inline style attribute anywhere in the markup', () => {
    expect(html.match(/style="[^"]*"/g) ?? []).toEqual([]);
  });

  it('has no inline <style> or <script> block', () => {
    expect(html).not.toMatch(/<style[\s>]/i);
    // Every <script> tag must carry a src — no inline body. Only the opening tag is
    // matched: a browser ignores the body of a script that has a src, and matching
    // through to a closing tag would miss `</script >`, which ends the element too.
    for (const tag of html.match(/<script\b[^>]*>/gi) ?? []) {
      expect(tag, `inline script body: ${tag.slice(0, 80)}`).toMatch(/\bsrc=/);
    }
  });

  it('parses docs.css as one stylesheet, with every brace closed', () => {
    const opens = (docsCss.match(/\{/g) ?? []).length;
    const closes = (docsCss.match(/\}/g) ?? []).length;
    expect(opens, `${opens} "{" but ${closes} "}"`).toBe(closes);
  });
});

describe('the docs side nav', () => {
  // Every href="#x" in the side nav has to land on a real section, and every
  // section id in the nav has to actually exist as a <section id="x">
  // element — the same class of bug the README's per-agent anchors had after
  // that content moved to docs/AGENTS.md (see git history for that fix).
  it('links only to sections that exist on the page', () => {
    const navLinks = [...html.matchAll(/<nav class="docs-nav"[\s\S]*?<\/nav>/g)][0]?.[0] ?? '';
    const hrefs = [...navLinks.matchAll(/href="#([\w-]+)"/g)].map((m) => m[1]);
    expect(hrefs.length, 'no nav links found — did the nav markup move?').toBeGreaterThan(5);
    for (const id of hrefs) {
      const hasSection = new RegExp(`<section class="docs-section" id="${id}"`).test(html);
      expect(hasSection, `nav links to #${id} but no <section id="${id}"> exists`).toBe(true);
    }
  });

  // The reverse: every section should be reachable from the nav, or a reader
  // scrolling the page has no way to jump back to it later.
  it('lists every docs-section in the nav', () => {
    const sectionIds = [...html.matchAll(/<section class="docs-section" id="([\w-]+)"/g)].map(
      (m) => m[1],
    );
    expect(sectionIds.length).toBeGreaterThan(5);
    for (const id of sectionIds) {
      expect(html, `section #${id} has no nav link pointing at it`).toMatch(
        new RegExp(`href="#${id}"`),
      );
    }
  });
});

describe('the docs scroll-spy offset', () => {
  // This is the bug the offset math in docs.js exists to avoid: Chromium adds
  // <html>'s scroll-padding-top to a target's own scroll-margin-top rather
  // than taking the larger of the two, so setting scroll-margin-top on
  // .docs-section (84px) on top of the 80px already on <html> in styles.css
  // landed a clicked link 164px down instead of 80px — one section short of
  // the one that was actually clicked. Verified by hand against a live page
  // before this test was written; see the docs.js comment for the numbers.
  it('does not set its own scroll-margin-top on top of html scroll-padding-top', () => {
    expect(mainCss).toMatch(/scroll-padding-top:\s*5rem/);
    expect(docsCss).not.toMatch(/\.docs-section\s*\{[^}]*scroll-margin-top/);
  });

  // docs.js's active-section line has to track that same 80px, or the same
  // one-section-early bug comes back through the JS side instead of the CSS
  // side the moment the two drift apart.
  it('computes its active-section line from the same 80px, not a stale copy', () => {
    expect(docsJs).toMatch(/var LINE = 80 \+ \d+;/);
  });
});
