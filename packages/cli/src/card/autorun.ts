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
import { folderSurface, repoSurface } from '../exposure/repo-surface.js';

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
  for (const hit of surface.preTrust) add({ kind: hit.kind, file: hit.file, name: hit.what });
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
