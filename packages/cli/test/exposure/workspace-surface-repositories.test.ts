import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { repoSurface } from '../../src/exposure/repo-surface.js';
import {
  captureWorkspaceSurface,
  recheckWorkspaceSurface,
} from '../../src/exposure/workspace-surface.js';

// Git reads configuration and hooks from places the workspace capture does not: a repository whose
// root is above the workspace, and a repository nested inside it. Each must be a named gap, never a
// clean capture: a gap is how the capture says "Stroq did not look here".

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(files: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'stroq-workspace-repos-'));
  roots.push(root);
  for (const [name, bytes] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), bytes);
  }
  return root;
}
const HEAD = 'ref: refs/heads/main\n';
const NEVER = '[core]\n\tfsmonitor = never-read-this\n';
const codes = (capture: ReturnType<typeof captureWorkspaceSurface>) =>
  capture.observations.map((row) => `${row.code} ${row.role} ${row.path}`);

describe('a workspace inside a git repository', () => {
  it('is not complete, and names the repository above it as a gap without reading it', () => {
    const repo = fixture({
      '.git/HEAD': HEAD,
      '.git/config': NEVER,
      'packages/app/.claude/settings.json': '{}',
    });
    const capture = captureWorkspaceSurface({ project: join(repo, 'packages/app') });
    expect(capture.complete).toBe(false);
    expect(codes(capture)).toEqual(['enclosing-repository workspace .']);
    expect(capture.repo.isRepo).toBe(false);
    expect(capture.sources.some((source) => source.role === 'git-metadata')).toBe(false);
    expect(JSON.stringify(capture)).not.toContain('never-read-this');
  });

  it('says the same for a .git file above it and for a bare repository above it', () => {
    const linked = fixture({ '.git': 'gitdir: /elsewhere/.git/worktrees/one\n', 'app/a.txt': '' });
    expect(codes(captureWorkspaceSurface({ project: join(linked, 'app') }))).toEqual([
      'enclosing-repository workspace .',
    ]);
    const bare = fixture({ HEAD, config: NEVER, 'app/a.txt': '' });
    mkdirSync(join(bare, 'objects'));
    mkdirSync(join(bare, 'refs'));
    expect(codes(captureWorkspaceSurface({ project: join(bare, 'app') }))).toEqual([
      'enclosing-repository workspace .',
    ]);
  });

  it.skipIf(process.platform === 'win32')('counts a .git link above it, which git follows', () => {
    const elsewhere = fixture({ HEAD: HEAD, config: NEVER });
    const repo = fixture({ 'app/a.txt': '' });
    symlinkSync(elsewhere, join(repo, '.git'));
    const capture = captureWorkspaceSurface({ project: join(repo, 'app') });
    expect(codes(capture)).toEqual(['enclosing-repository workspace .']);
    expect(JSON.stringify(capture)).not.toContain('never-read-this');
  });

  it('is not a gap when the workspace is a repository of its own, where git stops looking', () => {
    const outer = fixture({
      '.git/HEAD': HEAD,
      '.git/config': NEVER,
      'inner/.git/HEAD': HEAD,
      'inner/.git/config': '[core]\n\trepositoryformatversion = 0\n',
    });
    const capture = captureWorkspaceSurface({ project: join(outer, 'inner') });
    expect(capture.observations).toEqual([]);
    expect(capture.complete).toBe(true);
    expect(capture.repo.isRepo).toBe(true);
  });

  it('is complete in a plain folder with no repository above it', () => {
    const plain = fixture({ 'app/.claude/settings.json': '{}' });
    const capture = captureWorkspaceSurface({ project: join(plain, 'app') });
    expect(capture.observations).toEqual([]);
    expect(capture.complete).toBe(true);
  });

  it('binds the absence of a repository above, so one created later makes the capture stale', () => {
    const outer = fixture({ 'app/.claude/settings.json': '{}' });
    const capture = captureWorkspaceSurface({ project: join(outer, 'app') });
    expect(capture.complete).toBe(true);
    expect(recheckWorkspaceSurface(capture.privateBinding)).toBe(true);
    mkdirSync(join(outer, '.git'));
    expect(recheckWorkspaceSurface(capture.privateBinding)).toBe(false);
  });
});

describe('a git repository nested in a repository workspace', () => {
  it('is a named gap at its own path, and its configuration is not reported as read', () => {
    const project = fixture({
      '.git/HEAD': HEAD,
      '.git/config': '[core]\n\trepositoryformatversion = 0\n',
      'vendor/tool/.git/HEAD': HEAD,
      'vendor/tool/.git/config': NEVER,
    });
    const capture = captureWorkspaceSurface({ project });
    expect(capture.complete).toBe(false);
    expect(codes(capture)).toEqual(['nested-repository workspace vendor/tool/.git']);
    expect(capture.repo.preTrust).toEqual([]);
    expect(JSON.stringify(capture)).not.toContain('never-read-this');
  });

  it('records a .git file (a submodule or linked worktree) and a .git link the same way', () => {
    const project = fixture({
      '.git/HEAD': HEAD,
      '.git/config': '[core]\n\trepositoryformatversion = 0\n',
      '.git/modules/sub/HEAD': HEAD,
      '.git/modules/sub/config': NEVER,
      'lib/sub/.git': 'gitdir: ../../.git/modules/sub\n',
    });
    const paths = ['nested-repository workspace lib/sub/.git'];
    if (process.platform !== 'win32') {
      mkdirSync(join(project, 'lib/linked'), { recursive: true });
      symlinkSync(join(project, '.git/modules/sub'), join(project, 'lib/linked/.git'));
      paths.unshift('nested-repository workspace lib/linked/.git');
    }
    const capture = captureWorkspaceSurface({ project });
    expect(capture.complete).toBe(false);
    expect(codes(capture).sort()).toEqual(paths.sort());
    expect(JSON.stringify(capture)).not.toContain('never-read-this');
  });

  it('leaves the plain command-line report as it was', () => {
    const project = fixture({
      '.git/HEAD': HEAD,
      '.git/config': '[core]\n\trepositoryformatversion = 0\n',
      'vendor/tool/.git/HEAD': HEAD,
      'vendor/tool/.git/config': NEVER,
    });
    expect(repoSurface(project)).toEqual({ isRepo: true, preTrust: [], onOpen: [], capped: false });
  });
});
