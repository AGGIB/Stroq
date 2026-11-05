// Folders that run code as soon as an agent opens them, found with the reading `stroq inspect` does.
//
// Two groups count, and only the ones `inspect` itself calls failing: what the repository's own
// metadata makes git run before anyone approves anything (the pre-trust findings), and the settings an
// agent or editor takes up by itself once the folder is trusted and that run a command or switch a
// guard off (hooks, auto-approved MCP servers, autorun tasks). The ordinary things many honest
// repositories have (a husky hook, a `prepare` script) are not counted: `inspect` lists them as "not
// findings" and a count of them would be a count of every repository there is.
import { realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, sep } from 'node:path';
import { isFailing, tagChanges } from '../exposure/agent-change.js';
import type { AgentHit } from '../exposure/agent-kinds.js';
import { agentSurface } from '../exposure/agent-tree.js';
import { stroqHome } from '../paths.js';
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
/** What `inspect` says of a bare repository it found by its shape alone (repo-surface.ts). */
const BARE_BY_SHAPE = 'HEAD, objects, refs';

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

/**
 * The hook line `stroq init` writes (`hook-command.ts`): the node binary, Stroq's own entry file and
 * `hook <agent>`, each path in double quotes, nothing else. A handler with any other field (an `env`,
 * a `cwd`) has more than this in its value and does not match.
 *
 * Copilot's and Windsurf's handlers have a second command field, `powershell`, and `init` writes it
 * as `& ` and the same line (`&` is PowerShell's call operator: without it a quoted path is echoed,
 * not run). Each command field is a hook of its own to the reading, so each is judged on its own, and
 * that one is Stroq's when it is `& ` and the exact line. What follows `& ` is checked as the bare
 * line is, so the only program it can start is Stroq's verified entry. The other agents write one
 * command field and no `& `.
 */
const STROQ_HOOK_LINE =
  /^(& )?"([^"\n]+)" "([^"\n]+)" hook (claude-code|cursor|codex|windsurf|copilot|openclaw|antigravity)(?: (?:pre|post|preinvocation))?$/;
/** The agents whose handler `init` gives a `powershell` field, with the line after `& `. */
const POWERSHELL_AGENTS: ReadonlySet<string> = new Set(['copilot', 'windsurf']);
/** The characters a path of a hook line may hold: none that a shell expands (`$`, a backquote, `~`, `%`, `!`). */
const SAFE_PATH = /^[A-Za-z0-9_./\\:@+ -]+$/;
/** Where an installed Stroq keeps its entry file, below a `node_modules` folder. */
const PACKAGE_ENTRY = `${sep}node_modules${sep}@stroq${sep}cli${sep}dist${sep}index.js`;

const realOrNull = (path: string): string | null => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};

const isRegularFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

const isWithin = (path: string, folder: string): boolean =>
  path === folder || path.startsWith(folder.endsWith(sep) ? folder : `${folder}${sep}`);

/**
 * Whether an agent hook is Stroq's own, as `stroq init` wrote it: the exact line, a node binary, and an
 * entry file that really is under the Stroq home or an installed `@stroq/cli`, outside the folder looked
 * at (a repository cannot vouch for a copy of Stroq it carries itself). Anything else counts: a line
 * shaped like Stroq's that runs another file is exactly what a planted hook would look like.
 */
export function isStroqOwnHook(value: string, dir: string, home: string = stroqHome()): boolean {
  const line = STROQ_HOOK_LINE.exec(value);
  if (line === null) return false;
  const [, call, node = '', entry = '', agent = ''] = line;
  if (call !== undefined && !POWERSHELL_AGENTS.has(agent)) return false;
  // No character a shell would expand or quote differently, and both paths written out in full.
  if (![node, entry].every((path) => SAFE_PATH.test(path) && isAbsolute(path))) return false;
  const folder = realOrNull(dir);
  const realNode = realOrNull(node);
  const realEntry = realOrNull(entry);
  if (folder === null || realNode === null || realEntry === null) return false;
  // The node binary that runs it is a real file called node, and neither file is the folder's own.
  if (!/^node(?:\.exe)?$/i.test(basename(realNode)) || !isRegularFile(realNode)) return false;
  if (isWithin(realNode, folder) || isWithin(realEntry, folder)) return false;
  const stroq = realOrNull(home);
  return (stroq !== null && isWithin(realEntry, stroq)) || realEntry.endsWith(PACKAGE_ENTRY);
}

const notOwnHook =
  (dir: string) =>
  (hit: AgentHit): boolean =>
    !(hit.kind === 'agent-hook' && isStroqOwnHook(hit.value, dir));

/** Whether a finding runs when an agent opens the folder, rather than when it later commits or pushes. */
export function runsOnOpen(hit: Pick<RepoExecHit, 'kind' | 'what' | 'hooksJudged'>): boolean {
  // A bare repository found by its shape alone runs nothing: its config is judged and counted as findings of
  // its own. Only that plain finding is left out; a `.git` file that points elsewhere, a `commondir` outside
  // or a folder that could not be listed still counts, since what git would run there was not seen.
  // `inspect` reports all of them.
  if (hit.kind === 'nested-bare-repo' && hit.what === BARE_BY_SHAPE) return false;
  if (hit.kind === 'git-hook-routine') {
    const name = hit.what.split(',')[0]?.trim() ?? '';
    return !LATER_HOOKS.has(name);
  }
  // The key only says where hooks are. When the folder it names was found, the hooks in it were judged
  // one by one and count on their own; when it could not be placed (`~`, a variable), the key counts.
  return !(
    hit.kind === 'git-config-exec' &&
    hit.what.toLowerCase() === 'core.hookspath' &&
    hit.hooksJudged === true
  );
}

/** What the folder runs by itself, or null when it runs nothing. Reads only; runs nothing. */
export function autorunOf(dir: string): AutorunRepo | null {
  const inRepo = repoSurface(dir);
  const surface = inRepo.isRepo ? inRepo : folderSurface(dir);
  const agent = tagChanges(agentSurface(dir).hits, null)
    .filter((h) => isFailing(h, 'any'))
    .filter(notOwnHook(dir));
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
