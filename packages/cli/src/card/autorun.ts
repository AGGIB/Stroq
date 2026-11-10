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
import { CURSOR_EVENTS, type CursorEvent } from '../adapters/cursor.js';
import { cursorEntry } from '../commands/cursor-hooks.js';
import { isBare, withoutFailClosed } from '../commands/hook-command.js';
import { isFailing, tagChanges } from '../exposure/agent-change.js';
import { isHandlerLabel } from '../exposure/agent-json.js';
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
/** Windows init omits quotes for these handlers and may use an 8.3 path. */
const WINDOWS_HOOK_LINE =
  /^(\S+) (\S+) hook (?:cursor|codex|antigravity (?:pre|post|preinvocation))$/;
const isBareWindowsPath = (path: string): boolean =>
  /^[A-Za-z]:[\\/][^:]+$/.test(path) && isBare(path);
/** The agents whose handler `init` gives a `powershell` field, with the line after `& `. */
const POWERSHELL_AGENTS: ReadonlySet<string> = new Set(['copilot', 'windsurf']);
/** The characters a path of a hook line may hold: none that a shell expands (`$`, a backquote, `~`, `%`, `!`). */
const SAFE_PATH = /^[A-Za-z0-9_./\\:@+ -]+$/;
/** Where an installed Stroq keeps its entry file, below a `node_modules` folder. */
const PACKAGE_ENTRY = `${sep}node_modules${sep}@stroq${sep}cli${sep}dist${sep}index.js`;

const realOrNull = (path: string): string | null => {
  try {
    const real = realpathSync.native(path);
    return process.platform === 'win32' ? real.toLowerCase() : real;
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
export function isStroqOwnHook(given: string, dir: string, home: string = stroqHome()): boolean {
  // Claude Code's line ends in `CLAUDE_CODE_FAIL_CLOSED`, word for word, or (as older versions wrote it) not.
  const value = withoutFailClosed(given);
  const quoted = STROQ_HOOK_LINE.exec(value);
  if (value !== given && quoted?.[4] !== 'claude-code') return false;
  const bare = process.platform === 'win32' ? WINDOWS_HOOK_LINE.exec(value) : null;
  let node: string;
  let entry: string;
  if (quoted?.[0] === value) {
    const [, call, binary = '', script = '', agent = ''] = quoted;
    if (call !== undefined && !POWERSHELL_AGENTS.has(agent)) return false;
    if (![binary, script].every((path) => SAFE_PATH.test(path) && isAbsolute(path))) return false;
    [node, entry] = [binary, script];
  } else if (bare?.[0] === value) {
    const [, binary = '', script = ''] = bare;
    if (![binary, script].every(isBareWindowsPath)) return false;
    [node, entry] = [binary, script];
  } else return false;
  const folder = realOrNull(dir);
  const realNode = realOrNull(node);
  const realEntry = realOrNull(entry);
  if (folder === null || realNode === null || realEntry === null) return false;
  // The node binary that runs it is a real file called node, and neither file is the folder's own.
  if (!/^node(?:\.exe)?$/i.test(basename(realNode)) || !isRegularFile(realNode)) return false;
  if (!isRegularFile(realEntry)) return false;
  if (isWithin(realNode, folder) || isWithin(realEntry, folder)) return false;
  const stroq = realOrNull(home);
  return (stroq !== null && isWithin(realEntry, stroq)) || realEntry.endsWith(PACKAGE_ENTRY);
}

/** Where the reading of a folder puts a handler's other fields after its command (`otherFields`). */
const FIELDS_MARK = ' with {';

/**
 * The fields `stroq init` writes beside the command of a Cursor hook for an event, as the reading shows
 * them: what is left beside the command must be exactly this.
 */
function ownCursorFields(event: string): Readonly<Record<string, unknown>> | null {
  if (!(CURSOR_EVENTS as readonly string[]).includes(event)) return null;
  // The reading leaves out the command and the labels of a handler (`isHandlerLabel`): so is this.
  return Object.fromEntries(
    Object.entries(cursorEntry(event as CursorEvent, '')).filter(([key]) => !isHandlerLabel(key)),
  );
}

const sameFields = (a: Readonly<Record<string, unknown>>, b: Readonly<Record<string, unknown>>) =>
  Object.keys(a).length === Object.keys(b).length &&
  Object.entries(a).every(([key, value]) => b[key] === value);

/**
 * The command of a hook as `init` wrote it, without the fields `init` writes beside it. A hook with
 * any other field, or another value in one, is left as the reading shows it, so it is not Stroq's own.
 */
function commandOf(hit: AgentHit): string {
  const at = hit.value.lastIndexOf(FIELDS_MARK);
  if (at === -1) return hit.value;
  const own = ownCursorFields(hit.name);
  if (own === null) return hit.value;
  try {
    const fields: unknown = JSON.parse(hit.value.slice(at + FIELDS_MARK.length - 1));
    const isObject = typeof fields === 'object' && fields !== null && !Array.isArray(fields);
    return isObject && sameFields(fields as Record<string, unknown>, own)
      ? hit.value.slice(0, at)
      : hit.value;
  } catch {
    return hit.value;
  }
}

const notOwnHook =
  (dir: string) =>
  (hit: AgentHit): boolean =>
    !(hit.kind === 'agent-hook' && isStroqOwnHook(commandOf(hit), dir));

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
