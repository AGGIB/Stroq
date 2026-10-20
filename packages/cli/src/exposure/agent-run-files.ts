import { startsWithoutAsking, type ChangeStatus, type TaggedHit } from './agent-change.js';
import { hit, type AgentKind, type Severity } from './agent-kinds.js';
import { inAgentFolder } from './agent-surface.js';
import { foldName } from './git-dir-names.js';
import { byPath } from './git-tree.js';
import { NameMatcher, nameForms, normalText, stemOf } from './run-names.js';
import { computesWhatRuns, reachesOf } from './run-programs.js';
import { RUNNER_WORDS, SCRIPT_FILE, isRunnerFile, type RunnerContext } from './run-tables.js';

/**
 * A hook, a server or a task that was already there can start a file of the repository, and a
 * change can edit that file without touching the entry. The entry's value stays the same, so the
 * comparison of values calls it present, while what it runs is new. This reads each such entry's
 * command line coarsely, as text, and follows nothing past it:
 *
 * - a changed file whose name, or the name of a folder it is in, is anywhere in the command fails,
 *   however the command spells the rest of the path (quotes, backslashes and braces are taken out
 *   of both first), and so does one a pattern in the command matches (`*.sh`, `gu{ar,}d.sh`);
 * - a command that names a package manager, a runner or a tool whose config is code fails on a
 *   change to any package file, lock file, runner or tool config, git hook or `node_modules`;
 * - a command whose reach is not written on its line (a variable, inline code, a test runner, a
 *   recipe of make, a program not known) fails on a change to any code, agent or runner file;
 * - a command that cannot be read (too long, not text) fails;
 * - any other code the change edits, while an entry runs code of the repository, is listed to
 *   review: a file the command runs may load it, and what a file loads is not read.
 *
 * The author of the change writes both the commands and the paths, so the work is bounded, and a
 * check that stops at the bound fails rather than passes.
 */

/** The kinds whose value is a command line, and what to call one in a sentence. */
const RUNS: Readonly<Partial<Record<AgentKind, string>>> = {
  'agent-hook': 'hook',
  'agent-helper-command': 'command',
  'agent-env': 'variable',
  'mcp-server': 'MCP server',
  'mcp-server-runs-code': 'MCP server',
  'editor-autorun-task': 'task',
  'agent-definition-hook': 'hook',
  'devcontainer-host-command': 'command',
  'devcontainer-command': 'command',
  'package-script': 'script',
  'package-script-agent-path': 'script',
};

/** Whether an entry already there holds a command line that the reading below follows. */
export const isRunEntry = (h: TaggedHit): boolean =>
  RUNS[h.kind] !== undefined && h.status === 'present';

export interface RunView {
  /**
   * Each path the change added, edited, retyped or deleted, how, and its mode at the head when it
   * is still there. A deleted path is `changed`.
   */
  readonly touchedFiles: readonly (readonly [
    path: string,
    status: 'new' | 'changed',
    mode?: string | undefined,
  ])[];
  /** The links of the head tree whose targets were read: the path in the tree each leads to. */
  readonly links?: ReadonlyMap<string, string>;
  /** How many links of the head tree were not read. */
  readonly linksUnread?: number;
  /** Folders that hold a package.json, at the head or the base; `''` for the top. */
  readonly packageFolders?: ReadonlySet<string>;
  /** The folders `core.hooksPath` names, or `unknown` when git could not say. */
  readonly hooksPaths?: readonly string[] | 'unknown';
}

/** The longest command line read. A real one is a line or two; longer cannot be read, and fails. */
export const MAX_COMMAND_CHARS = 64 * 1024;
/** The most files one entry is reported for; past it, one more finding says how many more. */
export const MAX_FILES_PER_ENTRY = 20;
/** The most findings the reading makes in one check; past it, one failing finding says so. */
export const MAX_RUN_HITS = 2_000;
/** The most code files listed to review; past it, one more finding says how many more. */
export const MAX_REVIEW_FILES = 50;
/** The most work, in characters looked at, that one check spends on command lines. */
export const RUN_LOOKUP_BUDGET = 64 * 1024 * 1024;
/** The most characters of names looked for in all; a change with more fails as not compared. */
export const MAX_NAME_CHARS_TOTAL = 4 * 1024 * 1024;
/** The most patterns in one command that are matched; a command with more counts as open. */
const MAX_PATTERNS = 32;
/** The most other paths one file is reached by through links; past it, every command names it. */
const MAX_ALIASES = 16;
/** As many links on one path as a host follows. */
const MAX_LINK_HOPS = 16;

