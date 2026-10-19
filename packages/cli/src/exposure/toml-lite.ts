import { isPlainObject } from '../commands/config-file.js';

/**
 * The part of TOML a config file uses, read without a library (Stroq adds none for this):
 * tables and arrays of tables, dotted and quoted keys, the four kinds of string, arrays across
 * lines and inline tables. Anything else makes the whole text unreadable, and the caller
 * decides what that means. Keys are set as own properties, so `__proto__` is only a key.
 *
 * Every step looks at the text in front of it and no further than the token it reads, so the
 * work is linear in the length of the text.
 */

export type Obj = Record<string, unknown>;

type Token =
  | { readonly t: 'str'; readonly v: string; readonly line: number }
  | { readonly t: 'word'; readonly v: string; readonly line: number }
  | { readonly t: 'punct'; readonly v: string; readonly line: number; readonly at: number }
  | { readonly t: 'nl'; readonly line: number };

class Unreadable extends Error {}

const PUNCT = new Set(['[', ']', '{', '}', ',', '=', '.']);
const ESCAPES: Readonly<Record<string, string>> = {
  b: '\b',
  t: '\t',
  n: '\n',
  f: '\f',
  r: '\r',
  '"': '"',
  '\\': '\\',
};
/** The deepest arrays and inline tables are nested before the file counts as unreadable. */
const MAX_DEPTH = 64;

interface Read {
  readonly v: string;
  /** Just past the closing quote. */
  readonly end: number;
}

/** The escape at `i` (a backslash) of a basic string: what it stands for and where it ends. */
function escapeAt(text: string, i: number): Read {
  const e = text[i + 1] ?? '';
  const width = e === 'u' ? 4 : e === 'U' ? 8 : 0;
  if (width > 0) {
    const hex = text.slice(i + 2, i + 2 + width);
    if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== width) throw new Unreadable('escape');
    return { v: String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff)), end: i + 2 + width };
  }
  const plain = ESCAPES[e];
  if (plain === undefined) throw new Unreadable('escape');
  return { v: plain, end: i + 2 };
}

/** A basic string's body from `start` (after the quote): the text and where it ends. */
function basicString(text: string, start: number): Read {
  let out = '';
  for (let i = start; i < text.length;) {
    const c = text[i] as string;
    if (c === '"') return { v: out, end: i + 1 };
    if (c === '\n') break;
    if (c !== '\\') {
      out += c;
      i += 1;
      continue;
    }
    const escaped = escapeAt(text, i);
    out += escaped.v;
    i = escaped.end;
  }
  throw new Unreadable('string');
}

/** A literal string from `start` (after the quote). Looks no further than its closing quote. */
function literalString(text: string, start: number): Read {
  const close = text.indexOf("'", start);
  if (close === -1) throw new Unreadable('string');
  const v = text.slice(start, close);
  if (v.includes('\n')) throw new Unreadable('string');
  return { v, end: close + 1 };
}

/**
 * Where a multi-line string closes, given the offset `at` of a run of its quote: TOML lets up
 * to two quotes stand just before the closing three, so the last three of the run close it.
 * -1 when the run is too short to close anything.
 */
function closingRun(text: string, at: number, quote: string): number {
  let run = 0;
  while (run < 6 && text[at + run] === quote) run += 1;
  if (run < 3) return -1;
  if (run > 5) throw new Unreadable('multi-line string');
  return at + run - 3;
}

const skipFirstNewline = (text: string, at: number): number =>
  text.startsWith('\r\n', at) ? at + 2 : text[at] === '\n' ? at + 1 : at;

/** A line-ending backslash: the blanks and newlines after it are dropped. -1 when it is not one. */
function lineEnding(text: string, at: number): number {
  let i = at + 1;
  while (isBlank(text[i] ?? '')) i += 1;
  if (text[i] !== '\n') return -1;
  while (isBlank(text[i] ?? '') || text[i] === '\n') i += 1;
  return i;
}

