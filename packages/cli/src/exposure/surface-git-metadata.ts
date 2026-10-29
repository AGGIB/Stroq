import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parseGitConfig } from './repo-surface.js';
import { SurfaceCapture, surfaceWithin, surfacePin } from './surface-capture.js';

/** This resolver reads fixed local metadata only. It never calls Git or follows includes. */
export function resolveGitMetadata(capture: SurfaceCapture): void {
  const root = capture.root;
  const pointer = join(root, '.git');
  if (!capture.exists(pointer)) {
    if (enclosingRepository(capture)) capture.gap('enclosing-repository', root);
    capture.gitMetadata = { isRepo: false, configs: [], hooks: null, attributes: [] };
    return;
  }
  const refused = () => {
    capture.gap('git-metadata-unverified', pointer);
    capture.gitMetadata = { isRepo: true, configs: [], hooks: null, attributes: [] };
  };
  try {
    const source = capture.lstat(pointer);
    if (source.isSymbolicLink()) return refused();
    if (source.isDirectory()) {
      // Git honours `commondir` in any git directory and then reads its configuration and hooks from
      // the folder it names. This resolver reads only the directory's own files, so it cannot say what
      // would run.
      if (capture.exists(join(pointer, 'commondir'))) return refused();
      capture.allowMetadata(
        pointer,
        'repository',
        ['config', 'config.worktree', 'info/attributes'],
        true,
      );
      capture.gitMetadata = {
        isRepo: true,
        configs: activeConfigs(capture, join(pointer, 'config'), join(pointer, 'config.worktree')),
        hooks: join(pointer, 'hooks'),
        attributes: [join(root, '.gitattributes'), join(pointer, 'info', 'attributes')],
      };
      return;
    }
    const text = capture.read(pointer, 4096);
    if (text.kind !== 'text') return refused();
    const match = /^gitdir: ([^\r\n\u0000]+)\r?\n?$/.exec(text.text);
    if (match === null) return refused();
    const named = resolve(root, match[1]!);
    const gitdir = realpathSync(named);
    const proof = new Map<string, ReturnType<typeof surfacePin>>();
    const safeDirectory = (path: string) => {
      const stat = lstatSync(path);
      proof.set(path, surfacePin(stat));
      return (
        stat.isDirectory() &&
        !stat.isSymbolicLink() &&
        (process.getuid === undefined || stat.uid === process.getuid()) &&
        (process.getuid === undefined || (stat.mode & 0o022) === 0)
      );
    };
    if (gitdir !== named || !safeDirectory(gitdir)) return refused();
    // A worktree's administrative directory is exactly common/worktrees/<one entry>.
    const worktrees = dirname(gitdir);
    const common = dirname(worktrees);
    if (
      dirname(worktrees) === worktrees ||
      !safeDirectory(common) ||
      !safeDirectory(worktrees) ||
      join(common, 'worktrees') !== worktrees ||
      realpathSync(common) !== common ||
      realpathSync(worktrees) !== worktrees
    )
      return refused();
    capture.allowMetadata(gitdir, 'worktree', ['gitdir', 'commondir', 'config.worktree']);
    const backlink = capture.read(join(gitdir, 'gitdir'), 4096);
    const commonText = capture.read(join(gitdir, 'commondir'), 4096);
    if (backlink.kind !== 'text' || commonText.kind !== 'text') return refused();
    const onePath = (value: string): string | null =>
      /^[^\r\n\u0000]+\r?\n?$/.test(value) ? value.replace(/\r?\n$/, '') : null;
    const back = onePath(backlink.text);
    const declaredCommon = onePath(commonText.text);
    if (
      back === null ||
      declaredCommon === null ||
      !isAbsolute(back) ||
      realpathSync(back) !== pointer ||
      resolve(gitdir, declaredCommon) !== common ||
      !surfaceWithin(common, gitdir)
    )
      return refused();
    capture.allowMetadata(
      common,
      'common',
      ['config', 'config.worktree', 'info/attributes', 'worktrees'],
      true,
    );
    // Pin all proof directories, in addition to the pointer/backlink/commondir bytes.
    for (const path of [common, worktrees, gitdir])
      if (JSON.stringify(surfacePin(capture.lstat(path))) !== JSON.stringify(proof.get(path)))
        return refused();
    capture.gitMetadata = {
      isRepo: true,
      configs: activeConfigs(capture, join(common, 'config'), join(gitdir, 'config.worktree')),
      hooks: join(common, 'hooks'),
      attributes: [join(root, '.gitattributes'), join(common, 'info', 'attributes')],
    };
  } catch {
    refused();
  }
}

/**
 * Git run in a folder with no `.git` of its own looks in every folder above it for a `.git` (a folder,
 * a file or a link) or for a folder that is a bare repository itself, and runs that repository's
 * configuration and hooks. They are outside the workspace and are not read here, so a workspace under
 * one is reported as a gap, not as clean. The test errs toward a repository, and walks to the top of
 * the disk rather than guess where a `GIT_CEILING_DIRECTORIES` would stop git.
 */
function enclosingRepository(capture: SurfaceCapture): boolean {
  for (let dir = dirname(capture.root); ; dir = dirname(dir)) {
    const at = (name: string) => capture.presentOutside(join(dir, name));
    if (at('.git') || (at('HEAD') && (at('objects') || at('refs') || at('commondir')))) return true;
    if (dirname(dir) === dir) return false;
  }
}

function activeConfigs(capture: SurfaceCapture, config: string, worktreeConfig: string): string[] {
  try {
    const read = capture.read(config, 256 * 1024);
    if (read.kind !== 'text') return [config];
    const parsed = parseGitConfig(read.text);
    if (parsed.unplaced.length > 0) capture.parseGap(config);
    const enabled = parsed.entries
      .filter((entry) => entry.key === 'extensions.worktreeconfig')
      .at(-1)?.value;
    return enabled !== undefined && /^(true|yes|on|1)$/i.test(enabled)
      ? [config, worktreeConfig]
      : [config];
  } catch {
    return [config];
  }
}
