import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PLATFORM_PAGES } from './platform-map';

const APP = join(process.cwd(), 'app');

describe('the platform map', () => {
  it('lists exactly the five screens, in the order of the menu', () => {
    expect(PLATFORM_PAGES.map((page) => page.label)).toEqual([
      'Check',
      'Live',
      'Agents',
      'Rules',
      'Skills & MCP',
    ]);
    expect(new Set(PLATFORM_PAGES.map((p) => p.href)).size).toBe(PLATFORM_PAGES.length);
  });

  it('has a page folder for every screen it lists', () => {
    for (const page of PLATFORM_PAGES) {
      const folder = page.href === '/' ? APP : join(APP, page.href.replace(/^\/|\/$/g, ''));
      expect(statSync(join(folder, 'page.tsx')).isFile(), page.href).toBe(true);
    }
  });

  it('has no page folder at the top of the app that the menu does not list', () => {
    const tops = readdirSync(APP, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => {
        try {
          return statSync(join(APP, name, 'page.tsx')).isFile();
        } catch {
          return false;
        }
      })
      .sort();
    expect(tops).toEqual(['agents', 'live', 'policies', 'skills']);
  });

  it('says when and what to read for every screen, without claiming protection', () => {
    for (const page of PLATFORM_PAGES) {
      expect(page.when.length, page.href).toBeGreaterThan(10);
      expect(page.read.length, page.href).toBeGreaterThan(10);
      expect(`${page.when} ${page.read}`).not.toMatch(/\b(protect\w*|safe|secure|blocked)\b/i);
    }
  });
});
