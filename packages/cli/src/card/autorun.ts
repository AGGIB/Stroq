// Folders that run code as soon as an agent opens them, found with the reading `stroq inspect` does.
//
// Two groups count, and only the ones `inspect` itself calls failing: what the repository's own
// metadata makes git run before anyone approves anything (the pre-trust findings), and the settings an
// agent or editor takes up by itself once the folder is trusted and that run a command or switch a
// guard off (hooks, auto-approved MCP servers, autorun tasks). The ordinary things many honest
// repositories have (a husky hook, a `prepare` script) are not counted: `inspect` lists them as "not
// findings" and a count of them would be a count of every repository there is.
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { readRegularFile } from '@stroq/core';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
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
  /**
   * A digest of everything that runs, the items past the first few included: what each agent setting
   * runs, the bytes of each file git reads, and the bytes of the files either names (a script a hook
   * runs, a file a config includes, the `package.json` that `npm run` reads), one step deep. What the
   * reading cannot cover makes it differ on every run (`unkeyable`). Never shown. A false-alarm mark is
   * kept under it (`false-alarms.ts`), so that a mark on a folder is gone once what the folder runs
   * changes, though its names stay the same.
   */
  readonly evidence: string;
}

/**
 * The longest file whose bytes go into the evidence: a node binary is about 100 MiB. One past it is
 * not hashed, and the moment cannot be marked (`unkeyable`): a size and a date can be put back.
 */
const MAX_EVIDENCE_BYTES = 256 * 1024 * 1024;
/** The longest file whose text is read for the files it names. */
const MAX_TEXT_BYTES = 4 * 1024 * 1024;
/** The most files one text names that go into the evidence, and the most words of it looked at. */
const MAX_NAMED = 32;
const MAX_WORDS = 2_000;
/** What separates the words of a command or a config line that could name a file. Quotes are taken off first. */
const WORD_BREAKS = /[\s\0;&|()<>`=,{}[\]]+/;

/**
 * The words of a command or a config text that could name a file: a variable's braces and every quote
 * taken off first, so that `"$CLAUDE_PROJECT_DIR"/setup.sh` and `${HOME}/x` are one word each.
 */
const wordsOf = (text: string): string[] =>
  text
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, '$$$1')
    .replace(/["']/g, '')
    .split(WORD_BREAKS);

/**
 * Evidence that is never the same twice, for what the reading cannot cover: a file too large to hash,
 * a variable it cannot know the value of, more files than it reads. A moment with it in its key cannot
 * be marked as a false alarm, which is the safe way for a mark to fail.
 */
const unkeyable = (): string => `unkeyable:${randomBytes(16).toString('hex')}`;

/**
 * The files a runner reads for what it runs, when the command names the runner and not the file:
 * `npm run setup` runs what `package.json` says.
 */
const RUNNER_FILES: Readonly<Record<string, readonly string[]>> = {
  npm: ['package.json'],
  npx: ['package.json'],
  pnpm: ['package.json'],
  yarn: ['package.json'],
  bun: ['package.json'],
  bunx: ['package.json'],
  make: ['Makefile', 'makefile', 'GNUmakefile'],
  gmake: ['Makefile', 'makefile', 'GNUmakefile'],
  just: ['justfile', 'Justfile', '.justfile'],
  task: ['Taskfile.yml', 'Taskfile.yaml'],
  uv: ['pyproject.toml'],
  poetry: ['pyproject.toml'],
  pdm: ['pyproject.toml'],
  hatch: ['pyproject.toml'],
  deno: ['deno.json', 'deno.jsonc'],
  cargo: ['Cargo.toml'],
  composer: ['composer.json'],
  rake: ['Rakefile'],
};

/** Opens for a look that neither follows a link nor waits on a pipe: what is read is what the handle shows. */
const LOOK_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/** The digest of what the handle `fd` holds, read through it: the bytes of a file, past the bound its size and date. */
function digestThrough(fd: number, path: string): string {
  const info = fstatSync(fd);
  if (info.isDirectory()) return `dir:${readdirSync(path).sort().join('\u0000')}`;
  if (!info.isFile()) return 'other';
  if (info.size > MAX_EVIDENCE_BYTES) return unkeyable();
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(64 * 1024);
  for (let at = 0; at <= MAX_EVIDENCE_BYTES;) {
    const read = readSync(fd, buffer, 0, buffer.length, at);
    if (read === 0) break;
    hash.update(buffer.subarray(0, read));
    at += read;
  }
  return `file:${hash.digest('hex')}`;
}

/**
 * What the file at `path` holds, as a digest: its bytes, or a folder's names; for a link, where it leads
 * and what is there. The path is opened once, without following a link, and the handle is what is looked
 * at and read, so a file swapped in between is not mistaken for the one that was looked at.
 */
function fileDigest(path: string): string {
  let fd: number;
  try {
    fd = openSync(path, LOOK_FLAGS);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ELOOP') return 'unreadable';
    // A link: what runs is what it leads to, wherever that is.
    try {
      const real = realpathSync(path);
      return `link:${readlinkSync(path)}\u0000${real}\u0000${fileDigest(real)}`;
    } catch {
      return `link:dangling`;
    }
  }
  try {
    return digestThrough(fd, path);
  } catch {
    return 'unreadable';
  } finally {
    closeSync(fd);
  }
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
  const runs: string[][] = [];
  let root: string;
  try {
    root = realpathSync(dir);
  } catch {
    root = dir;
  }
  const named = (text: string, file: string): string =>
    namedFiles(root, text, [root, dirname(join(root, file))]).join('\u0001');
  const add = (item: AutorunItem, what: () => string): void => {
    const key = `${item.file}\u0000${item.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push(item);
    runs.push([item.kind, item.file, item.name, what()]);
  };
  // A finding of git's names no command, so the file it is in stands for it, with what that file names
  // (a script, an included config); an agent setting names its command, and what the command names.
  for (const hit of surface.preTrust.filter(runsOnOpen))
    add({ kind: hit.kind, file: hit.file, name: hit.what }, () => {
      const path = join(root, hit.file);
      return `${fileDigest(path)}\u0000${named(textOf(path), hit.file)}`;
    });
  for (const hit of agent)
    add({ kind: hit.kind, file: hit.file, name: hit.name }, () => {
      const command = `${hit.value}\u0000${hit.runs ?? ''}`;
      return `${command}\u0000${named(command, hit.file)}`;
    });
  if (items.length === 0) return null;
  return {
    dir,
    items: items.slice(0, MAX_ITEMS),
    more: Math.max(0, items.length - MAX_ITEMS),
    evidence: createHash('sha256').update(JSON.stringify(runs)).digest('hex'),
  };
}

