import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runInspect } from '../../src/commands/inspect.js';
import { autorunOf, findAutorun } from '../../src/card/autorun.js';
import {
  newLab,
  newSubmodule,
  newWorktree,
  plant,
  plantedCommand,
  type Lab,
} from '../helpers/linked-git-lab.js';

/**
 * `stroq inspect` and the card's reading of folders, on linked worktrees and submodules that real
 * git made (Claude Code makes them under `.claude/worktrees`). Nothing planted is ever run: the
 * command a test plants makes `lab.marker`, and every test ends by finding it absent.
 *
 * Skipped on Windows, where these layouts need links and a user id.
 */
const posix = describe.skipIf(process.platform === 'win32');

let lab: Lab;
beforeEach(() => {
  lab = newLab();
});
afterEach(() => {
  vi.restoreAllMocks();
  expect(existsSync(lab.marker)).toBe(false);
  lab.remove();
});

interface Record_ {
  readonly isRepo: boolean;
  readonly findings: readonly { detail: string }[];
}

/** The exit code and the JSON record of `stroq inspect <dir> --json`. */
function inspect(dir: string): { code: number; record: Record_; text: string } {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  const code = runInspect([dir, '--json']);
  vi.restoreAllMocks();
  const text = chunks.join('');
  return { code, record: JSON.parse(text) as Record_, text };
}

const details = (r: Record_): string[] => r.findings.map((f) => f.detail.split(' — ')[0] ?? '');

posix('stroq inspect on a linked worktree', () => {
  it('passes the folder Claude Code keeps its worktrees in, and each worktree', () => {
    const main = join(lab.work, 'main');
    const { wt } = newWorktree(lab, main, join(main, '.claude', 'worktrees', 'x'));
    const folder = inspect(join(main, '.claude', 'worktrees'));
    expect(folder.code).toBe(0);
    expect(folder.record.findings).toEqual([]);
    const root = inspect(wt);
    expect(root.code).toBe(0);
    expect(root.record).toMatchObject({ isRepo: true, findings: [] });
  });

  it('passes a folder that holds a repository and its worktree', () => {
    newWorktree(lab, join(lab.work, 'main'), join(lab.work, 'wt'));
    expect(inspect(lab.work).record.findings).toEqual([]);
  });

  it('fails on a command in the config of the repository, named by the real path, at the worktree', () => {
    const main = join(lab.work, 'main');
    const { wt } = newWorktree(lab, main, join(main, '.claude', 'worktrees', 'x'));
    plant(join(main, '.git', 'config'), `[core]\n\tfsmonitor = ${plantedCommand(lab)}\n`);
    for (const dir of [wt, join(main, '.claude', 'worktrees')]) {
      const { code, record } = inspect(dir);
      expect(code, dir).toBe(1);
      expect(details(record), dir).toEqual([join(main, '.git', 'config')]);
      expect(record.findings[0]?.detail, dir).toContain('core.fsmonitor');
    }
  });
});

posix('stroq inspect on a submodule', () => {
  it('passes the submodule, and fails on a command in the config of its module', () => {
    const { sub, module } = newSubmodule(lab, join(lab.root, 'source'), join(lab.work, 'super'));
    expect(inspect(sub).code).toBe(0);
    expect(inspect(join(sub, '..')).code).toBe(0);
    plant(join(module, 'config'), `[core]\n\tfsmonitor = ${plantedCommand(lab)}\n`);
    for (const dir of [sub, join(sub, '..')]) {
      const { code, record } = inspect(dir);
      expect(code, dir).toBe(1);
      expect(details(record), dir).toEqual([join(module, 'config')]);
    }
  });
});

posix('the card’s count of what a folder runs by itself', () => {
  it('counts nothing for worktrees and submodules git made, and the command of their repository', () => {
    const main = join(lab.work, 'main');
    const { wt } = newWorktree(lab, main, join(main, '.claude', 'worktrees', 'x'));
    const { sub, module } = newSubmodule(lab, join(lab.root, 'source'), join(lab.work, 'super'));
    const dirs = [wt, join(main, '.claude', 'worktrees'), sub, join(sub, '..')];
    for (const dir of dirs) expect(autorunOf(dir), dir).toBeNull();
    plant(join(main, '.git', 'config'), `[core]\n\tfsmonitor = ${plantedCommand(lab)}\n`);
    plant(join(module, 'config'), `[core]\n\tsshCommand = ${plantedCommand(lab)}\n`);
    expect(autorunOf(wt)?.items).toEqual([
      { kind: 'git-config-exec', file: join(main, '.git', 'config'), name: 'core.fsmonitor' },
    ]);
    expect(autorunOf(sub)?.items).toEqual([
      { kind: 'git-config-exec', file: join(module, 'config'), name: 'core.sshcommand' },
    ]);
    const found = findAutorun(dirs, Date.now() + 60_000);
    expect(found.checked).toBe(4);
    expect(found.repos.map((r) => r.dir)).toEqual(dirs);
  });
});
