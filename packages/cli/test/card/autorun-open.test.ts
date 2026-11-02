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
      'reference-transaction',
      'fsmonitor-watchman',
      '3 more hook files, which were not read',
      'a folder of hooks the check could enter but not list',
    ])
      expect(runsOnOpen({ kind: 'git-hook-routine', what }), what).toBe(true);
  });

  it('leaves out the core.hooksPath key itself, whose hooks are judged one by one, and keeps every other key', () => {
    expect(runsOnOpen({ kind: 'git-config-exec', what: 'core.hooksPath' })).toBe(false);
    expect(runsOnOpen({ kind: 'git-config-exec', what: 'core.fsmonitor' })).toBe(true);
    expect(runsOnOpen({ kind: 'git-config-exec', what: 'lfs.customtransfer.x.path' })).toBe(true);
    expect(runsOnOpen({ kind: 'nested-bare-repo', what: 'x.git' })).toBe(true);
  });
});