/** A `"""` string from `start` (after the quotes), its escapes and line-ending backslashes read. */
function multiLineBasic(text: string, start: number): Read {
  let out = '';
  for (let i = skipFirstNewline(text, start); i < text.length;) {
    const c = text[i] as string;
    if (c === '"') {
      const close = closingRun(text, i, '"');
      if (close !== -1) return { v: out + text.slice(i, close), end: close + 3 };
    }
    if (c !== '\\') {
      out += c;
      i += 1;
      continue;
    }
    const skipped = lineEnding(text, i);
    if (skipped !== -1) {
      i = skipped;
      continue;
    }
    const escaped = escapeAt(text, i);
    out += escaped.v;
    i = escaped.end;
  }
  throw new Unreadable('multi-line string');
}

/** A `'''` string from `start` (after the quotes), taken as it is. */
function multiLineLiteral(text: string, start: number): Read {
  const from = skipFirstNewline(text, start);
  const at = text.indexOf("'''", from);
  if (at === -1) throw new Unreadable('multi-line string');
  const close = closingRun(text, at, "'");
  return { v: text.slice(from, close), end: close + 3 };
}

/** The string that opens at `i` with `quote`, whichever of the four kinds it is. */
function stringAt(text: string, i: number, quote: string): Read {
  if (text.startsWith(quote.repeat(3), i))
    return quote === '"' ? multiLineBasic(text, i + 3) : multiLineLiteral(text, i + 3);
  return quote === '"' ? basicString(text, i + 1) : literalString(text, i + 1);
}

/** How many newlines `text` holds between `from` and `to`, looking at nothing past `to`. */
function newlinesIn(text: string, from: number, to: number): number {
  let count = 0;
  for (let at = from; at < to; at += 1) if (text.charCodeAt(at) === 0x0a) count += 1;
  return count;
}

const isBlank = (c: string): boolean => c === ' ' || c === '\t' || c === '\r';
const endsWord = (c: string): boolean =>
  isBlank(c) || c === '\n' || c === '#' || c === '"' || c === "'" || PUNCT.has(c);

/** The tokens of `text`, with the comments dropped. Throws on what it cannot follow. */
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let line = 1;
  for (let i = 0; i < text.length;) {
    const c = text[i] as string;
    if (isBlank(c)) i += 1;
    else if (c === '\n') {
      tokens.push({ t: 'nl', line });
      line += 1;
      i += 1;
    } else if (c === '#') {
      const end = text.indexOf('\n', i);
      i = end === -1 ? text.length : end;
    } else if (c === '"' || c === "'") {
      const read = stringAt(text, i, c);
      tokens.push({ t: 'str', v: read.v, line });
      line += newlinesIn(text, i, read.end);
      i = read.end;
    } else if (PUNCT.has(c)) {
      tokens.push({ t: 'punct', v: c, line, at: i });
      i += 1;
    } else {
      let end = i;
      while (end < text.length && !endsWord(text[end] as string)) end += 1;
      tokens.push({ t: 'word', v: text.slice(i, end), line });
      i = end;
    }
  }
  return tokens;
}

