// Exact matching of known key values, in memory, fast enough to read every session on a
// machine in one pass.
//
// A value is looked for in its spellings: as it is, JSON-escaped (inside a JSON text a tool
// returned), URL-encoded (in a query string), and with the quotes and backslashes a shell command
// splits or escapes it with taken out (`'ab'\''c'`, `ab""c`). Matching is by substring, so a value
// glued into a URL path is found, which the old token match missed.
//
// The search is Wu-Manber's: a table of three-unit blocks from the first `window` units of
// every spelling says how far the scan can jump when the block under it starts no spelling.
// On text without the values it looks at about one position in `window - 2`. Spellings that
// share their whole window are one group: where the window is found it is compared once, and
// what follows it is hashed once, as far as the longest member, and looked up by length, so a
// text that repeats a window thousands of keys share costs one lookup per place, not one per key.
// The work on one text is bounded all the same; past the bound the search stops, and the text is
// counted as one whose search was cut short. It is the same code for UTF-16 text and for raw
// bytes, so a file is first read as bytes and only a file that holds a value is ever parsed.
// There is no pattern in it that can backtrack.
import { closeSync, readSync } from 'node:fs';
import { MIN_SECRET_LENGTH } from '@stroq/core';
import { largest, smallest } from './extremes.js';
import { openRegularFile } from './regular-file.js';

const BLOCK = 3;
const BITS = 18;
const MAX_WINDOW = 64;
/** Bytes read at a time from a session file. */
export const READ_CHUNK = 4 * 1024 * 1024;
/** Work allowed per unit of text searched, and on any text, before the search is cut short. */
const WORK_PER_UNIT = 64;
const WORK_BASE = 1 << 22;