const EXECUTABLE = '100755';
const SYMLINK = '120000';
const GITLINK = '160000';

/**
 * What is in a command line that is not text: a control character, a byte that was not UTF-8, half
 * of a pair of UTF-16 units.
 */
const NOT_TEXT =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffd]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** A touched file, with what the reading needs of it. */
interface Touched {
  readonly path: string;
  readonly status: ChangeStatus;
  /** Every spelling of every path it is reached by, folded and in lower case. */
  readonly forms: readonly string[];
  readonly code: boolean;
  readonly agent: boolean;
  readonly runner: boolean;
  /** Reached through more links than are worked out: every command counts as naming it. */
  readonly everywhere: boolean;
}

interface Index {
  readonly files: readonly Touched[];
  readonly matcher: NameMatcher;
  /** The files each name stands for, by the name's id. */
  readonly byName: readonly (readonly number[])[];
  readonly overNames: boolean;
}

/** A trie of the folders links lead to, to find the links a path is reached through. */
interface Through {
  readonly links: string[];
  readonly under: Map<string, Through>;
}

function throughOf(links: ReadonlyMap<string, string>): Through {
  const root: Through = { links: [], under: new Map() };
  for (const [link, target] of links) {
    let node = root;
    if (target !== '')
      for (const part of target.split('/')) {
        let next = node.under.get(part);
        if (next === undefined) {
          next = { links: [], under: new Map() };
          node.under.set(part, next);
        }
        node = next;
      }
    node.links.push(link);
  }
  return root;
}

/**
 * The paths a host reaches `path` by, itself first: through each link whose target is the path or
 * a folder above it, round by round. `null` when there are more than `MAX_ALIASES`.
 */
function aliasesOf(path: string, through: Through | undefined): string[] | null {
  if (through === undefined) return [path];
  const found = [path];
  const seen = new Set(found);
  let round = [path];
  for (let hop = 0; hop < MAX_LINK_HOPS && round.length > 0; hop += 1) {
    const next: string[] = [];
    for (const at of round) {
      const parts = at.split('/');
      let node: Through | undefined = through;
      let offset = 0;
      for (let i = 0; node !== undefined; i += 1) {
        for (const link of node.links) {
          const alias = offset === 0 ? `${link}/${at}` : `${link}${at.slice(offset - 1)}`;
          if (seen.has(alias)) continue;
          if (found.length >= MAX_ALIASES) return null;
          seen.add(alias);
          found.push(alias);
          next.push(alias);
        }
        if (i >= parts.length) break;
        node = node.under.get(parts[i] as string);
        offset += (parts[i] as string).length + 1;
      }
    }
    round = next;
  }
  return found;
}

function indexTouched(view: RunView): Index {
  const ctx: RunnerContext = {
    packageFolders: view.packageFolders ?? new Set(),
    hooksPaths: view.hooksPaths ?? [],
  };
  const through = view.links === undefined ? undefined : throughOf(view.links);
  const matcher = new NameMatcher();
  const byName: number[][] = [];
  const files: Touched[] = [];
  let overNames = false;
  const sorted = [...view.touchedFiles].sort(([a], [b]) => byPath(a, b));
  for (const [path, status, mode] of sorted) {
    const at = files.length;
    const aliases = aliasesOf(path, through);
    const paths = aliases ?? [path];
    const forms = new Set<string>();
    let runner = false;
    for (const p of paths) {
      const parts = p.split('/');
      const folded = parts.map((part) => foldName(part)).join('/');
      forms.add(normalText(p));
      forms.add(normalText(folded));
      runner ||=
        isRunnerFile(p.toLowerCase(), ctx, parts.slice(0, -1).join('/')) ||
        isRunnerFile(folded, ctx, parts.slice(0, -1).join('/'));
      parts.forEach((part, i) => {
        const names = nameForms(part);
        const all = i === parts.length - 1 ? [...names, ...names.map(stemOf)] : names;
        for (const name of new Set(all)) {
          if (matcher.size + name.length > MAX_NAME_CHARS_TOTAL && !matcher.has(name)) {
            overNames = true;
            continue;
          }
          const id = matcher.add(name);
          const list = byName[id] ?? (byName[id] = []);
          if (list[list.length - 1] !== at) list.push(at);
        }
      });
    }
    const base = path.slice(path.lastIndexOf('/') + 1);
    files.push({
      path,
      status,
      forms: [...forms],
      code: SCRIPT_FILE.test(base) || mode === EXECUTABLE || mode === SYMLINK || mode === GITLINK,
      agent: paths.some((p) => inAgentFolder(p)),
      runner,
      everywhere: aliases === null,
    });
  }
  matcher.build();
  return { files, matcher, byName, overNames };
}

