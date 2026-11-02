import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { folderSurface, repoSurface } from '../../src/exposure/repo-surface.js';

/**
 * A folder that can be entered but not listed (mode 0311) can hold a repository the walk cannot
 * see, and git finds one by the names it looks for, which need no listing. One that cannot even be
 * entered (mode 0000) is as closed to git as it is to the check, so it is not a finding: honest
 * projects have those (a database's data folder owned by another user).
 *
 * Skipped on Windows, which has no such modes, and as root, who is not held by them.
 */
const posixUser = describe.skipIf(process.platform === 'win32' || process.getuid?.() === 0);

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) {
    // A folder that cannot be listed cannot be removed until it can.
    for (const sub of ['closed', 'shut']) {
      try {
        chmodSync(join(dir, sub), 0o755);
      } catch {
        // Not made by this test.
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

const folder = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'stroq-unlistable-')));
  made.push(dir);
  mkdirSync(join(dir, 'closed', 'x.git'), { recursive: true });
  mkdirSync(join(dir, 'shut'));
  writeFileSync(join(dir, 'closed', 'HEAD'), 'ref: refs/heads/main\n');
  return dir;
};

posixUser('a folder the walk cannot list', () => {
  it('is reported when it can be entered, since a repository may be in it', () => {
    const dir = folder();
    chmodSync(join(dir, 'closed'), 0o311);
    const expected = [
      {
        kind: 'nested-bare-repo',
        file: 'closed',
        what: 'a folder the check could enter but not list, so a repository may be in it',
      },
    ];
    expect(folderSurface(dir).preTrust).toEqual(expected);
  });

  it('is reported inside a repository too', () => {
    const dir = folder();
    mkdirSync(join(dir, '.git'));
    chmodSync(join(dir, 'closed'), 0o311);
    expect(repoSurface(dir).preTrust.map((h) => `${h.kind} ${h.file}`)).toEqual([
      'nested-bare-repo closed',
    ]);
  });

  it('is not reported when it cannot be entered either: git cannot read it', () => {
    const dir = folder();
    chmodSync(join(dir, 'shut'), 0o000);
    expect(folderSurface(dir).preTrust).toEqual([]);
  });
});