/** What a shell command splits or escapes a word with: quotes and backslashes. */
const SHELL_QUOTING = /['"\\]/g;
/** A text as the shell joins its words: the quotes and backslashes taken out. */
export const shellJoined = (text: string): string => text.replace(SHELL_QUOTING, '');

/** The value, JSON-escaped, URL-encoded and with shell quoting taken out, each spelling once. */
export function keyForms(value: string): string[] {
  const forms = [value, JSON.stringify(value).slice(1, -1)];
  try {
    forms.push(encodeURIComponent(value));
  } catch {
    // A lone surrogate has no URL encoding, and so no URL spelling to look for.
  }
  const joined = shellJoined(value);
  if (joined.length >= MIN_SECRET_LENGTH) forms.push(joined);
  return [...new Set(forms)];
}

/**
 * The spellings a value has in the bytes of a session file. A JSON line holds every string
 * escaped once more than it was read: a value in a JSON text a tool returned is escaped twice.
 * A saved output (`tool-results/*.txt`) is plain text and holds the value as it is.
 */
function fileForms(value: string): string[] {
  const once = JSON.stringify(value).slice(1, -1);
  return [...new Set([...keyForms(value), JSON.stringify(once).slice(1, -1)])];
}

/** Characters a shell command may quote or escape a value around. */
const SHELL_SPECIAL = /[^A-Za-z0-9_\-.,:/+=@%^]/;
/** The shortest run of a value between such characters that is looked for on its own. */
const MIN_RUN = 8;

/**
 * Spellings that make a session file worth parsing, though they are not the value: its two halves
 * (a value split by quotes once, `sk_""live…`, keeps one of them whole), and for a value a shell
 * command may have to quote or escape (`Pa$$w0rd!…`) its longest run between characters a shell
 * treats specially and the value with a backslash before each of `$ \` " \ !`, as it is and
 * JSON-escaped. A file with one is parsed, and the parse decides.
 */
function shellTriggers(value: string): string[] {
  const half = Math.floor(value.length / 2);
  const halves = half >= MIN_RUN ? [value.slice(0, half), value.slice(half)] : [];
  if (!SHELL_SPECIAL.test(value)) return halves;
  const runs = value.split(SHELL_SPECIAL).sort((a, b) => b.length - a.length);
  const escaped = value.replace(/[$`"\\!]/g, (c) => `\\${c}`);
  return [
    ...halves,
    ...((runs[0]?.length ?? 0) >= MIN_RUN ? [runs[0] as string] : []),
    escaped,
    JSON.stringify(escaped).slice(1, -1),
  ];
}

const blockHash = (a: number, b: number, c: number): number =>
  Math.imul(Math.imul(a, 0x2f0b3) ^ Math.imul(b, 0x9e37) ^ c, 0x9e3779b1) >>> (32 - BITS);

/** The hash of what follows a window, extended one unit at a time. */
const tailStep = (hash: number, unit: number): number => (Math.imul(hash, 31) + unit) | 0;

/** Members of a group that run `length` units past the window, by the hash of those units. */
interface Tail {
  readonly length: number;
  readonly byHash: ReadonlyMap<number, readonly number[]>;
}

/** Spellings that share their whole window. */
interface Group {
  /** One of them: the window it starts with is every member's. */
  readonly rep: number;
  /** By how far they run past the window, shortest first. */
  readonly tails: readonly Tail[];
}

interface Table {
  readonly window: number;
  readonly shift: Uint8Array;
  /** For each block that ends a window, the groups whose window it ends. */
  readonly ends: ReadonlyMap<number, readonly Group[]>;
  /** Spelling → the key it spells. */
  readonly owners: readonly number[];
}

/** The groups of spellings that share their window, with their tails hashed. */
function groupsOf(spellings: readonly ArrayLike<number>[], window: number): Group[] {
  const byWindow = new Map<string, number[]>();
  spellings.forEach((units, id) => {
    let key = '';
    for (let i = 0; i < window; i += 1) key += String.fromCharCode(units[i] as number);
    const list = byWindow.get(key);
    if (list === undefined) byWindow.set(key, [id]);
    else list.push(id);
  });
  return [...byWindow.values()].map((ids) => {
    const byLength = new Map<number, Map<number, number[]>>();
    for (const id of ids) {
      const units = spellings[id] as ArrayLike<number>;
      let hash = 0;
      for (let i = window; i < units.length; i += 1) hash = tailStep(hash, units[i] as number);
      const length = units.length - window;
      const byHash = byLength.get(length) ?? new Map<number, number[]>();
      byLength.set(length, byHash);
      byHash.set(hash, [...(byHash.get(hash) ?? []), id]);
    }
    const tails = [...byLength.entries()]
      .sort(([a], [b]) => a - b)
      .map(([length, byHash]) => ({ length, byHash }));
    return { rep: ids[0] as number, tails };
  });
}

/** The jump table for spellings given as code units (UTF-16 or bytes), at least `BLOCK` long. */
function buildTable(spellings: readonly ArrayLike<number>[], owners: readonly number[]): Table {
  // A loop, not a spread: a call takes only so many arguments, and there may be more spellings.
  const window = smallest(spellings, (units) => units.length, MAX_WINDOW);
  const shift = new Uint8Array(1 << BITS).fill(window - BLOCK + 1);
  spellings.forEach((units) => {
    for (let q = BLOCK - 1; q < window; q += 1) {
      const h = blockHash(units[q - 2] as number, units[q - 1] as number, units[q] as number);
      const s = window - 1 - q;
      if (s < (shift[h] as number)) shift[h] = s;
    }
  });
  const ends = new Map<number, Group[]>();
  for (const group of groupsOf(spellings, window)) {
    const units = spellings[group.rep] as ArrayLike<number>;
    const h = blockHash(
      units[window - 3] as number,
      units[window - 2] as number,
      units[window - 1] as number,
    );
    ends.set(h, [...(ends.get(h) ?? []), group]);
  }
  return { window, shift, ends, owners };
}

/** What a search reads: units by position, and whether a spelling is at a position. */
interface Haystack {
  readonly length: number;
  unit(at: number): number;
  /** Whether spelling `id` is at `start`, its first `from` units known to be there. */
  has(id: number, start: number, from: number): boolean;
}

/** Work done by searches, and whether one was cut short by the bound. */
interface Work {
  done: number;
  limit: number;
  cut: boolean;
}

/**
 * Every spelling of `t` whose window starts before `limit` in `text[0..end)`, added to `found` by
 * the key it spells. Stops when `work` reaches its limit, and says so.
 */
function search(
  t: Table,
  text: Haystack,
  end: number,
  limit: number,
  found: Set<number>,
  work: Work,
  lengthOf: (id: number) => number,
): void {
  const { window, shift, ends, owners } = t;
  const stop = Math.min(end, limit + window - 1);
  let pos = window - 1;
  while (pos < stop) {
    const h = blockHash(text.unit(pos - 2), text.unit(pos - 1), text.unit(pos));
    const s = shift[h] as number;
    if (s !== 0) {
      pos += s;
      continue;
    }
    const start = pos - window + 1;
    for (const group of ends.get(h) ?? []) {
      work.done += window;
      if (!text.has(group.rep, start, 0)) continue;
      let hash = 0;
      let at = start + window;
      for (const tail of group.tails) {
        const tailEnd = start + window + tail.length;
        if (tailEnd > end) break;
        work.done += tailEnd - at;
        for (; at < tailEnd; at += 1) hash = tailStep(hash, text.unit(at));
        for (const id of tail.byHash.get(hash) ?? []) {
          const key = owners[id] as number;
          if (found.has(key)) continue;
          work.done += lengthOf(id);
          if (text.has(id, start, window)) found.add(key);
        }
      }
    }
    if (work.done > work.limit) {
      work.cut = true;
      return;
    }
    pos += 1;
  }
}

const unitsOf = (text: string): number[] =>
  Array.from({ length: text.length }, (_, i) => text.charCodeAt(i));

export interface TextMatcher {
  /** The indices of the values found in `text`, in any spelling. */
  find(text: string): Set<number>;
  /** How many texts this matcher's search was cut short in. */
  cuts(): number;
}

/** Spellings of each usable value, with the value's index; a value too short is never looked for. */
function spellingsOf(values: readonly string[], formsOf: (value: string) => string[]) {
  const texts: string[] = [];
  const owners: number[] = [];
  values.forEach((value, key) => {
    if (value.length < MIN_SECRET_LENGTH) return;
    for (const form of formsOf(value)) {
      if (form.length < BLOCK) continue;
      texts.push(form);
      owners.push(key);
    }
  });
  return { texts, owners };
}

const workFor = (length: number): Work => ({
  done: 0,
  limit: WORK_BASE + WORK_PER_UNIT * length,
  cut: false,
});

export function textMatcher(values: readonly string[]): TextMatcher {
  const { texts, owners } = spellingsOf(values, keyForms);
  let cuts = 0;
  if (texts.length === 0) return { find: () => new Set(), cuts: () => 0 };
  const table = buildTable(texts.map(unitsOf), owners);
  const windows = texts.map((t) => t.slice(0, table.window));
  return {
    find(text: string): Set<number> {
      const found = new Set<number>();
      const haystack: Haystack = {
        length: text.length,
        unit: (at) => text.charCodeAt(at),
        has: (id, start, from) =>
          text.startsWith((from === 0 ? windows[id] : texts[id]) as string, start),
      };
      const work = workFor(text.length);
      search(
        table,
        haystack,
        text.length,
        text.length,
        found,
        work,
        (id) => texts[id]?.length ?? 0,
      );
      if (work.cut) cuts += 1;
      return found;
    },
    cuts: () => cuts,
  };
}

/** What reading one file found: the values in it, and whether it could not be read. */
export interface FileScan {
  readonly keys: ReadonlySet<number>;
  readonly failed: boolean;
  /** The search was cut short by its bound: a value past that point was not looked for. */
  readonly cut?: true;
  /** The file holds a spelling that makes it worth parsing, though not a value (`shellTriggers`). */
  readonly triggered?: true;
}

export interface ByteMatcher {
  scanFile(path: string, chunk?: number): FileScan;
  /** `scanFile(path).keys`, for a caller that does not need to know about a failure. */
  findInFile(path: string, chunk?: number): ReadonlySet<number>;
}

/** A table over byte spellings, or null for none. */
function byteTable(texts: readonly string[], owners: readonly number[]) {
  const needles = texts.map((t) => Buffer.from(t, 'utf8'));
  return needles.length === 0 ? null : { table: buildTable(needles, owners), needles };
}

/**
 * `words` are more spellings that make a file worth parsing (the names of key files, the words
 * that print the environment): a file that holds one is parsed for what names a key file.
 */
export function byteMatcher(values: readonly string[], words: readonly string[] = []): ByteMatcher {
  const { texts, owners } = spellingsOf(values, fileForms);
  const keys = byteTable(texts, owners);
  const triggerTexts = [
    ...new Set([
      ...values.filter((v) => v.length >= MIN_SECRET_LENGTH).flatMap(shellTriggers),
      ...words,
    ]),
  ].filter((t) => t.length >= BLOCK);
  const triggers = byteTable(
    triggerTexts,
    triggerTexts.map(() => 0),
  );
  const longest = largest(
    [...(keys?.needles ?? []), ...(triggers?.needles ?? [])],
    (needle) => needle.length,
    0,
  );

  /** Windows of `t` that start before `limit`, in `buf[0..end)`. */
  function scan(
    t: NonNullable<ReturnType<typeof byteTable>>,
    buf: Buffer,
    end: number,
    limit: number,
    found: Set<number>,
    work: Work,
  ): void {
    const window = t.table.window;
    const haystack: Haystack = {
      length: end,
      unit: (at) => buf[at] as number,
      has: (id, start, from) => {
        const needle = t.needles[id] as Buffer;
        const upto = from === 0 ? window : needle.length;
        if (start + upto > end) return false;
        return buf.compare(needle, from, upto, start + from, start + upto) === 0;
      },
    };
    search(t.table, haystack, end, limit, found, work, (id) => t.needles[id]?.length ?? 0);
  }

  function scanFile(path: string, chunk = READ_CHUNK): FileScan {
    const found = new Set<number>();
    const hits = new Set<number>();
    if (keys === null && triggers === null) return { keys: found, failed: false };
    // A FIFO or a device in a session folder is refused, never waited on.
    const fd = openRegularFile(path);
    if (fd === null) return { keys: found, failed: true };
    const keep = longest - 1;
    const buf = Buffer.allocUnsafe(Math.max(1, chunk) + keep);
    let filled = 0;
    const work = workFor(0);
    const pass = (end: number, limit: number): void => {
      work.limit += WORK_PER_UNIT * limit;
      if (keys !== null) scan(keys, buf, end, limit, found, work);
      if (triggers !== null && hits.size === 0) scan(triggers, buf, end, limit, hits, work);
    };
    const result = (): FileScan => ({
      keys: found,
      failed: false,
      ...(work.cut ? { cut: true as const } : {}),
      ...(hits.size > 0 ? { triggered: true as const } : {}),
    });
    try {
      for (;;) {
        const n = readSync(fd, buf, filled, buf.length - filled, null);
        filled += n;
        if (n === 0) {
          pass(filled, filled);
          return result();
        }
        if (filled < buf.length) continue;
        // A value that starts in the last `keep` bytes may end in the next read: those
        // bytes are kept, and the windows that start in them are looked at next time.
        const limit = filled - keep;
        pass(filled, limit);
        if (work.cut) return result();
        buf.copyWithin(0, limit, filled);
        filled = keep;
      }
    } catch {
      return { keys: found, failed: true };
    } finally {
      closeSync(fd);
    }
  }

  return { scanFile, findInFile: (path, chunk) => scanFile(path, chunk).keys };
}
