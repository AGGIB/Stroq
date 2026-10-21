import { foldName } from './git-dir-names.js';

/**
 * Names looked for inside a command line, as text and not as words: the file names and folder
 * names of what a change touched. A command names a file however it spells the rest of the path
 * (`$DIR/a.sh`, `"$(git rev-parse --show-toplevel)"/x`, `gu""ard.sh`), so every name is looked
 * for anywhere in the text, once quotes, backslashes and braces are taken out of both.
 *
 * All the names are looked for in one pass over a text (Aho-Corasick), so the work is linear in
 * the text and the names, however many there are.
 */

/** Quotes, backslashes and braces: a shell takes them out of a word, so they are no part of a name. */
const STRIP = /["'`\\{}]/g;
const ASCII = /^[\x00-\x7f]*$/;
/** Characters macOS ignores in a name, and marks that only accent a letter. */
const DROPPED = /[\p{Default_Ignorable_Code_Point}\p{M}]/gu;

/** A text as names are looked for in it: folded as the most forgiving disk folds a name, in lower case. */
export function normalText(text: string): string {
  const folded = ASCII.test(text)
    ? text.toLowerCase()
    : text.normalize('NFKD').replace(DROPPED, '').toUpperCase().toLowerCase().normalize('NFKC');
  return folded.replace(STRIP, '');
}

/** The longest name a disk holds is 255 units: a longer part of a path is never checked out. */
export const MAX_NAME_CHARS = 255;

/** A name of a path as it is looked for: its own and its folded spelling, quotes and braces out. */
export function nameForms(part: string): string[] {
  if (part.length > MAX_NAME_CHARS) return [];
  const forms = new Set([normalText(part), normalText(foldName(part))]);
  forms.delete('');
  return [...forms];
}

/** A name without its last extension: `guard` for `guard.sh`; a dot file keeps its name. */
export function stemOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/** Child nodes are keyed by `node * KEY + code unit`, in one map. */
const KEY = 0x10000;

/** Every name of a set, found in a text in one pass. */
export class NameMatcher {
  private readonly next = new Map<number, number>();
  private readonly edges: number[][] = [[]];
  private readonly out: number[] = [-1];
  private fail = new Int32Array(1);
  private dict = new Int32Array(1);
  private stamp = new Int32Array(1);
  private generation = 0;

  /** The names, by id: the id `add` gave each. */
  readonly names: string[] = [];
  private readonly ids = new Map<string, number>();
  /** The characters of every name added: the size of what was built. */
  size = 0;

  has(name: string): boolean {
    return this.ids.has(name);
  }

  /** The id of `name`, added to the set if it was not in it. Before `build` only. */
  add(name: string): number {
    const known = this.ids.get(name);
    if (known !== undefined) return known;
    const id = this.names.length;
    this.names.push(name);
    this.ids.set(name, id);
    this.size += name.length;
    let node = 0;
    for (let i = 0; i < name.length; i += 1) {
      const key = node * KEY + name.charCodeAt(i);
      let child = this.next.get(key);
      if (child === undefined) {
        child = this.out.length;
        this.out.push(-1);
        this.edges.push([]);
        this.next.set(key, child);
        (this.edges[node] as number[]).push(name.charCodeAt(i), child);
      }
      node = child;
    }
    this.out[node] = id;
    return id;
  }

  /** Links each node to the longest name that ends where it does. After the last `add`. */
  build(): void {
    const count = this.out.length;
    this.fail = new Int32Array(count);
    this.dict = new Int32Array(count).fill(-1);
    this.stamp = new Int32Array(count);
    const queue: number[] = [];
    const root = this.edges[0] as number[];
    for (let e = 1; e < root.length; e += 2) queue.push(root[e] as number);
    for (let head = 0; head < queue.length; head += 1) {
      const node = queue[head] as number;
      const edges = this.edges[node] as number[];
      for (let e = 0; e < edges.length; e += 2) {
        const code = edges[e] as number;
        const child = edges[e + 1] as number;
        let f = this.fail[node] as number;
        while (f > 0 && !this.next.has(f * KEY + code)) f = this.fail[f] as number;
        const to = this.next.get(f * KEY + code);
        const link = to !== undefined && to !== child ? to : 0;
        this.fail[child] = link;
        this.dict[child] = (this.out[link] as number) >= 0 ? link : (this.dict[link] as number);
        queue.push(child);
      }
    }
  }

  /** Calls `found` once with the id of each name that is in `text`; returns the work done. */
  scan(text: string, found: (id: number) => void): number {
    this.generation += 1;
    const generation = this.generation;
    let work = text.length;
    let node = 0;
    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(i);
      while (node > 0 && !this.next.has(node * KEY + code)) node = this.fail[node] as number;
      node = this.next.get(node * KEY + code) ?? 0;
      let at = (this.out[node] as number) >= 0 ? node : (this.dict[node] as number);
      while (at > 0 && this.stamp[at] !== generation) {
        this.stamp[at] = generation;
        work += 1;
        const id = this.out[at] as number;
        if (id >= 0) found(id);
        at = this.dict[at] as number;
      }
    }
    return work;
  }
}

/** The words of a command that are patterns: `*`, `?`, a brace list, a bracket in a path. */
const BRACE_LIST = /\{[^{}:]*(?:,|\.\.)[^{}:]*\}/;
const WILDCARD = /\*+|\?|\{[^{}:]*\}|\[[^[\]]*\]|\$\{[^{}]*\}|\$\([^()]*\)|\$[a-z_][a-z0-9_]*/;
export const isPattern = (word: string): boolean =>
  /[*?]/.test(word) || BRACE_LIST.test(word) || (word.includes('[') && /[./]/.test(word));

/** The literal parts of a pattern, in order, that a path it matches holds; empty when there are none. */
export const fragmentsOf = (word: string): string[] =>
  word
    .split(new RegExp(WILDCARD.source, 'g'))
    .map(normalText)
    .filter((part) => !/^[./]*$/.test(part));
