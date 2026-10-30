import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, relative, sep } from 'node:path';

export const hash = (value) => createHash('sha256').update(value).digest('hex');
const owned = (s) => typeof process.getuid !== 'function' || s.uid === process.getuid();
const fail = () => {
  throw new Error('credential-filter-unsupported-source');
};
const missing = (e) => e?.code === 'ENOENT';
const identity = (s) => ({
  dev: String(s.dev),
  ino: String(s.ino),
  uid: String(s.uid),
  mode: s.mode & 0o777,
});
export async function directory(path) {
  const canonical = await realpath(path),
    stat = await lstat(canonical);
  if (!stat.isDirectory() || !owned(stat)) throw new Error('credential-filter-context-unavailable');
  return { path: canonical, ...identity(stat) };
}
async function stat(path) {
  try {
    return await lstat(path);
  } catch (e) {
    if (missing(e)) return null;
    throw e;
  }
}
async function metadata(path, facts, kind = 'directory', maxBytes = 65536) {
  const before = await stat(path);
  if (
    !before ||
    before.isSymbolicLink() ||
    !owned(before) ||
    (kind === 'directory' ? !before.isDirectory() : !before.isFile() || before.nlink !== 1) ||
    (await realpath(path)) !== path
  )
    return fail();
  if (kind === 'directory') {
    facts.push({ path, kind, ...identity(before) });
    return null;
  }
  if (before.size > maxBytes) return fail();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat();
    if (
      opened.ino !== before.ino ||
      opened.dev !== before.dev ||
      !opened.isFile() ||
      opened.nlink !== 1 ||
      !owned(opened) ||
      opened.size > maxBytes ||
      opened.size !== before.size ||
      opened.mode !== before.mode ||
      opened.mtimeMs !== before.mtimeMs ||
      opened.ctimeMs !== before.ctimeMs
    )
      return fail();
    const bytes = Buffer.alloc(opened.size);
    let filled = 0;
    while (filled < bytes.length) {
      const r = await handle.read(bytes, filled, bytes.length - filled, filled);
      if (!r.bytesRead) break;
      filled += r.bytesRead;
    }
    const extra = await handle.read(Buffer.alloc(1), 0, 1, bytes.length),
      after = await handle.stat(),
      named = await stat(path);
    if (
      filled !== bytes.length ||
      extra.bytesRead ||
      !named ||
      named.isSymbolicLink() ||
      !named.isFile() ||
      named.nlink !== 1 ||
      !owned(named) ||
      named.mode !== opened.mode ||
      named.size !== opened.size ||
      named.ino !== opened.ino ||
      named.dev !== opened.dev ||
      after.size !== opened.size ||
      after.mode !== opened.mode ||
      after.nlink !== 1 ||
      !owned(after) ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs ||
      named.mtimeMs !== opened.mtimeMs ||
      named.ctimeMs !== opened.ctimeMs
    )
      return fail();
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (text.includes('\0')) return fail();
    facts.push({
      path,
      kind,
      ...identity(opened),
      size: opened.size,
      mtimeMs: opened.mtimeMs,
      ctimeMs: opened.ctimeMs,
      sha256: hash(bytes),
    });
    return text;
  } finally {
    await handle.close();
  }
}
function safeGitConfig(text) {
  // Includes/core.worktree can change discovery. Refuse instead of interpreting or
  // loading repository-selected files. Nothing here invokes Git or a repository hook.
  return !/^\s*\[\s*include(?:if)?\b|^\s*worktree\s*=|^\s*bare\s*=\s*(?:true|yes|on|1)\b/im.test(
    text,
  );
}
async function normalGit(root, facts) {
  await metadata(root, facts);
  const git = join(root, '.git');
  await metadata(git, facts);
  await metadata(join(git, 'objects'), facts);
  await metadata(join(git, 'refs'), facts);
  const head = await metadata(join(git, 'HEAD'), facts, 'file', 1024);
  if (!/^(?:ref: refs\/[^\s\u0000-\u001f]+|[a-f0-9]{40}|[a-f0-9]{64})\r?\n?$/.test(head))
    return fail();
  if (!safeGitConfig(await metadata(join(git, 'config'), facts, 'file'))) return fail();
  const configWorktree = join(git, 'config.worktree');
  if (await stat(configWorktree)) {
    if (!safeGitConfig(await metadata(configWorktree, facts, 'file'))) return fail();
  }
}
async function nativeClaude(project, user, facts) {
  let root = project.path,
    marker = null;
  for (let n = 0; n < 128; n++) {
    marker = await stat(join(root, '.git'));
    if (marker) break;
    const parent = dirname(root);
    if (parent === root) return { root: project.path, context: 'workspace', location: 'workspace' };
    root = parent;
  }
  if (!marker) return fail();
  const rootStat = await stat(root),
    claudeStat = await stat(join(root, '.claude'));
  // These are Claude's documented cwd-local exceptions. Do not read an unowned
  // marker, or guess that cwd is effective for an otherwise unrecognized layout.
  if (
    root === user.path ||
    !owned(rootStat) ||
    !owned(marker) ||
    (claudeStat && !owned(claudeStat))
  )
    return { root: project.path, context: 'workspace', location: 'workspace' };
  if (marker.isSymbolicLink()) return fail();
  if (marker.isDirectory()) {
    await normalGit(root, facts);
    return { root, context: 'repository', location: 'workspace' };
  }
  const markerPath = join(root, '.git');
  const raw = await metadata(markerPath, facts, 'file', 4096);
  const match = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(raw);
  if (!match) return fail();
  const gitDir = resolve(root, match[1]);
  await metadata(gitDir, facts);
  const commonRaw = await metadata(join(gitDir, 'commondir'), facts, 'file', 4096);
  if (!/^[^\r\n]+\r?\n?$/.test(commonRaw)) return fail();
  const common = resolve(gitDir, commonRaw.trimEnd()),
    main = dirname(common);
  if (
    basename(common) !== '.git' ||
    dirname(dirname(gitDir)) !== common ||
    basename(dirname(gitDir)) !== 'worktrees'
  )
    return fail();
  const reciprocal = await metadata(join(gitDir, 'gitdir'), facts, 'file', 4096);
  if (reciprocal.trimEnd() !== markerPath) return fail();
  await metadata(join(gitDir, 'HEAD'), facts, 'file', 1024);
  const mainStat = await stat(main),
    mainClaude = await stat(join(main, '.claude'));
  if (!mainStat || !owned(mainStat) || (mainClaude && !owned(mainClaude)) || main === user.path)
    return { root: project.path, context: 'workspace', location: 'workspace' };
  await normalGit(main, facts);
  return { root: main, context: 'repository', location: 'main-checkout' };
}
/** @param {import('./credential-filter-types.ts').CredentialResolverOptions} options
 * @returns {Promise<import('./credential-filter-types.ts').CredentialResolution>} */
export async function resolveCredentialTargets({
  project,
  userHome,
  home,
  platform,
  claudeConfigDir = '',
}) {
  const workspace = await directory(project),
    user = await directory(userHome),
    facts = [];
  const roots = { project: workspace, user, home: resolve(home) };
  let claude = { root: workspace.path, context: 'workspace', location: 'workspace' },
    claudeReason = null;
  try {
    claude = await nativeClaude(workspace, user, facts);
  } catch {
    claudeReason = 'credential-filter-unsupported-source';
  }
  const supported = platform === 'darwin' || platform === 'linux';
  const fixed = [
    {
      id: 'claude-project',
      recipe: 'claude-read-deny',
      agent: 'claude-code',
      scope: 'project',
      target: '.claude/settings.local.json',
      required: 13,
      location: claude.location,
      context: claude.context,
      root: claude.root,
      file: join(claude.root, '.claude', 'settings.local.json'),
      reason: claudeReason,
    },
    {
      id: 'claude-user',
      recipe: 'claude-read-deny',
      agent: 'claude-code',
      scope: 'user',
      target: '~/.claude/settings.json',
      required: 13,
      location: 'user',
      context: 'all-workspaces',
      root: user.path,
      file: join(user.path, '.claude', 'settings.json'),
      reason:
        claudeConfigDir && resolve(claudeConfigDir) !== join(user.path, '.claude')
          ? 'credential-filter-unsupported-source'
          : null,
    },
    {
      id: 'cursor-project',
      recipe: 'cursor-ignore',
      agent: 'cursor',
      scope: 'project',
      target: '.cursorignore',
      required: 2,
      location: 'workspace',
      context: 'workspace',
      root: workspace.path,
      file: join(workspace.path, '.cursorignore'),
      reason: null,
    },
  ];
  return {
    roots,
    workspaceId: `workspace-${hash(workspace.path).slice(0, 24)}`,
    facts,
    targets: fixed.map((t) => ({
      ...t,
      reason: supported ? t.reason : 'credential-filter-platform-unsupported',
    })),
  };
}
/** Re-resolve fixed metadata, never a path supplied by a browser or retained record. */
/** @param {import('./credential-filter-types.ts').CredentialResolverOptions} options
 * @param {import('./credential-filter-types.ts').CredentialResolution} expected */
export async function assertTargetContext(options, expected) {
  const current = await resolveCredentialTargets(options);
  if (JSON.stringify(current) !== JSON.stringify(expected))
    throw new Error('credential-filter-preview-stale');
}