/** A word with the home and the project spelled out, or null for one with a variable no reading can know. */
function spelledOut(word: string, root: string): string | null {
  const home = homedir();
  const out = word
    .replace(/^~(?=\/|$)/, home)
    .replace(/\$HOME(?=\/|$)/g, home)
    .replace(/\$CLAUDE_PROJECT_DIR(?=\/|$)/g, root);
  return out.includes('$') || out.startsWith('~') ? null : out;
}

/**
 * The files the words of `text` name, wherever they are, each tried from `bases` in turn, and the files
 * a runner it names reads (`RUNNER_FILES`): as their paths and a digest of each. A word that names none
 * (`origin`, `--force`, a URL) costs a lookup and adds nothing. A variable that is not the home or the
 * project, more files or words than are read: the evidence then cannot cover what runs, and says so.
 */
function namedFiles(root: string, text: string, bases: readonly string[]): string[] {
  const found = new Set<string>();
  const all = wordsOf(text);
  if (all.length > MAX_WORDS) found.add(unkeyable());
  for (const raw of all.slice(0, MAX_WORDS)) {
    if (found.size > MAX_NAMED) {
      found.add(unkeyable());
      break;
    }
    if (raw === '' || raw.startsWith('-') || raw.includes('://')) continue;
    const word = spelledOut(raw, root);
    if (word === null) {
      found.add(unkeyable());
      continue;
    }
    for (const config of RUNNER_FILES[basename(word)] ?? [])
      found.add(`${config}\u0000${fileDigest(join(root, config))}`);
    for (const base of bases) {
      let real: string;
      try {
        real = realpathSync(isAbsolute(word) ? word : join(base, word));
        if (!statSync(real).isFile()) continue;
      } catch {
        continue;
      }
      found.add(`${real}\u0000${fileDigest(real)}`);
      break;
    }
  }
  return [...found].sort();
}

/** The text of a file of the folder, when it is a regular file small enough to read; else empty. */
function textOf(path: string): string {
  try {
    const read = readRegularFile(path, MAX_TEXT_BYTES);
    return read.kind === 'text' ? read.text : '';
  } catch {
    return '';
  }
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
