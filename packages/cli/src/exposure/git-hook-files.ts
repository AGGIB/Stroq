import { posix } from 'node:path';
import type { TaggedHit } from './agent-change.js';
import { hit } from './agent-kinds.js';
import { foldPath } from './agent-surface.js';
import { foldName } from './git-dir-names.js';
import type { Changed } from './git-read.js';
import { resolve, type TreeView } from './git-tree.js';
import { parseGitConfig } from './repo-surface.js';

/**
 * The files of a change that git runs as hooks, on a commit, a checkout or a merge, without asking
 * anyone: anything under a `.husky` or `.githooks` folder, under a folder `core.hooksPath` names
 * (in git's own config, in a committed git config, in the config of a bare repository committed as
 * files, or in an install script that sets it), under the `hooks` of such a bare repository, and a
 * file named as a git hook in a folder named for hooks. Each folder is also followed through the
 * links of the tree. A `core.hooksPath` that is not a plain relative path leaves the folder
 * unknown: then a changed file in a folder named for hooks, or any changed executable file, counts.
 * Each one the change adds or edits fails; paths are matched with each part folded as the most
 * forgiving disk opens it.
 */

/** The names git runs hooks by. */
const HOOK_NAMES: ReadonlySet<string> = new Set([
  'applypatch-msg',
  'pre-applypatch',
  'post-applypatch',
  'pre-commit',
  'pre-merge-commit',
  'prepare-commit-msg',
  'commit-msg',
  'post-commit',
  'pre-rebase',
  'post-checkout',
  'post-merge',
  'pre-push',
  'pre-receive',
  'update',
  'proc-receive',
  'post-receive',
  'post-update',
  'reference-transaction',
  'push-to-checkout',
  'pre-auto-gc',
  'post-rewrite',
  'sendemail-validate',
  'fsmonitor-watchman',
  'p4-changelist',
  'p4-prepare-changelist',
  'p4-post-changelist',
  'p4-pre-submit',
  'post-index-change',
]);

/** Folders a hook manager keeps git hooks in, wherever they are. */
const HOOK_FOLDERS: ReadonlySet<string> = new Set(['.husky', '.githooks']);
/** Folder names taken for hooks while the folder `core.hooksPath` names is not known. */
const HOOKISH: ReadonlySet<string> = new Set([
  'hooks',
  'hook',
  '.hooks',
  'githooks',
  '.githooks',
  'git-hooks',
  '.git-hooks',
  '.husky',
]);
const EXECUTABLE = '100755';
/** The configs of git hook managers, by their folded name: what they name runs on a commit. */
const HOOK_MANAGER =
  /^(?:\.pre-commit-config\.ya?ml|\.?lefthook(?:-local)?\.(?:ya?ml|toml|json)|\.lintstagedrc.*|lint-staged\.config\..*|\.huskyrc.*|\.?simple-git-hooks\..*|\.overcommit\.ya?ml)$/;
/** Whether a path is a git hook manager's config. */
export const isHookManagerConfig = (path: string): boolean =>
  HOOK_MANAGER.test(foldName(path.slice(path.lastIndexOf('/') + 1)));

/** A committed file git may read as a config: a `.gitconfig`, by its folded name. */
export const isGitConfigName = (path: string): boolean => {
  const base = foldName(path.slice(path.lastIndexOf('/') + 1));
  return base === '.gitconfig' || base === 'gitconfig' || base.endsWith('.gitconfig');
};

