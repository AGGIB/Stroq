import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { autorunOf } from '../../src/card/autorun.js';
import { isFailing, tagChanges } from '../../src/exposure/agent-change.js';
import { hitsForRead, MAX_FILE_BYTES } from '../../src/exposure/agent-surface.js';
import { agentSurface } from '../../src/exposure/agent-tree.js';

/**
 * A file over `MAX_FILE_BYTES` is not read, and one an agent might load is reported as such, so that
 * padding a file past the cap cannot switch a check off. Under a skill, every text file counts: the
 * agent loads a skill's files as instructions. A skill's large data file (a font index of a megabyte
 * in its `scripts/data` folder) is a file an agent does not load, so it is a notice that it was not
 * read, and no more; any other file of a skill, and every settings file, still fails when it is too
 * large. Skipped when it is not clearly data: the folder must be the skill's `data` or `scripts`, the
 * file a `.json` that no other reader takes, under every spelling a disk may open it as.
 */
const TOO_LARGE = { kind: 'too-large', size: 1_100_013 } as const;
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
  ])('is a notice, not a failure, when it is data a skill keeps: %s', (path) => {
    expect(kindOf(path, TOO_LARGE)).toEqual(['instruction-file size']);
    expect(kindOf(path, OVER_BUDGET)).toEqual(['instruction-file size']);
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
  ])('still fails when it is not clearly data of a skill: %s', (path) => {
    expect(kindOf(path, TOO_LARGE)).toEqual(['unreadable-config size']);
    expect(kindOf(path, OVER_BUDGET)).toEqual(['unreadable-config size']);
  });

  it('still fails under a spelling that only a disk that folds names would open as data', () => {
    // A zero-width character in `data`: the folded name is the skill's data folder, the name as written is not.
    for (const path of [
      '.claude/skills/x/da​ta/index.json',
      '.claude/skills/x/data./index.json',
      '.claude/skills/x/scr​ipts/index.json',
    ])
      expect(kindOf(path, TOO_LARGE), JSON.stringify(path)).toEqual(['unreadable-config size']);
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
  const big = (): string => `{"entries":[${'["Inter",400,0,"x"],'.repeat(60_000)}0]}`;

  it('fails nothing, and the card does not count it', () => {
    make('.claude/skills/impeccable/scripts/data/font-index.json', big());
    expect(big().length).toBeGreaterThan(MAX_FILE_BYTES);
    const hits = tagChanges(agentSurface(root).hits, null);
    expect(hits.filter((h) => isFailing(h, 'any'))).toEqual([]);
    expect(hits.map((h) => `${h.kind} ${h.name}`)).toContain('instruction-file size');
    expect(autorunOf(root)).toBeNull();
  });

  it('still fails for the same size anywhere else under the skill', () => {
    make('.claude/skills/impeccable/references/font-index.json', big());
    const failing = tagChanges(agentSurface(root).hits, null).filter((h) => isFailing(h, 'any'));
    expect(failing.map((h) => `${h.kind} ${h.name}`)).toEqual(['unreadable-config size']);
    expect(autorunOf(root)?.items.map((i) => `${i.kind} ${i.name}`)).toEqual([
      'unreadable-config size',
    ]);
  });

  it('still reads a data file that is not too large, for characters nobody would see', () => {
    make(
      '.claude/skills/impeccable/scripts/data/notes.json',
      `{"note":"read this \u{E0041}\u{E0042} first"}`,
    );
    const failing = tagChanges(agentSurface(root).hits, null).filter((h) => isFailing(h, 'any'));
    expect(failing.map((h) => h.kind)).toEqual(['instruction-hidden-text']);
  });
});
