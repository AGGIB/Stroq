import { isPlainObject } from '../commands/config-file.js';
import { hookEntries, MAX_HOOKS } from './agent-json.js';
import { digestOf, hit, type AgentHit } from './agent-kinds.js';
import { mcpServerRunsCode } from '@stroq/core';
import { lineOf } from './jsonc.js';

/**
 * Codex's `config.toml`, read for what it runs: `[mcp_servers.*]`, hooks written as tables or
 * inline, and `notify`. There is no TOML library in Stroq and none is added for this, so the
 * file is read by a small tokenizer and a lenient table builder that know the parts of TOML a
 * config like this uses: tables and arrays of tables, dotted and quoted keys, one-line strings,
 * arrays across lines and inline tables. Anything else (a multi-line string, a line it cannot
 * follow) makes the whole file unreadable, and an unreadable file that names a command is
 * reported as such rather than passed.
 */

type Obj = Record<string, unknown>;

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

/** A basic string's body from `start` (after the quote): the text and where it ends. */
function basicString(text: string, start: number): { v: string; end: number } {
  let out = '';
  for (let i = start; i < text.length; i += 1) {
    const c = text[i] as string;
    if (c === '"') return { v: out, end: i + 1 };
    if (c === '\n') break;
    if (c !== '\\') {
      out += c;
      continue;
    }
    const e = text[i + 1] ?? '';
    const width = e === 'u' ? 4 : e === 'U' ? 8 : 0;
    if (width > 0) {
      const hex = text.slice(i + 2, i + 2 + width);
      if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== width) break;
      out += String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff));
      i += 1 + width;
    } else if (ESCAPES[e] !== undefined) {
      out += ESCAPES[e];
      i += 1;
    } else break;
  }
  throw new Unreadable('string');
}

function literalString(text: string, start: number): { v: string; end: number } {
  const close = text.indexOf("'", start);
  const newline = text.indexOf('\n', start);
  if (close === -1 || (newline !== -1 && newline < close)) throw new Unreadable('string');
  return { v: text.slice(start, close), end: close + 1 };
}

const isBlank = (c: string): boolean => c === ' ' || c === '\t' || c === '\r';
const endsWord = (c: string): boolean =>
  isBlank(c) || c === '\n' || c === '#' || c === '"' || c === "'" || PUNCT.has(c);

/** The tokens of `text`, with the comments dropped. Throws on a multi-line string. */
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
      if (text.startsWith(c.repeat(3), i)) throw new Unreadable('multi-line string');
      const read = c === '"' ? basicString(text, i + 1) : literalString(text, i + 1);
      tokens.push({ t: 'str', v: read.v, line });
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
  constructor(private readonly tokens: readonly Token[]) {}

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
    const parts = this.key();
    this.expectPunct('=');
    const value = this.value(depth);
    const last = parts.pop() as string;
    setOwn(parts.reduce(child, table), last, value);
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

/** The file as an object, or undefined when it uses something this reader does not follow. */
export function parseToml(text: string): Obj | undefined {
  try {
    return new Parser(tokenize(text)).document();
  } catch (err) {
    if (err instanceof Unreadable || err instanceof RangeError) return undefined;
    throw err;
  }
}

/** The text with its comments blanked, to find lines in without finding a commented-out entry. */
const withoutComments = (text: string): string =>
  text
    .split('\n')
    .map((line) => (/^\s*#/.test(line) ? '' : line))
    .join('\n');

const firstWord = (command: string): string => command.split(' ')[0] ?? command;

function serverHits(path: string, text: string, servers: unknown): AgentHit[] {
  if (!isPlainObject(servers)) return [];
  return Object.entries(servers).flatMap(([name, entry]): AgentHit[] => {
    if (!isPlainObject(entry)) return [];
    const command = Object.hasOwn(entry, 'command') ? entry['command'] : undefined;
    const url = Object.hasOwn(entry, 'url') ? entry['url'] : undefined;
    const args = Array.isArray(entry['args'])
      ? entry['args'].filter((a): a is string => typeof a === 'string')
      : [];
    if (typeof command === 'string') {
      const line = lineOf(text, ['mcp_servers', name, 'command']);
      const kind = mcpServerRunsCode(command, args) ? 'mcp-server-runs-code' : 'mcp-server';
      return [hit(kind, path, line, name, [command, ...args].join(' '))];
    }
    if (command !== undefined)
      return [hit('unreadable-config', path, 1, `mcp_servers.${name}`, JSON.stringify(command))];
    if (typeof url === 'string')
      return [hit('mcp-server', path, lineOf(text, ['mcp_servers', name, 'url']), name, url)];
    return [];
  });
}

function hookHitsOf(path: string, text: string, doc: Obj): AgentHit[] {
  const hits: AgentHit[] = [];
  const notify = Object.hasOwn(doc, 'notify') ? doc['notify'] : undefined;
  const notifyText = Array.isArray(notify) ? notify.filter((n) => typeof n === 'string') : [];
  if (notifyText.length > 0)
    hits.push(hit('agent-hook', path, lineOf(text, ['notify']), 'notify', notifyText.join(' ')));
  const hooks = Object.hasOwn(doc, 'hooks') ? doc['hooks'] : undefined;
  const { entries, cut } = hookEntries(hooks);
  for (const e of entries.slice(0, MAX_HOOKS)) {
    const line = lineOf(text, [...e.path, firstWord(e.command)]);
    hits.push(hit('agent-hook', path, line, e.event, e.command));
  }
  if (cut) hits.push(hit('unreadable-config', path, 1, 'too many hooks', `more than ${MAX_HOOKS}`));
  return hits;
}

/** The words that mean a file this reader could not follow may still run something. */
const RUN_WORDS = /\b(?:command|notify|mcp_servers|hooks)\b/;

export function codexConfig(path: string, text: string): AgentHit[] {
  const doc = parseToml(text);
  const clean = withoutComments(text);
  if (doc === undefined) {
    const mention = RUN_WORDS.exec(clean);
    if (mention === null) return [];
    return [
      hit('unreadable-config', path, lineOf(clean, [mention[0]]), 'unparsed', digestOf(text)),
    ];
  }
  return [
    ...serverHits(path, clean, Object.hasOwn(doc, 'mcp_servers') ? doc['mcp_servers'] : undefined),
    ...hookHitsOf(path, clean, doc),
  ];
}
