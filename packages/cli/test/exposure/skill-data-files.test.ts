import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { autorunOf } from '../../src/card/autorun.js';
import { isFailing, tagChanges } from '../../src/exposure/agent-change.js';
import { hitsForRead, MAX_FILE_BYTES } from '../../src/exposure/agent-surface.js';
import { agentSurface } from '../../src/exposure/agent-tree.js';
import { hit } from '../../src/exposure/agent-kinds.js';
import { LARGE_SCAN_CAP } from '../../src/exposure/large-text.js';
import { LEGACY_SURFACE_IO } from '../../src/exposure/surface-io.js';

/**
 * A file over `MAX_FILE_BYTES` is not read whole, and one an agent might load is reported as such, so
 * that padding a file past the cap cannot switch a check off. Under a skill, every text file counts:
 * the agent loads a skill's files as instructions. A skill's large data file (a font index of a
 * megabyte in its `scripts/data` folder) is a file an agent does not load, so it is a notice that it
 * was too large, but only after all of it was scanned, in pieces, for characters nobody reading it
 * would see (up to `LARGE_SCAN_CAP`), and found clean. A file with any, one past the cap, one that
 * could not be scanned, one past the budget of the check, and any other file of a skill, every
 * settings file among them, fails. Data is only clearly data when the folder is the skill's `data`
 * or `scripts`, the file a `.json` that no other reader takes, under every spelling a disk may open
 * it as.
 */
const SIZE = 1_100_013;
const NOT_SCANNED = { kind: 'too-large', size: SIZE } as const;
const SCANNED_CLEAN = { kind: 'too-large', size: SIZE, scan: { kind: 'clean' } } as const;
const OVER_BUDGET = { kind: 'over-budget', budget: 64 * 1024 * 1024 } as const;
const kindOf = (path: string, read: Parameters<typeof hitsForRead>[1]): string[] =>
  hitsForRead(path, read).map((h) => `${h.kind} ${h.name}`);

describe('a file too large to read', () => {
  it.each([
    '.claude/skills/impeccable/scripts/data/font-index.json',
    '.claude/skills/impeccable/data/fonts.json',
    '.claude/skills/x/scripts/lib/table.json',
    '.agents/skills/x/data/index.json',
    '.agent/skills/x/scripts/data/index.json',
    '.CLAUDE/Skills/X/Data/Index.JSON',
    'vendor/.claude/skills/x/data/index.json',
  ])(
    'is a notice, not a failure, when it is data a skill keeps and its scan found nothing: %s',
    (path) => {
      expect(kindOf(path, SCANNED_CLEAN)).toEqual(['instruction-file size']);
    },
  );

  it.each([
    '.claude/skills/impeccable/scripts/data/font-index.json',
    '.agents/skills/x/data/index.json',
  ])('still fails when it was not scanned, or the check ran out of budget: %s', (path) => {
    expect(kindOf(path, NOT_SCANNED)).toEqual(['unreadable-config size']);
    expect(kindOf(path, OVER_BUDGET)).toEqual(['unreadable-config size']);
  });

  it('fails with what the scan found, and says the file was too large too', () => {
    const path = '.claude/skills/impeccable/scripts/data/font-index.json';
    const found = hit(
      'instruction-hidden-text',
      path,
      7,
      'hidden',
      'U+200B x1 (sha256:0123456789abcdef)',
    );
    const hits = hitsForRead(path, {
      kind: 'too-large',
      size: SIZE,
      scan: { kind: 'hidden', hit: found },
    });
    expect(hits.map((h) => `${h.kind} ${h.name}`)).toEqual([
      'instruction-hidden-text hidden',
      'instruction-file size',
    ]);
    expect(hits[0]?.line).toBe(7);
  });

  it.each([
    '.claude/CLAUDE.md',
    '.claude/skills/x/SKILL.md',
    '.claude/skills/x/references/guide.md',
    '.claude/skills/x/references/big.json',
    '.claude/skills/x/big.json',
    '.claude/skills/x/scripts/run.md',
    '.claude/skills/data/big.json',
    '.claude/skills/scripts.json',
    '.claude/skills/x/data/SKILL.md',
    '.claude/skills/x/data/settings.json',
    '.claude/skills/x/data/settings.local.json',
    '.claude/skills/x/data/hooks.json',
    '.claude/skills/x/data/.mcp.json',
    '.claude/skills/x/scripts/mcp.json',
    '.claude/skills/x/data/.devcontainer/devcontainer.json',
    '.claude/skills/x/scripts/.devcontainer.json',
    '.claude/agents/data/a.json',
    '.claude/rules/data/a.json',
    '.claude/commands/scripts/a.json',
    '.claude/settings.json',
    '.claude/settings.local.json',
    '.mcp.json',
    '.vscode/tasks.json',
    '.cursor/rules/data/a.json',
    '.github/hooks/stroq.json',
    'skills/x/data/a.json',
    'data/a.json',
  ])('still fails when it is not clearly data of a skill, scan or no scan: %s', (path) => {
    expect(kindOf(path, NOT_SCANNED)).toEqual(['unreadable-config size']);
    expect(kindOf(path, SCANNED_CLEAN)).toEqual(['unreadable-config size']);
    expect(kindOf(path, OVER_BUDGET)).toEqual(['unreadable-config size']);
  });

  it('still fails under a spelling that only a disk that folds names would open as data', () => {
    // A zero-width character in `data`: the folded name is the skill's data folder, the name as written is not.
    for (const path of [
      '.claude/skills/x/da​ta/index.json',
      '.claude/skills/x/data./index.json',
      '.claude/skills/x/scr​ipts/index.json',
    ])
      expect(kindOf(path, SCANNED_CLEAN), JSON.stringify(path)).toEqual(['unreadable-config size']);
  });
});

