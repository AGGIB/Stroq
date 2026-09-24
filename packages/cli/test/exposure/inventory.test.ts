import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compareInventory, readInventory, writeInventory } from '../../src/exposure/inventory.js';

const file = (): string => join(mkdtempSync(join(tmpdir(), 'stroq-inventory-')), 'inventory.json');

describe('compareInventory', () => {
  it('records a baseline the first time, and reports nothing as new', () => {
    expect(compareInventory(null, { '/a/SKILL.md': 'h1' })).toEqual({
      baseline: true,
      added: [],
      changed: [],
    });
  });

  it('names files that appeared and files whose content changed, not ones that went away', () => {
    const drift = compareInventory(
      { '/a/SKILL.md': 'h1', '/gone.md': 'h0', '/same.md': 's' },
      { '/a/SKILL.md': 'h2', '/b/CLAUDE.md': 'h3', '/same.md': 's' },
    );
    expect(drift).toEqual({ baseline: false, added: ['/b/CLAUDE.md'], changed: ['/a/SKILL.md'] });
  });
});

describe('the inventory file', () => {
  it('round-trips, readable only by the user', () => {
    const f = file();
    writeInventory(f, { '/a/SKILL.md': 'h1' });
    expect(readInventory(f)).toEqual({ '/a/SKILL.md': 'h1' });
    if (process.platform !== 'win32') expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(f, 'utf8')).version).toBe(1);
  });

  it('reads a missing or unreadable file as no baseline, not as an empty machine', () => {
    const f = file();
    expect(readInventory(f)).toBeNull();
    writeFileSync(f, '{ not json');
    expect(readInventory(f)).toBeNull();
    writeFileSync(f, JSON.stringify({ version: 1, files: { '/x': 7 } }));
    expect(readInventory(f)).toBeNull();
  });
});
