import { posix } from 'node:path';
import type { TaggedHit } from './agent-change.js';
import { hit } from './agent-kinds.js';
import { foldPath } from './agent-surface.js';
import { foldName } from './git-dir-names.js';
import type { Changed } from './git-read.js';
import { parseGitConfig } from './repo-surface.js';

/**
 * The files of a change that git runs as hooks, on a commit, a checkout or a merge, without asking
 * anyone: anything under a `.husky` or `.githooks` folder, under a folder `core.hooksPath` names
 * (in git's own config, in a committed git config, or in an install script that sets it), under
 * the `hooks` of a bare repository committed as files, and a file named as a git hook in a folder
 * named for hooks. Each one the change adds or edits fails. Matched by each part folded as the most
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

/** A committed file git may read as a config: a `.gitconfig`, by its folded name. */
export const isGitConfigName = (path: string): boolean => {
  const base = foldName(path.slice(path.lastIndexOf('/') + 1));
  return base === '.gitconfig' || base === 'gitconfig' || base.endsWith('.gitconfig');
};

/** What sets `core.hooksPath` in an install script: `git config core.hooksPath <folder>`. */
const SETS_HOOKS_PATH = /core\.hookspath["']?(?:\s*=\s*|\s+)["']?([^\s"';&|)]+)/gi;

export interface HookContext {
  /** The folders git's own config names, or `unknown` when git could not say. */
  readonly hooksPaths: readonly string[] | 'unknown';
  /** The texts of the committed git configs (see `isGitConfigName`), by their path. */
  readonly configs: ReadonlyMap<string, string>;
  /** The folders of the bare repositories committed as files. */
  readonly bareRepos: readonly string[];
  /** The commands of the install scripts. */
  readonly scripts: readonly string[];
}

/** The folders a committed config or an install script points `core.hooksPath` at. */
function namedHookFolders(ctx: HookContext): string[] {
  const named: string[] = [];
  for (const [path, text] of ctx.configs)
    for (const { key, value } of parseGitConfig(text).entries)
      if (key === 'core.hookspath') {
        named.push(value);
        named.push(posix.join(posix.dirname(path), value));
      }
  for (const script of ctx.scripts)
    for (const match of script.matchAll(SETS_HOOKS_PATH)) named.push(match[1] as string);
  if (ctx.hooksPaths !== 'unknown') named.push(...ctx.hooksPaths);
  return named.flatMap((dir) => {
    const clean = posix.normalize(dir).replace(/\/+$/, '');
    return dir.startsWith('/') || dir.startsWith('~') || clean.startsWith('..') ? [] : [clean];
  });
}

/** Why git runs this file as a hook, or undefined when it does not. */
function hookReason(
  path: string,
  folders: readonly string[],
  ctx: HookContext,
): string | undefined {
  const folded = foldPath(path);
  const parts = folded.split('/');
  const folder = parts.slice(0, -1).find((part) => HOOK_FOLDERS.has(part));
  if (folder !== undefined) return folder;
  for (const dir of folders) {
    const f = foldPath(dir);
    if (f === '.' || f === '' || folded.startsWith(`${f}/`)) return `core.hooksPath ${dir}`;
  }
  for (const bare of ctx.bareRepos)
    if (folded.startsWith(`${foldPath(bare)}/hooks/`))
      return `the hooks of the bare repository ${bare}`;
  const parent = parts[parts.length - 2] ?? '';
  if (HOOK_NAMES.has(parts[parts.length - 1] as string) && parent.includes('hook'))
    return 'a git hook name in a hooks folder';
  if (ctx.hooksPaths === 'unknown' && parts.slice(0, -1).some((part) => /hooks?$/.test(part)))
    return 'a hooks folder, while git could not say what core.hooksPath is';
  return undefined;
}

/** A failing entry for each file the change adds or edits that git runs as a hook. */
export function gitHookFileChanges(
  changed: ReadonlyMap<string, Changed>,
  ctx: HookContext,
): TaggedHit[] {
  const folders = namedHookFolders(ctx);
  return [...changed].flatMap(([path, c]): TaggedHit[] => {
    if (c.status === 'D') return [];
    const why = hookReason(path, folders, ctx);
    return why === undefined
      ? []
      : [
          {
            ...hit('git-hook-file', path, 1, why, path),
            status: c.status === 'A' ? 'new' : 'changed',
          },
        ];
  });
}