describe('a folder with a skill whose data file is large', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'stroq-skill-data-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const make = (name: string, text: string): void => {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  };
  const DATA = '.claude/skills/impeccable/scripts/data/font-index.json';
  const filler = (n: number): string =>
    '["Inter",400,0,"x"],'.repeat(Math.ceil(n / 20)).slice(0, n);
  /** A JSON file of about `size` characters, with `hidden` put in `at` of the way through. */
  const big = (size = 1_200_000, hidden = '', at = 0.9): string => {
    const cut = Math.floor(size * at);
    return `{"entries":[${filler(cut)}${hidden}${filler(size - cut)}0]}`;
  };
  const failing = (dir = root) =>
    tagChanges(agentSurface(dir).hits, null).filter((h) => isFailing(h, 'any'));
  const kinds = (hits: readonly { kind: string; name: string }[]) =>
    hits.map((h) => `${h.kind} ${h.name}`);

  it('is a notice and not counted when all of it was scanned and nothing was hidden', () => {
    make(DATA, big());
    expect(big().length).toBeGreaterThan(MAX_FILE_BYTES);
    const hits = tagChanges(agentSurface(root).hits, null);
    expect(hits.filter((h) => isFailing(h, 'any'))).toEqual([]);
    expect(kinds(hits)).toContain('instruction-file size');
    expect(autorunOf(root)).toBeNull();
  });

  it('fails when a character nobody would see is anywhere in it, past the first megabyte too', () => {
    for (const at of [0.95, 0.9, 0.5, 0.999]) {
      make(DATA, big(1_200_000, '\u200b', at));
      expect(kinds(failing()), String(at)).toEqual(['instruction-hidden-text hidden']);
      expect(autorunOf(root)?.items.map((i) => i.kind)).toEqual(['instruction-hidden-text']);
    }
    // A tag character, which spells a message in what looks like nothing, at a megabyte and a bit.
    make(DATA, big(1_200_000, '\u{e0041}\u{e0042}', 0.92));
    expect(kinds(failing())).toEqual(['instruction-hidden-text hidden']);
  });

  it('says which line the hidden character is on', () => {
    const lines = Array.from({ length: 70_000 }, (_, i) => `["Inter",${i}],\n`).join('');
    make(DATA, `{"entries":[\n${lines}"a\u200bb"]}`);
    const [found] = failing();
    expect(found?.kind).toBe('instruction-hidden-text');
    expect(found?.line).toBe(70_002);
  });

  it('fails when the file is named by the skill and a character is hidden in it', () => {
    make(
      '.claude/skills/impeccable/SKILL.md',
      '# Fonts\nLook things up in scripts/data/font-index.json.\n',
    );
    make(DATA, big(1_200_000, '\u200b', 0.97));
    expect(kinds(failing())).toEqual(['instruction-hidden-text hidden']);
  });

  it('fails when it is past the most that is scanned', () => {
    make(DATA, '{}');
    truncateSync(join(root, DATA), LARGE_SCAN_CAP + 1);
    expect(kinds(failing())).toEqual(['unreadable-config size']);
    expect(kinds(tagChanges(agentSurface(root).hits, null))).not.toContain('instruction-file size');
    // The cap itself is scanned: this sparse file is all NUL bytes, which are characters nobody sees.
    truncateSync(join(root, DATA), LARGE_SCAN_CAP);
    expect(failing().map((h) => h.kind)).toEqual(['instruction-hidden-text']);
  });

  it('is charged to the budget of bytes one check reads, and one it cannot pay for fails', () => {
    // Three files of 30 MiB (sparse: nothing is written, and a scan stops at the first hidden
    // characters, which a file of NUL bytes is full of) against a budget of 64 MiB.
    for (const name of ['1', '2', '3']) {
      const file = `.claude/skills/impeccable/scripts/data/${name}.json`;
      make(file, '{}');
      truncateSync(join(root, file), 30 * 1024 * 1024);
    }
    const sizes = failing().filter((h) => h.name === 'size');
    expect(sizes.map((h) => `${h.kind} ${h.file}`)).toEqual([
      'unreadable-config .claude/skills/impeccable/scripts/data/3.json',
    ]);
    expect(sizes[0]?.value).toMatch(/^past the \d+ bytes one check reads$/);
  });

  it('fails when the reads are not plain reads of the disk, as in a bound capture', () => {
    make(DATA, big());
    const io = { ...LEGACY_SURFACE_IO, plainDisk: false };
    expect(
      kinds(tagChanges(agentSurface(root, io).hits, null).filter((h) => isFailing(h, 'any'))),
    ).toEqual(['unreadable-config size']);
  });

  it('still fails for the same size anywhere else under the skill', () => {
    make('.claude/skills/impeccable/references/font-index.json', big());
    expect(kinds(failing())).toEqual(['unreadable-config size']);
    expect(autorunOf(root)?.items.map((i) => `${i.kind} ${i.name}`)).toEqual([
      'unreadable-config size',
    ]);
  });

  it('still reads a data file that is not too large, for characters nobody would see', () => {
    make(
      '.claude/skills/impeccable/scripts/data/notes.json',
      `{"note":"read this \u{E0041}\u{E0042} first"}`,
    );
    expect(failing().map((h) => h.kind)).toEqual(['instruction-hidden-text']);
  });
});