/** The words of a command that are patterns: `*`, `?`, a brace list, a bracket in a path. */
const BRACE_LIST = /\{[^{}:]*(?:,|\.\.)[^{}:]*\}/;
const WILDCARD = /\*+|\?|\{[^{}:]*\}|\[[^[\]]*\]|\$\{[^{}]*\}|\$\([^()]*\)|\$[a-z_][a-z0-9_]*/;
const isPattern = (word: string): boolean =>
  /[*?]/.test(word) || BRACE_LIST.test(word) || (word.includes('[') && /[./]/.test(word));

/** The literal parts of a pattern, in order, that a path it matches holds; empty when there are none. */
const fragmentsOf = (word: string): string[] =>
  word
    .split(new RegExp(WILDCARD.source, 'g'))
    .map(normalText)
    .filter((part) => !/^[./]*$/.test(part));

/** Whether `text` holds each of `parts`, in order. */
function holdsInOrder(text: string, parts: readonly string[]): boolean {
  let at = 0;
  for (const part of parts) {
    const found = text.indexOf(part, at);
    if (found === -1) return false;
    at = found + part.length;
  }
  return true;
}

/** What one command line reaches among the touched files. */
interface Judged {
  /** Why the command could not be read, when it could not. */
  readonly unread?: string;
  /** The touched files it fails on, by index. */
  readonly fails: ReadonlySet<number>;
  /** Whether it runs code of the repository, so that any other code change is listed to review. */
  readonly runsRepoCode: boolean;
  readonly work: number;
}

