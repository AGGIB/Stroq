// Folders that run code as soon as an agent opens them, found with the reading `stroq inspect` does.
//
// Two groups count, and only the ones `inspect` itself calls failing: what the repository's own
// metadata makes git run before anyone approves anything (the pre-trust findings), and the settings an
// agent or editor takes up by itself once the folder is trusted and that run a command or switch a
// guard off (hooks, auto-approved MCP servers, autorun tasks). The ordinary things many honest
// repositories have (a husky hook, a `prepare` script) are not counted: `inspect` lists them as "not
// findings" and a count of them would be a count of every repository there is.
import { isFailing, tagChanges } from '../exposure/agent-change.js';
import { agentSurface } from '../exposure/agent-tree.js';
import { folderSurface, repoSurface, type RepoExecHit } from '../exposure/repo-surface.js';

/** One thing in a folder that runs by itself. */
export interface AutorunItem {
  readonly kind: string;
  readonly file: string;
  readonly name: string;
}

export interface AutorunRepo {
  readonly dir: string;
  /** The first few things, and how many more there are. */
  readonly items: readonly AutorunItem[];
  readonly more: number;
}

const MAX_ITEMS = 5;

/**
 * Hooks git runs only when someone commits, pushes, rebases or applies a patch. `pre-auto-gc` is not
 * one of them: `git gc --auto` runs after fetches, merges and other routine commands. `inspect` still
 * reports them (in a downloaded archive they run on the next such command), but the card's line is
 * "runs code as soon as an agent opens it", which they do not.
 */
const LATER_HOOKS: ReadonlySet<string> = new Set([
  'applypatch-msg',
  'pre-applypatch',
  'post-applypatch',
  'pre-commit',
  'pre-merge-commit',
  'prepare-commit-msg',
  'commit-msg',
  'post-commit',
  'pre-rebase',
  'post-rewrite',
  'pre-push',
  'sendemail-validate',
]);

/** Whether a finding runs when an agent opens the folder, rather than when it later commits or pushes. */
export function runsOnOpen(hit: Pick<RepoExecHit, 'kind' | 'what'>): boolean {
  if (hit.kind === 'git-hook-routine') {
    const name = hit.what.split(',')[0]?.trim() ?? '';
    return !LATER_HOOKS.has(name);
  }
  // The key only says where hooks are; the hooks it leads to are judged one by one.
  return !(hit.kind === 'git-config-exec' && hit.what.toLowerCase() === 'core.hookspath');
}

/** What the folder runs by itself, or null when it runs nothing. Reads only; runs nothing. */
export function autorunOf(dir: string): AutorunRepo | null {
  const inRepo = repoSurface(dir);
  const surface = inRepo.isRepo ? inRepo : folderSurface(dir);
  const agent = tagChanges(agentSurface(dir).hits, null).filter((h) => isFailing(h, 'any'));
  const seen = new Set<string>();
  const items: AutorunItem[] = [];
  const add = (item: AutorunItem): void => {
    const key = `${item.file}\u0000${item.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push(item);
  };
  for (const hit of surface.preTrust.filter(runsOnOpen))
    add({ kind: hit.kind, file: hit.file, name: hit.what });
  for (const hit of agent) add({ kind: hit.kind, file: hit.file, name: hit.name });
  if (items.length === 0) return null;
  return { dir, items: items.slice(0, MAX_ITEMS), more: Math.max(0, items.length - MAX_ITEMS) };
}

export interface AutorunResult {
  readonly repos: readonly AutorunRepo[];
  /** Folders looked at. */
  readonly checked: number;
  /** Folders there were; more than `checked` when the time ran out. */
  readonly total: number;
}

/**
 * The folders in `dirs` that run something by themselves. Stops starting folders at `stopAt` (a
 * time in milliseconds since the epoch), and a folder it cannot read is a folder with nothing found.
 */
export function findAutorun(
  dirs: readonly string[],
  stopAt: number,
  now: () => number = Date.now,
): AutorunResult {
  const repos: AutorunRepo[] = [];
  let checked = 0;
  for (const dir of dirs) {
    if (now() >= stopAt) break;
    checked += 1;
    try {
      const found = autorunOf(dir);
      if (found !== null) repos.push(found);
    } catch {
      // A folder that cannot be read has nothing to report; the count of folders checked still includes it.
    }
  }
  return { repos, checked, total: dirs.length };
}
