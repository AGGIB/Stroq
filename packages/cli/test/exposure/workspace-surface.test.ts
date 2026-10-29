import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  captureWorkspaceSurface,
  recheckWorkspaceSurface,
} from '../../src/exposure/workspace-surface.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(files: Record<string, string | Uint8Array> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'stroq-workspace-surface-'));
  roots.push(root);
  for (const [name, bytes] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), bytes);
  }
  return root;
}

describe('workspace capture', () => {
  it('reuses current detectors without executing workspace commands', () => {
    const project = fixture({
      '.git/config': '[core]\nfsmonitor = touch should-not-run\n',
      '.vscode/tasks.json': JSON.stringify({
        tasks: [
          { label: 'run', command: 'touch should-not-run', runOptions: { runOn: 'folderOpen' } },
        ],
      }),
      '.envrc': 'touch should-not-run\n',
    });
    const capture = captureWorkspaceSurface({ project });
    expect(capture.repo.preTrust.some((hit) => hit.kind === 'git-config-exec')).toBe(true);
    expect(capture.agent.hits.some((hit) => hit.kind === 'editor-autorun-task')).toBe(true);
    expect(capture.observations).toEqual([]);
    expect(() => readFileSync(join(project, 'should-not-run'))).toThrow();
    expect(recheckWorkspaceSurface(capture.privateBinding)).toBe(true);
  });

  it('keeps semantic review stable for ordinary files and detects relevant bytes and modes', () => {
    const project = fixture({ 'package.json': '{"scripts":{"prepare":"tsc"}}' });
    const first = captureWorkspaceSurface({ project });
    writeFileSync(join(project, 'ordinary.ts'), 'export const x = 1;');
    const second = captureWorkspaceSurface({ project });
    expect(second.manifestSha256).toBe(first.manifestSha256);
    expect(recheckWorkspaceSurface(first.privateBinding)).toBe(false);
    writeFileSync(join(project, 'package.json'), '{"scripts":{"prepare":"tsc -b"}}');
    expect(captureWorkspaceSurface({ project }).manifestSha256).not.toBe(second.manifestSha256);
    if (process.platform !== 'win32') {
      const third = captureWorkspaceSurface({ project });
      chmodSync(join(project, 'package.json'), 0o700);
      expect(captureWorkspaceSurface({ project }).manifestSha256).not.toBe(third.manifestSha256);
    }
  });

  it.skipIf(process.platform === 'win32')(
    'ignores unrelated external and dangling aliases without reading their targets',
    () => {
      const external = fixture({ private: 'not-a-source' });
      const project = fixture({ '.claude/settings.json': '{}' });
      const first = captureWorkspaceSurface({ project });
      symlinkSync(join(external, 'private'), join(project, 'ordinary-link'));
      symlinkSync('not-present', join(project, 'ordinary-dangling'));
      const next = captureWorkspaceSurface({ project });
      expect(next.complete).toBe(true);
      expect(next.manifestSha256).toBe(first.manifestSha256);
      expect(next.sources.some((source) => source.path.includes('ordinary-'))).toBe(false);
      expect(recheckWorkspaceSurface(next.privateBinding)).toBe(true);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'records invalid UTF-8 and refused external links instead of an empty healthy capture',
    () => {
      const external = fixture({ config: '{"tasks":[]}' });
      const project = fixture({ '.claude/settings.json': Uint8Array.from([0xff, 0xfe]) });
      mkdirSync(join(project, '.vscode'));
      symlinkSync(join(external, 'config'), join(project, '.vscode/tasks.json'));
      const capture = captureWorkspaceSurface({ project });
      expect(capture.observations.some((row) => row.code === 'invalid-utf8')).toBe(true);
      expect(capture.observations.some((row) => row.code === 'outside-root')).toBe(true);
    },
  );

  it('reads fixed metadata of a backlink-verified linked worktree', () => {
    const common = fixture({
      config: '[core]\nfsmonitor = do-not-execute\n',
      'hooks/post-checkout': '#!/bin/sh\ntouch should-not-run\n',
    });
    const project = fixture();
    const gitdir = join(realpathSync(common), 'worktrees', 'selected');
    mkdirSync(gitdir, { recursive: true });
    writeFileSync(join(project, '.git'), `gitdir: ${gitdir}\n`);
    writeFileSync(join(gitdir, 'gitdir'), `${join(project, '.git')}\n`);
    writeFileSync(join(gitdir, 'commondir'), '../..\n');
    chmodSync(join(common, 'hooks/post-checkout'), 0o700);
    const capture = captureWorkspaceSurface({ project });
    expect(capture.observations).toEqual([]);
    expect(capture.repo.isRepo).toBe(true);
    expect(capture.repo.preTrust.some((hit) => hit.kind === 'git-config-exec')).toBe(true);
    expect(capture.repo.preTrust.some((hit) => hit.kind === 'git-hook-routine')).toBe(true);
    expect(capture.observations).toEqual([]);
    expect(capture.sources.some((source) => source.role === 'git-metadata')).toBe(true);
    expect(JSON.stringify(capture.repo)).not.toContain(common);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'does not turn failed reads or unsupported config shapes into complete empty evidence',
    () => {
      const project = fixture({ '.claude/settings.json': '[]', '.vscode/tasks.json': '{}' });
      chmodSync(join(project, '.vscode/tasks.json'), 0);
      try {
        const capture = captureWorkspaceSurface({ project });
        expect(capture.complete).toBe(false);
        expect(
          capture.observations.some(
            (row) => row.code === 'unparsed' && row.path === '.claude/settings.json',
          ),
        ).toBe(true);
        expect(
          capture.observations.some(
            (row) => row.code === 'unreadable' && row.path === '.vscode/tasks.json',
          ),
        ).toBe(true);
      } finally {
        chmodSync(join(project, '.vscode/tasks.json'), 0o600);
      }
    },
  );

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'records unreadable directory discovery instead of treating it as an empty subtree',
    () => {
      const project = fixture({ 'hidden/.claude/settings.json': '{}' });
      chmodSync(join(project, 'hidden'), 0);
      try {
        const capture = captureWorkspaceSurface({ project });
        expect(capture.complete).toBe(false);
        expect(capture.observations.some((row) => row.code === 'unreadable')).toBe(true);
      } finally {
        chmodSync(join(project, 'hidden'), 0o700);
      }
    },
  );

  it('captures nested Git structure without adding unrelated directory names to semantic review', () => {
    const project = fixture({
      'nested/HEAD': 'ref: refs/heads/main\n',
      'nested/config': '[core]\nfsmonitor = do-not-run\n',
    });
    mkdirSync(join(project, 'nested/objects'));
    mkdirSync(join(project, 'nested/refs'));
    const first = captureWorkspaceSurface({ project });
    expect(
      first.sources.some((source) => source.path === 'nested' && source.kind === 'directory'),
    ).toBe(true);
    writeFileSync(join(project, 'nested/ordinary.txt'), 'ignored');
    const second = captureWorkspaceSurface({ project });
    expect(second.manifestSha256).toBe(first.manifestSha256);
    expect(recheckWorkspaceSurface(first.privateBinding)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'allows internal source aliases while refusing hardlinks and bounded oversized sources',
    () => {
      const project = fixture({
        'target.json': '{}',
        'oversized/.claude/settings.json': ' '.repeat(1024 * 1024 + 1),
      });
      mkdirSync(join(project, '.claude'));
      symlinkSync('../target.json', join(project, '.claude/settings.json'));
      let capture = captureWorkspaceSurface({ project });
      expect(capture.observations.some((row) => row.code === 'too-large')).toBe(true);
      rmSync(join(project, 'oversized'), { recursive: true });
      capture = captureWorkspaceSurface({ project });
      expect(capture.complete).toBe(true);
      rmSync(join(project, '.claude/settings.json'));
      linkSync(join(project, 'target.json'), join(project, '.claude/settings.json'));
      expect(
        captureWorkspaceSurface({ project }).observations.some((row) => row.code === 'not-regular'),
      ).toBe(true);
    },
  );

  it('keeps caps explicit and never reports an expired capture as complete', () => {
    const project = fixture({ '.claude/settings.json': '{}', '.cursor/hooks.json': '{}' });
    expect(captureWorkspaceSurface({ project, limits: { maxFiles: 1 } }).complete).toBe(false);
    const expired = captureWorkspaceSurface({ project, deadline: Date.now() - 1 });
    expect(expired.complete).toBe(false);
    expect(expired.observations.some((row) => row.code === 'limit')).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('refuses FIFOs without waiting for a writer', () => {
    const project = fixture();
    mkdirSync(join(project, '.claude'));
    execFileSync('/usr/bin/mkfifo', [join(project, '.claude/settings.json')]);
    const capture = captureWorkspaceSurface({ project });
    expect(capture.complete).toBe(false);
    expect(capture.observations.some((row) => row.code === 'not-regular')).toBe(true);
  });

  it('rechecks relevant file bytes, permissions and absent optional sources', () => {
    const project = fixture({ '.claude/settings.json': '{}' });
    const first = captureWorkspaceSurface({ project });
    writeFileSync(join(project, '.claude/settings.json'), '{"hooks":{}}');
    expect(recheckWorkspaceSurface(first.privateBinding)).toBe(false);
    const second = captureWorkspaceSurface({ project });
    if (process.platform !== 'win32') {
      chmodSync(join(project, '.claude/settings.json'), 0o700);
      expect(recheckWorkspaceSurface(second.privateBinding)).toBe(false);
    }
    const third = captureWorkspaceSurface({ project });
    writeFileSync(join(project, '.envrc'), 'true\n');
    expect(recheckWorkspaceSurface(third.privateBinding)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'does not read a Git configuration symlink even when it points inside the workspace',
    () => {
      const project = fixture({ sensitive: '[core]\nfsmonitor=never-read-this\n' });
      mkdirSync(join(project, '.git'));
      symlinkSync('../sensitive', join(project, '.git/config'));
      const capture = captureWorkspaceSurface({ project });
      expect(capture.complete).toBe(false);
      expect(capture.sources.some((source) => source.path === 'sensitive')).toBe(false);
      expect(capture.observations.some((row) => row.code === 'git-metadata-unverified')).toBe(true);
    },
  );

  it('refuses a git directory that names another common directory, which Git would read instead', () => {
    // `.git/commondir` is honoured for any git directory: its configuration and hooks come from the
    // folder it names, and nothing in the project's own `.git/config` shows that.
    const project = fixture({
      '.git/HEAD': 'ref: refs/heads/main\n',
      '.git/config': '[core]\n\trepositoryformatversion = 0\n',
      '.git/commondir': '../elsewhere\n',
      'elsewhere/config': '[core]\n\tfsmonitor = never-read-this\n',
    });
    const capture = captureWorkspaceSurface({ project });
    expect(capture.complete).toBe(false);
    expect(capture.observations.some((row) => row.code === 'git-metadata-unverified')).toBe(true);
    expect(capture.sources.some((source) => source.path.includes('elsewhere'))).toBe(false);
  });

  it('refuses a foreign worktree backlink before reading common configuration', () => {
    const common = fixture({
      config: '[core]\nfsmonitor=never-read\n',
      'worktrees/foreign/gitdir': '/not-selected/.git\n',
      'worktrees/foreign/commondir': '../..\n',
    });
    const project = fixture({
      '.git': `gitdir: ${join(realpathSync(common), 'worktrees/foreign')}\n`,
    });
    const capture = captureWorkspaceSurface({ project });
    expect(capture.complete).toBe(false);
    expect(capture.observations.some((row) => row.code === 'git-metadata-unverified')).toBe(true);
    expect(capture.sources.some((source) => source.path === 'common/config')).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a worktree pointer whose named target is a symlink',
    () => {
      const common = fixture({
        'worktrees/selected/gitdir': '',
        'worktrees/selected/commondir': '../..\n',
      });
      const project = fixture();
      writeFileSync(
        join(common, 'worktrees/selected/gitdir'),
        `${join(realpathSync(project), '.git')}\n`,
      );
      symlinkSync(join(realpathSync(common), 'worktrees/selected'), join(common, 'alias'));
      writeFileSync(join(project, '.git'), `gitdir: ${join(realpathSync(common), 'alias')}\n`);
      expect(captureWorkspaceSurface({ project }).complete).toBe(false);
    },
  );

  it('excludes only the explicit Stroq data subtree and binds the declared exclusion', () => {
    const project = fixture({
      'private-stroq/.claude/settings.json':
        '{"hooks":{"SessionStart":[{"command":"must-not-be-live"}]}}',
      '.claude/settings.json': '{}',
    });
    const home = join(project, 'private-stroq');
    const first = captureWorkspaceSurface({ project, ignoredRoots: [home] });
    expect(first.complete).toBe(true);
    expect(first.exclusions).toHaveLength(1);
    expect(first.sources.some((source) => source.path.startsWith('private-stroq/'))).toBe(false);
    expect(
      first.privateBinding.dependencies.some((dependency) =>
        dependency.path.includes('/private-stroq/'),
      ),
    ).toBe(false);
    writeFileSync(join(home, 'baseline.json'), 'private-store-change');
    expect(recheckWorkspaceSurface(first.privateBinding)).toBe(true);
    expect(captureWorkspaceSurface({ project, ignoredRoots: [home] }).manifestSha256).toBe(
      first.manifestSha256,
    );
    expect(captureWorkspaceSurface({ project }).manifestSha256).not.toBe(first.manifestSha256);
  });

  it.skipIf(process.platform === 'win32')(
    'does not reach excluded store descendants through a workspace alias',
    () => {
      const project = fixture({
        'private-stroq/stored/SKILL.md': 'retained source must not be read',
      });
      mkdirSync(join(project, '.claude/skills'), { recursive: true });
      symlinkSync('../../private-stroq/stored', join(project, '.claude/skills/retained'));
      const capture = captureWorkspaceSurface({
        project,
        ignoredRoots: [join(project, 'private-stroq')],
      });
      expect(capture.complete).toBe(false);
      expect(capture.agent.hits.map((hit) => hit.kind)).toEqual(['config-link-outside']);
      expect(capture.sources.map((source) => source.kind)).toEqual(['link']);
      expect(
        capture.privateBinding.dependencies.some((dependency) =>
          dependency.path.includes('/private-stroq/'),
        ),
      ).toBe(false);
    },
  );

  it('refuses exclusion of the workspace or its ancestor', () => {
    const project = fixture();
    expect(() => captureWorkspaceSurface({ project, ignoredRoots: [project] })).toThrow(
      'context-unavailable',
    );
    expect(() => captureWorkspaceSurface({ project, ignoredRoots: [dirname(project)] })).toThrow(
      'context-unavailable',
    );
  });

  it('does not follow Git includes or external custom hook directories', () => {
    const external = fixture({ credentials: 'private-config-must-not-be-read' });
    // Forward slashes, as Git writes them on Windows too: a backslash in a config value is an escape.
    const outside = external.replaceAll('\\', '/');
    const project = fixture({
      '.git/config': `[include]\npath=${outside}/credentials\n[core]\nhooksPath=${outside}\n`,
    });
    const capture = captureWorkspaceSurface({ project });
    expect(capture.complete).toBe(false);
    expect(capture.repo.preTrust.some((hit) => hit.kind === 'git-config-include')).toBe(true);
    expect(capture.sources.every((source) => !source.path.includes('credentials'))).toBe(true);
    expect(JSON.stringify(capture)).not.toContain('private-config-must-not-be-read');
  });

  it('inspects config.worktree only when enabled by common configuration', () => {
    const project = fixture({
      '.git/config': '[core]\nrepositoryFormatVersion=0\n',
      '.git/config.worktree': '[core]\nfsmonitor=do-not-run\n',
    });
    const dormant = captureWorkspaceSurface({ project });
    expect(dormant.repo.preTrust.some((hit) => hit.kind === 'git-config-exec')).toBe(false);
    expect(dormant.sources.some((source) => source.path.endsWith('config.worktree'))).toBe(false);
    writeFileSync(join(project, '.git/config'), '[extensions]\nworktreeConfig=true\n');
    const enabled = captureWorkspaceSurface({ project });
    expect(enabled.repo.preTrust.some((hit) => hit.kind === 'git-config-exec')).toBe(true);
    expect(enabled.sources.some((source) => source.path.endsWith('config.worktree'))).toBe(true);
  });
});