/** Reads one command line against the touched files. */
function judge(command: string, isEnv: boolean, index: Index): Judged {
  const fails = new Set<number>();
  if (command.length > MAX_COMMAND_CHARS)
    return {
      unread: `it is ${command.length} characters long, past the ${MAX_COMMAND_CHARS} read`,
      fails,
      runsRepoCode: true,
      work: 0,
    };
  if (NOT_TEXT.test(command))
    return { unread: 'it holds bytes that are not text', fails, runsRepoCode: true, work: 0 };
  const text = normalText(command);
  let work = command.length * 4;
  const name = (id: number): void => {
    for (const file of index.byName[id] ?? []) fails.add(file);
  };
  work += index.matcher.scan(text, name);
  // A brace list names each of its words: `{guard,x}.sh` holds `guard`, `gu{ar,}d.sh` `guard.sh`.
  if (text.includes(',')) work += index.matcher.scan(text.replace(/,/g, ''), name);
  index.files.forEach((f, i) => {
    if (f.everywhere) fails.add(i);
  });

  const words = command
    .toLowerCase()
    .replace(/["'\\]/g, '')
    .split(/[\s;&|()<>`]+/);
  const patterns = words.filter(isPattern);
  let open = patterns.length > MAX_PATTERNS;
  for (const pattern of open ? [] : patterns) {
    const parts = fragmentsOf(pattern);
    if (parts.length === 0) {
      open = true;
      continue;
    }
    index.files.forEach((f, i) => {
      for (const form of f.forms) {
        work += form.length + pattern.length;
        if (holdsInOrder(form, parts)) {
          fails.add(i);
          return;
        }
      }
    });
  }

  const tokens = text.split(/[^a-z0-9_-]+/);
  const runner = tokens.some((t) => RUNNER_WORDS.has(t));
  const reaches = isEnv ? [] : reachesOf(command);
  open ||= computesWhatRuns(command, isEnv) || reaches.includes('open');
  const pathLike = text
    .split(/[\s;&|()<>=,]+/)
    .some(
      (t) =>
        t.includes('/') || (t.startsWith('.') && t.length > 1) || /\.[a-z][\w-]{0,15}$/.test(t),
    );
  index.files.forEach((f, i) => {
    if ((runner && f.runner) || (open && (f.code || f.agent || f.runner))) fails.add(i);
  });
  const runsRepoCode =
    isEnv || runner || open || pathLike || reaches.some((r) => r === 'runs' || r === 'runner');
  return { fails, runsRepoCode, work: work + index.files.length };
}

/** An entry's severity for what it runs: a hook's script fails, an ordinary server's is listed. */
const severityOf = (h: TaggedHit): Severity =>
  h.severity === 'error' || h.kind === 'agent-env' || startsWithoutAsking(h) ? 'error' : 'warning';

/**
 * One finding per changed file that a present entry may run, as severe as the entry that runs
 * it; one finding per entry whose command could not be read; and, listed to review, the other
 * code the change edits while an entry runs code of the repository.
 */
export function runFileChanges(hits: readonly TaggedHit[], view: RunView): TaggedHit[] {
  const entries = hits.filter(isRunEntry);
  if (entries.length === 0 || view.touchedFiles.length === 0) return [];
  const index = indexTouched(view);
  const out = new Map<string, TaggedHit>();
  /** The files some entry runs: listed as such, so not listed again to review. */
  const named = new Set<number>();
  const review = new Map<number, string>();
  const unreadable = (file: string, name: string, why: string): void => {
    out.set(`\0unread\0${file}\0${name}\0${why}`, {
      ...hit('unreadable-config', file, 1, name, why),
      status: 'new',
    });
  };
  if (index.overNames)
    unreadable(
      entries[0]?.file ?? '',
      'run files',
      `the change touched more names than one check compares, past ${MAX_NAME_CHARS_TOTAL} characters, so what the entries already there run was not worked out`,
    );
  if ((view.linksUnread ?? 0) > 0)
    unreadable(
      entries[0]?.file ?? '',
      'run files',
      `${view.linksUnread} links of the tree were not read, so a file an entry already there names could be behind one`,
    );
  let spent = 0;
  for (const h of entries) {
    const name = `${h.name} ${RUNS[h.kind] as string} in ${h.file}`;
    const judged = judge(h.value, h.kind === 'agent-env', index);
    spent += judged.work;
    if (judged.unread !== undefined) {
      unreadable(
        h.file,
        name,
        `the command of the ${name} could not be read (${judged.unread}), so any file the change touched could be what it runs`,
      );
      continue;
    }
    const severity = severityOf(h);
    const fails = [...judged.fails].sort((a, b) => a - b);
    for (const i of fails.slice(0, MAX_FILES_PER_ENTRY)) {
      const f = index.files[i] as Touched;
      out.set(`${f.path}\0${name}`, {
        ...hit('agent-run-file-changed', f.path, 1, name, f.path),
        severity,
        status: f.status,
      });
    }
    if (fails.length > MAX_FILES_PER_ENTRY)
      out.set(`\0more\0${name}`, {
        ...hit(
          'agent-run-file-changed',
          h.file,
          1,
          name,
          `${fails.length - MAX_FILES_PER_ENTRY} more files the change touched`,
        ),
        severity,
        status: 'new',
      });
    for (const i of fails) named.add(i);
    if (judged.runsRepoCode)
      index.files.forEach((f, i) => {
        if (f.code && !judged.fails.has(i) && !review.has(i)) review.set(i, name);
      });
    if (out.size > MAX_RUN_HITS) {
      const why = `the entries already there run more than ${MAX_RUN_HITS} files the change touched, so not all are listed`;
      unreadable(h.file, 'run files', why);
      break;
    }
    if (spent > RUN_LOOKUP_BUDGET) {
      const why = `the commands of the entries already there were too long to compare with what the change touched, past ${RUN_LOOKUP_BUDGET} characters`;
      unreadable(h.file, 'run files', why);
      break;
    }
  }
  const listed = [...review].filter(([i]) => !named.has(i));
  for (const [i, name] of listed.slice(0, MAX_REVIEW_FILES)) {
    const f = index.files[i] as Touched;
    out.set(`\0review\0${f.path}`, {
      ...hit('agent-run-file-changed', f.path, 1, name, REVIEW),
      severity: 'warning',
      status: f.status,
    });
  }
  if (listed.length > MAX_REVIEW_FILES)
    out.set('\0review\0more', {
      ...hit(
        'agent-run-file-changed',
        (index.files[(listed[MAX_REVIEW_FILES] as [number, string])[0]] as Touched).path,
        1,
        'code the entries already there may load',
        `${listed.length - MAX_REVIEW_FILES} more code files the change touched`,
      ),
      severity: 'warning',
      status: 'new',
    });
  return [...out.values()];
}

/** The value of a finding that lists code an entry may load, to review. */
export const REVIEW = 'code an entry already there may load';