/** Sets an own property, so a key called `__proto__` is a key and nothing else. */
function setOwn(target: Obj, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

/** The object at `key` of `target`, made when it is not one: TOML's tables, leniently. */
function child(target: Obj, key: string): Obj {
  const existing = Object.hasOwn(target, key) ? target[key] : undefined;
  if (Array.isArray(existing)) {
    const last: unknown = existing[existing.length - 1];
    if (isPlainObject(last)) return last;
  }
  if (isPlainObject(existing)) return existing;
  const made: Obj = {};
  setOwn(target, key, made);
  return made;
}

class Parser {
  private i = 0;
  /** The line each key was set on, by the table it was set in. */
  readonly lines = new WeakMap<Obj, Map<string, number>>();
  constructor(private readonly tokens: readonly Token[]) {}

  private noteLine(table: Obj, key: string, line: number): void {
    const known = this.lines.get(table) ?? new Map<string, number>();
    known.set(key, line);
    this.lines.set(table, known);
  }

  private peek(): Token | undefined {
    return this.tokens[this.i];
  }
  private isPunct(v: string): boolean {
    const t = this.peek();
    return t !== undefined && t.t === 'punct' && t.v === v;
  }
  private expectPunct(v: string): void {
    if (!this.isPunct(v)) throw new Unreadable(`expected ${v}`);
    this.i += 1;
  }
  private skipNewlines(): void {
    while (this.peek()?.t === 'nl') this.i += 1;
  }
  private endOfStatement(): void {
    const t = this.peek();
    if (t !== undefined && t.t !== 'nl') throw new Unreadable('more after a value');
  }

  /** `a.b."c d"`: the parts of a dotted key. */
  key(): string[] {
    const parts: string[] = [];
    for (;;) {
      const t = this.peek();
      if (t === undefined || (t.t !== 'str' && t.t !== 'word')) throw new Unreadable('key');
      parts.push(t.v);
      this.i += 1;
      if (!this.isPunct('.')) return parts;
      this.i += 1;
    }
  }

  value(depth: number): unknown {
    if (depth > MAX_DEPTH) throw new Unreadable('nested too deep');
    const t = this.peek();
    if (t === undefined) throw new Unreadable('value');
    if (t.t === 'str' || t.t === 'word') {
      this.i += 1;
      // A scalar such as `1.5` or a date is several words to this tokenizer; its text is kept.
      let text = t.v;
      while (t.t === 'word' && this.isPunct('.') && this.tokens[this.i + 1]?.t === 'word') {
        text += `.${(this.tokens[this.i + 1] as { v: string }).v}`;
        this.i += 2;
      }
      return text;
    }
    if (this.isPunct('[')) return this.array(depth);
    if (this.isPunct('{')) return this.inlineTable(depth);
    throw new Unreadable('value');
  }

  private array(depth: number): unknown[] {
    this.expectPunct('[');
    const items: unknown[] = [];
    for (;;) {
      this.skipNewlines();
      if (this.isPunct(']')) break;
      items.push(this.value(depth + 1));
      this.skipNewlines();
      if (this.isPunct(',')) this.i += 1;
      else if (!this.isPunct(']')) throw new Unreadable('array');
    }
    this.i += 1;
    return items;
  }

  private inlineTable(depth: number): Obj {
    this.expectPunct('{');
    const table: Obj = {};
    for (;;) {
      this.skipNewlines();
      if (this.isPunct('}')) break;
      this.assign(table, depth + 1);
      this.skipNewlines();
      if (this.isPunct(',')) this.i += 1;
      else if (!this.isPunct('}')) throw new Unreadable('inline table');
    }
    this.i += 1;
    return table;
  }

  /** `key = value` into `table`, the dotted parts of the key making the tables on the way. */
  assign(table: Obj, depth: number): void {
    const line = this.peek()?.line ?? 1;
    const parts = this.key();
    this.expectPunct('=');
    const value = this.value(depth);
    const last = parts.pop() as string;
    const target = parts.reduce(child, table);
    setOwn(target, last, value);
    this.noteLine(target, last, line);
  }

  /** `[a.b]` or `[[a.b]]`: the table the lines after it go into. */
  private header(root: Obj): Obj {
    this.expectPunct('[');
    const isArray = this.isPunct('[');
    if (isArray) this.i += 1;
    const parts = this.key();
    this.expectPunct(']');
    if (isArray) this.expectPunct(']');
    this.endOfStatement();
    if (!isArray) return parts.reduce(child, root);
    const last = parts.pop() as string;
    const parent = parts.reduce(child, root);
    const existing = Object.hasOwn(parent, last) ? parent[last] : undefined;
    const list = Array.isArray(existing) ? existing : [];
    if (list !== existing) setOwn(parent, last, list);
    const made: Obj = {};
    list.push(made);
    return made;
  }

  document(): Obj {
    const root: Obj = {};
    let table = root;
    for (;;) {
      this.skipNewlines();
      if (this.peek() === undefined) return root;
      if (this.isPunct('[')) table = this.header(root);
      else {
        this.assign(table, 0);
        this.endOfStatement();
      }
    }
  }
}

export interface Toml {
  readonly doc: Obj;
  /** The line (from 1) that `key` of `table` was set on, when the text set it with `=`. */
  readonly keyLine: (table: Obj, key: string) => number | undefined;
}

/** The text as an object, or undefined when it uses something this reader does not follow. */
export function parseToml(text: string): Toml | undefined {
  try {
    const parser = new Parser(tokenize(text));
    const doc = parser.document();
    return { doc, keyLine: (table, key) => parser.lines.get(table)?.get(key) };
  } catch (err) {
    if (err instanceof Unreadable || err instanceof RangeError) return undefined;
    throw err;
  }
}
