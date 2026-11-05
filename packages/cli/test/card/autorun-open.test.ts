import { describe, expect, it } from 'vitest';
import { runsOnOpen } from '../../src/card/autorun.js';

describe('runsOnOpen: what the card counts as running when an agent opens a folder', () => {
  it('leaves out hooks git runs only on commit, push or rebase, in every wording inspect uses', () => {
    for (const what of [
      'pre-commit',
      'pre-commit, a commit hook that nothing here shows git made',
      'commit-msg',
      'pre-push, whose text downloads and runs code, sends a secret out, or could not be read',
      'post-rewrite',
    ])
      expect(runsOnOpen({ kind: 'git-hook-routine', what }), what).toBe(false);
  });

  it('keeps the hooks git runs on checkout, merge or status, and anything it cannot name', () => {
    for (const what of [
      'post-checkout',
      'post-merge',
      'pre-auto-gc',
      'push-to-checkout',
      'a-hook-git-does-not-have',
      'reference-transaction',
      'fsmonitor-watchman',
      '3 more hook files, which were not read',
      'a folder of hooks the check could enter but not list',
    ])
      expect(runsOnOpen({ kind: 'git-hook-routine', what }), what).toBe(true);
  });

  it('leaves out a core.hooksPath key only when the hooks it names were judged, and keeps every other key', () => {
    expect(runsOnOpen({ kind: 'git-config-exec', what: 'core.hookspath', hooksJudged: true })).toBe(
      false,
    );
    // A folder that could not be placed (`~`, a variable, a root repository's own reading): the key counts.
    expect(runsOnOpen({ kind: 'git-config-exec', what: 'core.hookspath' })).toBe(true);
    expect(runsOnOpen({ kind: 'git-config-exec', what: 'core.fsmonitor' })).toBe(true);
    expect(runsOnOpen({ kind: 'git-config-exec', what: 'lfs.customtransfer.x.path' })).toBe(true);
    // A bare repository found by its shape alone runs nothing; its config is judged as findings of its own.
    expect(runsOnOpen({ kind: 'nested-bare-repo', what: 'HEAD, objects, refs' })).toBe(false);
    // What could not be seen still counts: a pointer elsewhere, an unlistable folder, anything else.
    for (const what of [
      'a .git file, which points git at the folder of another repository',
      'a folder the check could enter but not list, so a repository may be in it',
      'x.git',
    ])
      expect(runsOnOpen({ kind: 'nested-bare-repo', what }), what).toBe(true);
  });
});
