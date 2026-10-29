import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PLATFORM_PAGES, PLATFORM_SECTIONS, PLATFORM_WORDS, pagesIn } from './platform-map';

const APP = join(process.cwd(), 'app');

describe('the platform map', () => {
  it('has a page folder for every page it lists', () => {
    for (const page of PLATFORM_PAGES) {
      const folder = page.href === '/' ? APP : join(APP, page.href.replace(/^\/|\/$/g, ''));
      expect(statSync(join(folder, 'page.tsx')).isFile(), page.href).toBe(true);
    }
  });

  it('lists every top-level page of the app except settings and the guide itself', () => {
    const tops = readdirSync(APP, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((name) => {
        try {
          return statSync(join(APP, name, 'page.tsx')).isFile();
        } catch {
          return false;
        }
      });
    const listed = new Set(PLATFORM_PAGES.map((p) => p.href.replace(/^\/|\/$/g, '')));
    // `protection` is the home page's own route; settings and the guide sit outside the groups.
    const missing = tops.filter(
      (name) => !listed.has(name) && !['settings', 'guide', 'protection'].includes(name),
    );
    expect(missing).toEqual([]);
  });

  it('puts every page in exactly one known group, and every group has a page', () => {
    const ids = PLATFORM_SECTIONS.map((s) => s.id);
    for (const page of PLATFORM_PAGES) expect(ids).toContain(page.section);
    for (const id of ids) expect(pagesIn(id).length).toBeGreaterThan(0);
    expect(new Set(PLATFORM_PAGES.map((p) => p.href)).size).toBe(PLATFORM_PAGES.length);
  });

  it('says when and what to read for every page, without claiming protection', () => {
    for (const page of PLATFORM_PAGES) {
      expect(page.when.length, page.href).toBeGreaterThan(10);
      expect(page.read.length, page.href).toBeGreaterThan(10);
      expect(`${page.when} ${page.read}`).not.toMatch(/\b(protect\w*|safe|secure|blocked)\b/i);
    }
    for (const entry of PLATFORM_WORDS)
      expect(entry.meaning).not.toMatch(/\b(protects|safe|secure)\b/i);
  });

  it('keeps the daily group short', () => {
    expect(pagesIn('daily').length).toBeLessThanOrEqual(3);
  });
});
