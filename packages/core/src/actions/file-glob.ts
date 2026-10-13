import { lstatSync, opendirSync, type Dir } from 'node:fs';
import { resolve } from 'node:path';
import { expandBraces } from './brace-expansion.js';
import { followedBy } from './followed-by.js';

/**
 * The files a name stands for when it holds a file-name pattern or a brace expansion.
 *
 * `bash x.s?`, `bash *.sh` and `bash {x,y}.sh` run a file that the text of the command does not
 * name: the shell expands the word before `bash` sees it, so the file is whatever the directory
 * holds at that moment. A reader of the words sees a name that no file has and reads nothing,
 * which makes the pattern a way round the reading of a script. So the directory is listed and
 * what matches is read.
 *
 * A pattern matches as a shell's does: `*` and `?` and `[…]` (with `!` or `^`, ranges and
 * `[:class:]`), a backslash that makes the next character itself, a name that begins with a dot
 * only by a pattern that does. A class this does not know matches anything, which can only add a
 * file to be read. What a zsh adds (a recursive `**`, `x.(sh|bash)`, qualifiers) is not read, except that a
 * `**` segment is not enumerated and is said to be unread.
 *
 * Bounded, because the text of a pattern and the contents of a directory are both written by
 * whoever wrote the command, and this is read inside a hook that cannot wait: a name is matched
 * in steps that are counted, a directory is read to a limit, and one command shares one budget.
 * Where a limit is reached, the answer says it is not the whole of what the name stands for.
 */

const MAX_PATTERN_CHARS = 256;
/** The most paths one name stands for before it is not read further. */
export const MAX_PATTERN_PATHS = 64;
/** The most directories one segment of a pattern may lead through. */
const MAX_LEVEL_PATHS = 1024;
const MAX_ENTRIES_PER_DIRECTORY = 4096;

/**
 * Whether a text sets something that changes what a pattern matches, which this does not read as
 * a shell with it set would: `shopt -s dotglob`, `setopt globdots`, `GLOBIGNORE=…`, a zsh qualifier
 * such as `(D)`. A pattern in such a command is not taken for the files it lists.
 */
const GLOB_OPTION_HEAD = /\b(?:shopt|setopt|unsetopt|set)\b/;
const GLOB_OPTION_TAIL =
  /\b(?:no_?case_?glob|case_?glob|dot_?glob|glob_?dots|glob_?star|ext_?glob|ksh_?glob|glob_?subst|null_?glob|fail_?glob|rc_?expand_?param|no_?glob)\b/i;
const GLOB_OPTIONS = followedBy(GLOB_OPTION_HEAD, GLOB_OPTION_TAIL, 'command');
export const changesGlobbing = (text: string): boolean =>
  GLOB_OPTIONS.test(text) || /\bGLOBIGNORE=|\([^()\s]*D[^()\s]*\)/.test(text);