/** What sets `core.hooksPath` in an install script: `git config core.hooksPath <folder>`. */
const SETS_HOOKS_PATH = /core\.hookspath["']?(?:\s*=\s*|\s+)([^\s;&|)]+)/gi;
/** A plain relative path: no quote, blank, `$`, backquote or `~`, and not absolute. */
const PLAIN_PATH = /^[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*\/?$/;

export interface HookContext {
  /** The folders git's own config names, or `unknown` when git could not say. */
  readonly hooksPaths: readonly string[] | 'unknown';
  /** The folder the repository is at, as git names it and as the disk does, for absolute values. */
  readonly tops: readonly string[];
  /** The texts of the committed git configs (see `isGitConfigName`), by their path. */
  readonly configs: ReadonlyMap<string, string>;
  /** The texts of the configs of the bare repositories committed as files, by their folder. */
  readonly bareConfigs: ReadonlyMap<string, string>;
  /** The folders of the bare repositories committed as files. */
  readonly bareRepos: readonly string[];
  /** The commands of the install scripts. */
  readonly scripts: readonly string[];
  /** The head tree, every link read that could be. */
  readonly view: TreeView;
}

interface Folders {
  /** The folders hooks are in, as repository paths, and why each is one. */
  readonly named: readonly (readonly [folder: string, why: string])[];
  /** True when some `core.hooksPath` could not be placed. */
  readonly unknown: boolean;
}

/** The folders hooks are in, from every place that can name one. */
function hookFolders(ctx: HookContext): Folders {
  const named: [string, string][] = [];
  let unknown = ctx.hooksPaths === 'unknown';
  /** A value of `core.hooksPath`, from the folder `from`: placed, or the folder is unknown. */
  const place = (value: string, from: string): void => {
    let text = value.trim();
    const quoted = /^(["'])(.*)\1$/.exec(text);
    if (quoted !== null) text = quoted[2] as string;
    for (const top of ctx.tops)
      if (text === top || text.startsWith(`${top}/`)) text = text.slice(top.length + 1) || '.';
    if (!PLAIN_PATH.test(text)) {
      unknown = true;
      return;
    }
    const joined = posix.normalize(posix.join(from, text)).replace(/\/+$/, '');
    if (joined === '..' || joined.startsWith('../')) {
      unknown = true;
      return;
    }
    named.push([joined === '' ? '.' : joined, `core.hooksPath ${value.trim()}`]);
  };
  for (const [path, text] of ctx.configs)
    for (const { key, value } of parseGitConfig(text).entries)
      if (key === 'core.hookspath') {
        place(value, '');
        const folder = posix.dirname(path);
        if (folder !== '.') place(value, folder);
      }
  for (const [bare, text] of ctx.bareConfigs)
    for (const { key, value } of parseGitConfig(text).entries)
      if (key === 'core.hookspath') place(value, bare);
  for (const script of ctx.scripts)
    for (const match of script.matchAll(SETS_HOOKS_PATH)) place(match[1] as string, '');
  if (ctx.hooksPaths !== 'unknown') for (const dir of ctx.hooksPaths) place(dir, '');
  for (const bare of ctx.bareRepos)
    named.push([`${bare}/hooks`, `the hooks of the bare repository ${bare}`]);
  // Each .husky or .githooks folder of the tree, by its own path, to follow it through links.
  const seen = new Set<string>();
  for (const path of ctx.view.sorted) {
    const parts = path.split('/');
    parts.forEach((part, i) => {
      if (!HOOK_FOLDERS.has(foldName(part))) return;
      const folder = parts.slice(0, i + 1).join('/');
      if (!seen.has(folder)) named.push([folder, foldName(part)]);
      seen.add(folder);
    });
  }
  return { named, unknown };
}

/** A failing entry for each file the change adds or edits that git runs as a hook. */
export function gitHookFileChanges(
  changed: ReadonlyMap<string, Changed>,
  ctx: HookContext,
): TaggedHit[] {
  const { named, unknown } = hookFolders(ctx);
  const touched = [...changed]
    .filter(([, c]) => c.status !== 'D')
    .map(([path, c]) => ({ path, c, folded: foldPath(path) }));
  const out = new Map<string, TaggedHit>();
  const fails = (path: string, c: Changed | undefined, why: string): void => {
    if (!out.has(path))
      out.set(path, {
        ...hit('git-hook-file', path, 1, why, path),
        status: c?.status === 'A' ? 'new' : 'changed',
      });
  };
  const under = (folder: string, why: string): void => {
    const f = foldPath(folder);
    for (const t of touched)
      if (f === '.' || f === '' || t.folded.startsWith(`${f}/`)) fails(t.path, t.c, why);
  };
  // Each folder by its name, by the name a disk folds it to, and where the links on its way lead.
  for (const [folder, why] of named) {
    under(folder, why);
    const at = resolve(folder === '.' ? '' : folder, ctx.view);
    if (at.kind === 'none') continue;
    for (const link of at.links) if (changed.has(link)) fails(link, changed.get(link), why);
    if (at.kind === 'folder') under(at.path, why);
    else if (at.kind === 'unread')
      out.set(`\u0000${folder}`, {
        ...hit(
          'unreadable-config',
          folder,
          1,
          'link',
          `a link on the way to a folder of git hooks was not read: ${at.link}`,
        ),
        status: 'new',
      });
  }
  for (const t of touched) {
    if (isHookManagerConfig(t.path)) fails(t.path, t.c, 'a git hook manager config');
    const parts = t.folded.split('/');
    const parent = parts[parts.length - 2] ?? '';
    if (HOOK_NAMES.has(parts[parts.length - 1] as string) && parent.includes('hook'))
      fails(t.path, t.c, 'a git hook name in a hooks folder');
    if (!unknown) continue;
    const why = 'core.hooksPath names a folder this cannot place';
    if (parts.slice(0, -1).some((part) => HOOKISH.has(part))) fails(t.path, t.c, why);
    else if (ctx.view.tree.get(t.path)?.mode === EXECUTABLE) fails(t.path, t.c, why);
  }
  return [...out.values()];
}

/**
 * The files of the head tree git runs as hooks, or a hook manager reads: everything under a folder
 * of hooks, found also through the links of the tree, and every hook manager's config. Their text
 * is read as what an entry already there runs.
 */
export function hookFilesAt(ctx: HookContext): string[] {
  const { named } = hookFolders(ctx);
  const prefixes = new Set<string>();
  for (const [folder] of named) {
    prefixes.add(foldPath(folder));
    const at = resolve(folder === '.' ? '' : folder, ctx.view);
    if (at.kind === 'folder') prefixes.add(foldPath(at.path));
  }
  return ctx.view.sorted.filter((path) => {
    const entry = ctx.view.tree.get(path);
    if (entry === undefined || (entry.mode !== '100644' && entry.mode !== EXECUTABLE)) return false;
    if (isHookManagerConfig(path)) return true;
    const folded = foldPath(path);
    return [...prefixes].some((p) => p === '.' || p === '' || folded.startsWith(`${p}/`));
  });
}
