/**
 * Random regular expressions with a way to write a text each one matches, for testing the
 * requirements reader against an oracle that shares none of its code: the generator builds the
 * pattern from a tree it holds, so it knows what the pattern matches without reading the pattern.
 */

type LiteralForm = 'plain' | 'hex' | 'unicode' | 'braced' | 'control' | 'raw';

export type Node =
  | { readonly t: 'lit'; readonly ch: string; readonly form: LiteralForm }
  | { readonly t: 'class'; readonly chars: readonly string[] }
  | { readonly t: 'any' }
  | { readonly t: 'escape'; readonly kind: 'd' | 's' | 'w' }
  | { readonly t: 'look' }
  | { readonly t: 'group'; readonly capture: boolean; readonly body: Node }
  | { readonly t: 'alt'; readonly branches: readonly Node[] }
  | { readonly t: 'seq'; readonly items: readonly Node[] }
  | {
      readonly t: 'rep';
      readonly item: Node;
      readonly min: number;
      readonly max: number | null;
      readonly lazy: boolean;
    };

/** A small seeded generator (mulberry32), so a failing seed names a failing pattern. */
export class Random {
  constructor(private state: number) {}

  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  below(limit: number): number {
    return Math.floor(this.next() * limit);
  }

  pick<T>(items: readonly T[]): T {
    return items[this.below(items.length)] as T;
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }
}

const ASCII = [
  ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 \t_-:;,<>=@#%&"\'~!/',
];
const SYNTAX = [...'.*+?()[]{}|^$\\'];
const NON_ASCII = [
  'é',
  'É',
  'ß',
  'ẞ',
  'ſ',
  'K',
  'σ',
  'ς',
  'Σ',
  'И',
  'и',
  'ǅ',
  'İ',
  'ı',
  'µ',
  'μ',
  '​',
  '中',
  'Å',
  'å',
];
const ASTRAL = ['\u{10400}', '\u{10428}', '\u{1F600}', '\u{1F512}', '\u{E0020}'];

export interface Kind {
  readonly unicode: boolean;
  readonly ignoreCase: boolean;
}

function literal(random: Random, kind: Kind): Node {
  const roll = random.next();
  const ch =
    roll < 0.55
      ? random.pick(ASCII)
      : roll < 0.65
        ? random.pick(SYNTAX)
        : roll < 0.9
          ? random.pick(NON_ASCII)
          : random.pick(ASTRAL);
  const code = ch.codePointAt(0) ?? 0;
  const forms: LiteralForm[] = ['plain', 'plain'];
  if (code < 0x100) forms.push('hex');
  if (ch === '\t') forms.push('control', 'control');
  // Without `u`, a bracket or brace that closes nothing is only text (Annex B).
  if (!kind.unicode && (ch === ']' || ch === '}')) forms.push('raw', 'raw');
  if (code < 0x10000) forms.push('unicode');
  if (kind.unicode) forms.push('braced');
  return { t: 'lit', ch, form: random.pick(forms) };
}

export function randomNode(random: Random, kind: Kind, depth: number): Node {
  const roll = random.next();
  if (depth <= 0 || roll < 0.38) return literal(random, kind);
  if (roll < 0.46)
    return { t: 'class', chars: [random.pick(ASCII), random.pick(ASCII), random.pick(NON_ASCII)] };
  if (roll < 0.5) return { t: 'any' };
  if (roll < 0.54) return { t: 'escape', kind: random.pick(['d', 's', 'w'] as const) };
  if (roll < 0.56) return { t: 'look' };
  if (roll < 0.68)
    return { t: 'group', capture: random.chance(0.5), body: randomNode(random, kind, depth - 1) };
  if (roll < 0.78)
    return {
      t: 'alt',
      branches: Array.from({ length: 2 + random.below(3) }, () =>
        randomNode(random, kind, depth - 1),
      ),
    };
  if (roll < 0.9)
    return {
      t: 'seq',
      items: Array.from({ length: 2 + random.below(4) }, () => randomNode(random, kind, depth - 1)),
    };
  const item = atomic(randomNode(random, kind, depth - 1));
  const min = random.pick([0, 0, 1, 1, 2]);
  const max = random.pick([null, min, min + 1, min + 3]);
  return { t: 'rep', item, min, max, lazy: random.chance(0.3) };
}