/** Whether a name holds a pattern or a brace expansion, so that it may stand for more than itself. */
export const isPattern = (name: string): boolean => /[*?[{]|[+@!]\(/.test(name);
const hasWildcard = (part: string): boolean => /[*?[]|[+@!]\(/.test(part);

/** What one command may spend on patterns, in directory entries read and characters compared. */
export interface PatternBudget {
  entries: number;
  steps: number;
  readonly listed: Map<string, Listing>;
  /** The units of each segment read so far: one segment is read once, however many words hold it. */
  readonly parsed: Map<string, Unit[]>;
  /** The command sets an option that changes how patterns match: none of them is read exactly. */
  unreliable: boolean;
}

interface Entry {
  readonly name: string;
  /** A directory, or a link that may lead to one: what a pattern may go on through. */
  readonly directory: boolean;
}

interface Listing {
  readonly names: readonly Entry[];
  /** False when the directory held more than was read. */
  readonly whole: boolean;
}

export function newPatternBudget(): PatternBudget {
  return {
    entries: 16_384,
    steps: 400_000,
    listed: new Map(),
    parsed: new Map(),
    unreliable: false,
  };
}

export interface PatternFiles {
  readonly paths: readonly string[];
  /** False when a limit was reached: there may be more than `paths` holds. */
  readonly complete: boolean;
}

type Member = { readonly from: string; readonly to: string } | { readonly named: string };

type Unit =
  | { readonly kind: 'star' }
  | { readonly kind: 'any' }
  | { readonly kind: 'char'; readonly char: string }
  | { readonly kind: 'set'; readonly negated: boolean; readonly members: readonly Member[] };

const STAR: Unit = { kind: 'star' };
const ANY: Unit = { kind: 'any' };

const CLASSES: Readonly<Record<string, RegExp>> = {
  alpha: /[A-Za-z]/,
  digit: /[0-9]/,
  alnum: /[A-Za-z0-9]/,
  upper: /[A-Z]/,
  lower: /[a-z]/,
  space: /\s/,
  blank: /[ \t]/,
  punct: /[!-/:-@[-`{-~]/,
  xdigit: /[0-9A-Fa-f]/,
};

/** For each index, where the next `:]` begins at or after it, or -1: one pass, not a search per `[:`. */
function classCloses(pattern: string): number[] {
  const next: number[] = new Array<number>(pattern.length + 2).fill(-1);
  for (let i = pattern.length - 1; i >= 0; i -= 1)
    next[i] = pattern.startsWith(':]', i) ? i : (next[i + 1] as number);
  return next;
}

/** The set that opens at `open`, or null when it is never closed, which makes the `[` itself. */
function parseSet(
  pattern: string,
  open: number,
  closes: readonly number[],
): { unit: Unit; next: number } | null {
  let at = open + 1;
  const negated = pattern.charAt(at) === '!' || pattern.charAt(at) === '^';
  if (negated) at += 1;
  const members: Member[] = [];
  for (let first = true; at < pattern.length; first = false) {
    let ch = pattern.charAt(at);
    if (ch === ']' && !first) return { unit: { kind: 'set', negated, members }, next: at + 1 };
    const classEnd = ch === '[' && pattern.charAt(at + 1) === ':' ? (closes[at + 2] ?? -1) : -1;
    if (classEnd !== -1) {
      members.push({ named: pattern.slice(at + 2, classEnd) });
      at = classEnd + 2;
      continue;
    }
    if (ch === '\\' && at + 1 < pattern.length) {
      at += 1;
      ch = pattern.charAt(at);
    }
    const range =
      pattern.charAt(at + 1) === '-' && at + 2 < pattern.length && pattern.charAt(at + 2) !== ']';
    if (!range) {
      members.push({ from: ch, to: ch });
      at += 1;
      continue;
    }
    const escaped = pattern.charAt(at + 2) === '\\' && at + 3 < pattern.length;
    members.push({ from: ch, to: pattern.charAt(at + (escaped ? 3 : 2)) });
    at += escaped ? 4 : 3;
  }
  return null;
}

function unitsOf(pattern: string): Unit[] {
  const units: Unit[] = [];
  const closes = classCloses(pattern);
  for (let at = 0; at < pattern.length;) {
    const ch = pattern.charAt(at);
    if (ch === '*') {
      while (pattern.charAt(at) === '*') at += 1;
      units.push(STAR);
    } else if (ch === '?') {
      units.push(ANY);
      at += 1;
    } else if (ch === '[') {
      const set = parseSet(pattern, at, closes);
      units.push(set === null ? { kind: 'char', char: ch } : set.unit);
      at = set === null ? at + 1 : set.next;
    } else if (ch === '\\' && at + 1 < pattern.length) {
      units.push({ kind: 'char', char: pattern.charAt(at + 1) });
      at += 2;
    } else {
      units.push({ kind: 'char', char: ch });
      at += 1;
    }
  }
  return units;
}

function inMember(member: Member, ch: string): boolean {
  if ('named' in member) {
    const known = Object.hasOwn(CLASSES, member.named) ? CLASSES[member.named] : undefined;
    return known === undefined || ch.charCodeAt(0) > 127 || known.test(ch);
  }
  return ch >= member.from && ch <= member.to;
}

function unitMatches(unit: Unit, ch: string): boolean {
  if (unit.kind === 'any') return true;
  if (unit.kind === 'char') return unit.char === ch;
  if (unit.kind === 'set') return unit.members.some((m) => inMember(m, ch)) !== unit.negated;
  return false;
}

/** A name against the units of a pattern, one backtrack point at a time, in counted steps. */
function matchesUnits(units: readonly Unit[], name: string, budget: PatternBudget): boolean {
  let u = 0;
  let n = 0;
  let star = -1;
  let resume = 0;
  while (n < name.length) {
    budget.steps -= 1;
    if (budget.steps < 0) return false;
    const unit = units[u];
    if (unit?.kind === 'star') {
      star = u;
      resume = n;
      u += 1;
    } else if (unit !== undefined && unitMatches(unit, name.charAt(n))) {
      u += 1;
      n += 1;
    } else if (star !== -1) {
      resume += 1;
      n = resume;
      u = star + 1;
    } else return false;
  }
  while (units[u]?.kind === 'star') u += 1;
  return u === units.length;
}

/** Whether a name matches a pattern, with no regard for a leading dot: `case` matches that way. */
export const matchesPattern = (pattern: string, name: string): boolean =>
  matchesUnits(unitsOf(pattern), name, {
    entries: 0,
    steps: 1_000_000,
    listed: new Map(),
    parsed: new Map(),
    unreliable: false,
  });

/** An entry of a directory against one segment of a pattern: a leading dot is matched only by a dot. */
function matchesEntry(
  segment: string,
  units: readonly Unit[],
  entry: string,
  budget: PatternBudget,
): boolean {
  if (entry.startsWith('.') && !segment.startsWith('.') && !segment.startsWith('\\.')) return false;
  return matchesUnits(units, entry, budget);
}

/** The units of one segment: read once, however many words hold it, and paid for by its length. */
function unitsOfSegment(part: string, budget: PatternBudget): Unit[] {
  const known = budget.parsed.get(part);
  if (known !== undefined) return known;
  budget.steps -= part.length * 16;
  const units = unitsOf(part);
  budget.parsed.set(part, units);
  return units;
}

function listing(directory: string, budget: PatternBudget): Listing {
  const known = budget.listed.get(directory);
  if (known !== undefined) return known;
  const names: Entry[] = [];
  let whole = true;
  let handle: Dir | null = null;
  let opened = false;
  try {
    handle = opendirSync(directory);
    opened = true;
    for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
      if (names.length >= MAX_ENTRIES_PER_DIRECTORY || budget.entries <= 0) {
        whole = false;
        break;
      }
      budget.entries -= 1;
      names.push({ name: entry.name, directory: entry.isDirectory() || entry.isSymbolicLink() });
    }
  } catch {
    // Not a directory, or one that cannot be listed, names nothing; one that failed part way is
    // not the whole of what it holds.
    whole = !opened;
  } finally {
    try {
      handle?.closeSync();
    } catch {
      // Already closed.
    }
  }
  // A pattern that begins with a dot matches these two, in a bash that lists them.
  if (opened) names.push({ name: '.', directory: true }, { name: '..', directory: true });
  const found = { names, whole };
  budget.listed.set(directory, found);
  return found;
}

/** The paths one word with `*`, `?` or `[` in it stands for, appended to `out`; whether that is all. */
function walk(word: string, cwd: string, budget: PatternBudget, out: string[]): boolean {
  const parts = word.split('/').filter((part) => part !== '');
  let level: string[] = [word.startsWith('/') ? '/' : ''];
  let complete = true;
  for (let index = 0; index < parts.length && level.length > 0; index += 1) {
    const part = parts[index] as string;
    const tail = index === parts.length - 1 ? '' : '/';
    const next: string[] = [];
    for (const prefix of level) {
      if (!hasWildcard(part)) {
        next.push(`${prefix}${part}${tail}`);
        continue;
      }
      // A `**` or `***` that a zsh reads as every directory below is not listed that deep: it is said.
      if (/^\*{2,}$/.test(part) && tail !== '') complete = false;
      const found = listing(resolve(cwd, prefix === '' ? '.' : prefix), budget);
      complete &&= found.whole;
      const units = unitsOfSegment(part, budget);
      for (const entry of found.names) {
        // A name that is gone through to reach a file has to be a directory.
        if (tail !== '' && !entry.directory) continue;
        // What is gone through is looked at in turn, within the entries one command may read; only
        // what is listed at the end is counted against the paths a name may stand for.
        if (next.length >= (tail === '' ? MAX_PATTERN_PATHS : MAX_LEVEL_PATHS)) {
          complete = false;
          break;
        }
        // The steps are spent: what is left of the directory is not read.
        if (budget.steps < 0) break;
        if (matchesEntry(part, units, entry.name, budget))
          next.push(`${prefix}${entry.name}${tail}`);
      }
    }
    level = next;
  }
  // A name that ends in a literal segment (`*/build.sh`) is there only if a file is.
  const literalLast = !hasWildcard(parts[parts.length - 1] ?? '');
  for (const path of level) if (!literalLast || exists(path, cwd, budget)) out.push(path);
  return complete && budget.steps >= 0;
}

/** Whether a path names something: looked up, once for each name, within the entries one command may read. */
function exists(path: string, cwd: string, budget: PatternBudget): boolean {
  if (budget.entries <= 0) return true;
  budget.entries -= 1;
  try {
    lstatSync(resolve(cwd, path));
    return true;
  } catch {
    return false;
  }
}

/** A ksh extended glob, which a zsh with `KSH_GLOB` and a bash with `extglob` read: `?(.)`, `@(a|b)`. */
const GROUP = /[?*+@!]\([^()]*\)/g;
const MAX_GROUP_PASSES = 4;

/**
 * The word with each such group made a `*`, which matches whatever the group would and more, so
 * that a file it names is among those listed; or null when the word holds a form this does not
 * read, which a zsh reads without being told to: `(a|b)`, `#`, `^` and a `~` that excludes.
 */
function withoutGroups(word: string): string | null {
  let flat = word;
  for (let pass = 0; pass < MAX_GROUP_PASSES; pass += 1) {
    const next = flat.replace(GROUP, '*');
    if (next === flat) break;
    flat = next;
  }
  // `[.x.]` and `[=x=]` are a bash's collating symbols and classes of equivalents, not a set of `.`, `x`.
  return /[()|#]|\[[.=]|(?:^|\/)\^|.~/.test(flat) ? null : flat;
}

/**
 * The paths a name can stand for, as they would be written from `cwd`: its brace expansion, each
 * word of which that holds a pattern is matched against what the directories hold.
 */
export function filesNamedBy(
  name: string,
  cwd: string,
  budget: PatternBudget,
  expand: (word: string) => string = (word) => word,
): PatternFiles {
  const words = name.length > MAX_PATTERN_CHARS ? null : expandBraces(name);
  if (words === null) return { paths: [], complete: false };
  const paths: string[] = [];
  let complete = true;
  for (const spelt of words) {
    // `{~,/x}/f` is `~/f` and `/x/f`: the word is what a shell makes of it once the braces are.
    const word = expand(spelt);
    // What stands in a set is what it is: `a[$]b.sh` is a name, not an expansion.
    if (/[$`<>]/.test(word.replace(/\[[^\]]*\]/g, ''))) continue;
    const flat = hasWildcard(word) ? withoutGroups(word) : word;
    // An option set in the command changes what a pattern matches: it is not read as it is.
    if (flat === null || (budget.unreliable && hasWildcard(word))) complete = false;
    else if (!hasWildcard(flat)) paths.push(flat);
    else complete = walk(flat, cwd, budget, paths) && complete;
  }
  return paths.length > MAX_PATTERN_PATHS
    ? { paths: paths.slice(0, MAX_PATTERN_PATHS), complete: false }
    : { paths, complete };
}
