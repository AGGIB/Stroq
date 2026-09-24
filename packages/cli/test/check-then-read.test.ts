import type { OpenMode, PathLike } from 'node:fs';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readJsonObject } from '../src/commands/config-file.js';
import { repoSurface } from '../src/exposure/repo-surface.js';

/**
 * The race, made deterministic: right after the code under test first stats or opens
 * `race.path`, the symlink there is re-pointed at another file. That is what a process
 * running beside Stroq could do between a check and the read that trusts it. Code that
 * checks one handle and reads that same handle never sees the swap; code that stats a
 * path and then reads it again by name reads the file the check never looked at.
 */
const race = vi.hoisted(() => ({ path: '', swap: undefined as (() => void) | undefined }));

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const thenSwap =
    <A extends [PathLike, ...unknown[]], R>(fn: (...args: A) => R) =>
    (...args: A): R => {
      const result = fn(...args);
      const swap = race.swap;
      if (swap !== undefined && String(args[0]) === race.path) {
        race.swap = undefined;
        swap();
      }
      return result;
    };
  return {
    ...fs,
    statSync: thenSwap(fs.statSync as (path: PathLike) => ReturnType<typeof fs.statSync>),
    openSync: thenSwap(fs.openSync as (path: PathLike, flags?: OpenMode) => number),
  };
});

const dirs: string[] = [];
afterEach(() => {
  race.swap = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** `link` points at `checked` until the first stat or open of it, then at `swapped`. */
function swapAfterCheck(link: string, checked: string, swapped: string): void {
  symlinkSync(checked, link);
  race.path = link;
  race.swap = () => {
    unlinkSync(link);
    symlinkSync(swapped, link);
  };
}

describe('a file re-pointed between the check and the read', () => {
  it('readJsonObject parses the agent config it checked, not one past the size bound', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stroq-race-config-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'small.json'), '{"a":1}');
    writeFileSync(join(dir, 'huge.json'), `{"b":"${'x'.repeat(5 * 1024 * 1024)}"}`);
    const file = join(dir, 'settings.json');
    swapAfterCheck(file, join(dir, 'small.json'), join(dir, 'huge.json'));
    // Keys, not the object: on failure the object is five megabytes of assertion diff.
    expect(Object.keys(readJsonObject(file))).toEqual(['a']);
    // The swap ran, so the test raced the read rather than passing because it never did.
    expect(race.swap).toBeUndefined();
  });

  it('repoSurface reports the .git/config it checked, not one past the size bound', () => {
    const root = mkdtempSync(join(tmpdir(), 'stroq-race-repo-'));
    dirs.push(root);
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, 'checked.config'), '[core]\n\tfsmonitor = ./checked.sh\n');
    writeFileSync(
      join(root, 'swapped.config'),
      `[core]\n\tsshCommand = ./swapped.sh\n${'# padding\n'.repeat(30_000)}`,
    );
    swapAfterCheck(
      join(root, '.git', 'config'),
      join(root, 'checked.config'),
      join(root, 'swapped.config'),
    );
    expect(repoSurface(root).preTrust.map((h) => h.what)).toEqual(['core.fsmonitor']);
    expect(race.swap).toBeUndefined();
  });
});