/** A node a quantifier can follow without changing what it binds to: anything else is grouped. */
function atomic(node: Node): Node {
  return node.t === 'seq' || node.t === 'alt' || node.t === 'rep' || node.t === 'look'
    ? { t: 'group', capture: false, body: node }
    : node;
}

const escapeChar = (ch: string): string => (SYNTAX.includes(ch) || ch === '/' ? `\\${ch}` : ch);
const hex = (code: number, width: number): string => code.toString(16).padStart(width, '0');

function renderLiteral(node: Extract<Node, { t: 'lit' }>, kind: Kind): string {
  const code = node.ch.codePointAt(0) ?? 0;
  if (node.form === 'hex' && code < 0x100) return `\\x${hex(code, 2)}`;
  if (node.form === 'unicode' && code < 0x10000) return `\\u${hex(code, 4)}`;
  if (node.form === 'braced' && kind.unicode) return `\\u{${hex(code, 1)}}`;
  if (node.form === 'control') return '\\t';
  if (node.form === 'raw') return node.ch;
  return escapeChar(node.ch);
}

function renderClass(chars: readonly string[]): string {
  const body = chars.map((ch) => (/[\]\\^-]/.test(ch) ? `\\${ch}` : ch)).join('');
  return `[${body}]`;
}

export function render(node: Node, kind: Kind): string {
  switch (node.t) {
    case 'lit':
      return renderLiteral(node, kind);
    case 'class':
      return renderClass(node.chars);
    case 'any':
      return '.';
    case 'escape':
      return `\\${node.kind}`;
    case 'look':
      return '(?!\\uffff)';
    case 'group':
      return `(${node.capture ? '' : '?:'}${render(node.body, kind)})`;
    case 'alt':
      return node.branches.map((branch) => render(branch, kind)).join('|');
    case 'seq':
      return node.items.map((item) => render(item, kind)).join('');
    case 'rep': {
      const base = render(node.item, kind);
      const quantifier =
        node.max === null
          ? node.min === 0
            ? '*'
            : node.min === 1
              ? '+'
              : `{${node.min},}`
          : node.min === 0 && node.max === 1
            ? '?'
            : node.min === node.max
              ? `{${node.min}}`
              : `{${node.min},${node.max}}`;
      return `${base}${quantifier}${node.lazy ? '?' : ''}`;
    }
  }
}

/** Without `u` a quantifier after an astral literal binds to its low half only. */
const bindsToLowHalf = (node: Node, kind: Kind): boolean =>
  !kind.unicode && node.t === 'lit' && node.ch.length === 2;

/** A text the node matches, on its own, with no regard for flags. */
export function sample(node: Node, random: Random, kind: Kind): string {
  switch (node.t) {
    case 'lit':
      return node.ch;
    case 'class':
      return random.pick(node.chars);
    case 'any':
      return random.pick(['x', '7', 'é']);
    case 'escape':
      return node.kind === 'd'
        ? '4'
        : node.kind === 's'
          ? random.pick([' ', '\t'])
          : random.pick(['q', '_', '8']);
    case 'look':
      return '';
    case 'group':
      return sample(node.body, random, kind);
    case 'alt':
      return sample(random.pick(node.branches), random, kind);
    case 'seq':
      return node.items.map((item) => sample(item, random, kind)).join('');
    case 'rep': {
      const count = node.min + random.below((node.max ?? node.min + 3) - node.min + 1);
      if (bindsToLowHalf(node.item, kind)) {
        const pair = sample(node.item, random, kind);
        return count === 0 ? pair.slice(0, 1) : pair.slice(0, 1) + pair.slice(1).repeat(count);
      }
      return Array.from({ length: count }, () => sample(node.item, random, kind)).join('');
    }
  }
}
