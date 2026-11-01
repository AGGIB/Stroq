/**
 * What a regular expression's source requires of any text it matches, as literal strings.
 *
 * `requiredLiterals(source, flags)` answers one question: is there a list of literals such that
 * every text this regex can match contains at least one of them? If there is, a text that holds
 * none of them cannot match, and the regex need not run. The answer is a necessary condition and
 * nothing more: a text that holds a literal may still not match.
 *
 * It has to be right for every input, so it is built to be wrong only in one direction. A literal
 * is reported only from a position the regex cannot match without:
 *
 * - a run of literal characters in a concatenation is one literal; a class, `.`, a class escape,
 *   an assertion (`^ $ \b \B`), a lookaround or an optional element ends the run;
 * - the elements of a concatenation each have a requirement, and any one of them is a requirement
 *   of the whole; the most selective one is kept;
 * - an alternation needs the union of its branches' requirements, and none if one branch needs none;
 * - a quantifier with a minimum of 0 needs nothing; a minimum of 1 or more keeps the requirement of
 *   its element, and a literal under it counts once and ends the run (`ab+c` needs `ab`, not `abc`).
 *
 * Whatever this parser is not certain of, it does not read: backreferences and octal escapes, `\c`,
 * `\k`, `\p`, named groups, modifier groups, an unknown escape, a lone surrogate under `u`, the `v`
 * flag, unbalanced input. Any of them gives `null`, which means no requirement, which is always
 * safe. The reading follows the syntax RegExp compiles (the Annex B grammar without `u`, the strict
 * one with it), including that without `u` a quantifier binds to a UTF-16 code unit, not to the
 * character it ends.
 *
 * Case is not this module's concern: the literals come back as written. See `case-fold.ts`.
 */

/** More literals than this cost more to look for than the regex costs to run. */
const MAX_LITERALS = 48;

/** One OR-list of literals, or null for no requirement. */
type Needs = readonly string[] | null;

type Atom = { readonly literal: string } | { readonly needs: Needs };

/** An atom that needs nothing and ends any run of literals around it. */
const OPAQUE: Atom = { needs: null };

class Unsupported extends Error {}

const QUANTIFIER = /^\{(\d+)(?:,(\d*))?\}/;
const HEX4 = /^[0-9a-fA-F]{4}$/;
const HEX2 = /^[0-9a-fA-F]{2}$/;
const CONTROL_ESCAPES: Readonly<Record<string, string>> = {
  t: '\t',
  n: '\n',
  v: '\v',
  f: '\f',
  r: '\r',
};
const LINE_TERMINATOR = /[\n\r\u2028\u2029]/;
const ALPHANUMERIC = /^[A-Za-z0-9]$/;

/** A cursor over the source: the one place this module moves, kept to this class. */
class Reader {
  private position = 0;

  constructor(
    private readonly source: string,
    readonly unicode: boolean,
  ) {}

  get done(): boolean {
    return this.position >= this.source.length;
  }

  /** The next character without taking it: a code point with `u`, a code unit without. */
  peek(): string | undefined {
    if (this.done) return undefined;
    if (!this.unicode) return this.source[this.position];
    return String.fromCodePoint(this.source.codePointAt(this.position) ?? 0);
  }

  next(): string {
    const char = this.peek();
    if (char === undefined) throw new Unsupported();
    this.position += char.length;
    return char;
  }

  eat(char: string): boolean {
    if (this.peek() !== char) return false;
    this.position += char.length;
    return true;
  }

  /** The next `count` code units, taken only if there are that many. */
  take(count: number): string | null {
    const piece = this.source.slice(this.position, this.position + count);
    if (piece.length < count) return null;
    this.position += count;
    return piece;
  }

  /** What follows, to the end; only for looking at, never for moving. */
  rest(): string {
    return this.source.slice(this.position);
  }

  skip(count: number): void {
    this.position += count;
  }
}

export function requiredLiterals(source: string, flags: string): readonly string[] | null {
  if (flags.includes('v')) return null;
  try {
    const reader = new Reader(source, flags.includes('u'));
    const needs = parseDisjunction(reader);
    // A `)` nobody opened stops the parse early; a regex that compiled cannot have one.
    return reader.done ? tidy(needs) : null;
  } catch {
    // `Unsupported`, and a stack overflow on absurd nesting: no requirement either way.
    return null;
  }
}

function parseDisjunction(reader: Reader): Needs {
  const branches: Needs[] = [parseAlternative(reader)];
  while (reader.eat('|')) branches.push(parseAlternative(reader));
  return unionOf(branches);
}

function parseAlternative(reader: Reader): Needs {
  const atoms: Atom[] = [];
  while (!reader.done && reader.peek() !== '|' && reader.peek() !== ')') {
    atoms.push(...parseTerm(reader));
  }
  return concatenate(atoms);
}

function parseTerm(reader: Reader): readonly Atom[] {
  const char = reader.next();
  switch (char) {
    case '^':
    case '$':
      return [OPAQUE];
    case '.':
      return quantified(reader, OPAQUE);
    case '(':
      return quantified(reader, { needs: parseGroup(reader) });
    case '[':
      skipClass(reader);
      return quantified(reader, OPAQUE);
    case '\\':
      return quantified(reader, parseEscape(reader));
    case '*':
    case '+':
    case '?':
      throw new Unsupported();
    case '{':
      // A well-formed quantifier with nothing to repeat does not compile; anything else is text.
      if (QUANTIFIER.test(`{${reader.rest()}`)) throw new Unsupported();
      return quantified(reader, literalAtom(char, reader));
    default:
      return quantified(reader, literalAtom(char, reader));
  }
}

function literalAtom(char: string, reader: Reader): Atom {
  const code = char.codePointAt(0) ?? 0;
  if (reader.unicode && code >= 0xd800 && code <= 0xdfff) throw new Unsupported();
  return { literal: char };
}

/** `atom` with the quantifier that follows it, if any, applied. */
function quantified(reader: Reader, atom: Atom): readonly Atom[] {
  const quantifier = readQuantifier(reader);
  if (quantifier === null) return [atom];
  if (quantifier.min === 0) return [OPAQUE];
  if (!('literal' in atom)) return [atom];
  // One copy must occur, but there may be more between it and what follows.
  return quantifier.once ? [atom] : [atom, OPAQUE];
}

interface Quantifier {
  readonly min: number;
  readonly once: boolean;
}

function readQuantifier(reader: Reader): Quantifier | null {
  const quantifier = quantifierAhead(reader);
  if (quantifier !== null) reader.eat('?');
  return quantifier;
}

function quantifierAhead(reader: Reader): Quantifier | null {
  if (reader.eat('*')) return { min: 0, once: false };
  if (reader.eat('+')) return { min: 1, once: false };
  if (reader.eat('?')) return { min: 0, once: false };
  if (reader.peek() !== '{') return null;
  const found = QUANTIFIER.exec(reader.rest());
  if (found === null) return null;
  reader.skip(found[0].length);
  const min = Number(found[1]);
  const max = found[2] === undefined ? min : found[2] === '' ? Infinity : Number(found[2]);
  return { min, once: min === 1 && max === 1 };
}

/** After `(`: the requirement of what is inside, and nothing for a lookaround. */
function parseGroup(reader: Reader): Needs {
  if (!reader.eat('?')) return closed(reader, parseDisjunction(reader));
  if (reader.eat(':')) return closed(reader, parseDisjunction(reader));
  const lookahead = reader.eat('=') || reader.eat('!');
  const lookbehind = !lookahead && reader.eat('<') && (reader.eat('=') || reader.eat('!'));
  if (!lookahead && !lookbehind) throw new Unsupported();
  closed(reader, parseDisjunction(reader));
  return null;
}

function closed(reader: Reader, needs: Needs): Needs {
  if (!reader.eat(')')) throw new Unsupported();
  return needs;
}

/** After `[`: past the closing `]`. What a class holds is never a requirement. */
function skipClass(reader: Reader): void {
  for (;;) {
    const char = reader.next();
    if (char === ']') return;
    if (char !== '\\') continue;
    // `\c` in a class has its own rules for what follows; not read.
    if (reader.next() === 'c') throw new Unsupported();
  }
}

/** After `\`: what the escape stands for. */
function parseEscape(reader: Reader): Atom {
  const char = reader.next();
  if ('dDwWsSbB'.includes(char)) return OPAQUE;
  const control = CONTROL_ESCAPES[char];
  if (control !== undefined) return { literal: control };
  if (char === '0') {
    // `\0` and a digit is an octal escape in the legacy grammar.
    if (/^[0-9]/.test(reader.rest())) throw new Unsupported();
    return { literal: '\0' };
  }
  if (char === 'x') return { literal: hexEscape(reader) };
  if (char === 'u') return { literal: unicodeEscape(reader) };
  // Digits are backreferences or octal; letters left are `\c \k \p \P` or the legacy identity
  // escape of a letter. None of them is worth a guess.
  if (ALPHANUMERIC.test(char) || LINE_TERMINATOR.test(char)) throw new Unsupported();
  return literalAtom(char, reader);
}

function hexEscape(reader: Reader): string {
  const digits = reader.take(2);
  if (digits === null || !HEX2.test(digits)) throw new Unsupported();
  return String.fromCharCode(parseInt(digits, 16));
}

function unicodeEscape(reader: Reader): string {
  if (reader.unicode && reader.eat('{')) return bracedEscape(reader);
  const unit = fourDigits(reader);
  const isHigh = unit >= 0xd800 && unit <= 0xdbff;
  if (!reader.unicode) return String.fromCharCode(unit);
  if (isHigh && reader.rest().startsWith('\\u')) {
    const low = followingLowSurrogate(reader);
    if (low !== null) return String.fromCharCode(unit, low);
  }
  if (unit >= 0xd800 && unit <= 0xdfff) throw new Unsupported();
  return String.fromCharCode(unit);
}

function fourDigits(reader: Reader): number {
  const digits = reader.take(4);
  if (digits === null || !HEX4.test(digits)) throw new Unsupported();
  return parseInt(digits, 16);
}

/** `\uDC00`-`\uDFFF` right after a high surrogate, taken if it is one; otherwise left alone. */
function followingLowSurrogate(reader: Reader): number | null {
  const found = /^\\u([dD][c-fC-F][0-9a-fA-F]{2})/.exec(reader.rest());
  if (found === null) return null;
  reader.skip(found[0].length);
  return parseInt(found[1] ?? '', 16);
}

function bracedEscape(reader: Reader): string {
  const found = /^([0-9a-fA-F]+)\}/.exec(reader.rest());
  if (found === null) throw new Unsupported();
  reader.skip(found[0].length);
  const code = parseInt(found[1] ?? '', 16);
  if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) throw new Unsupported();
  return String.fromCodePoint(code);
}

/** The requirement of a concatenation: the best of its runs of literals and its elements' own. */
function concatenate(atoms: readonly Atom[]): Needs {
  const candidates: (readonly string[])[] = [];
  let run = '';
  const endRun = (): void => {
    if (run !== '') candidates.push([run]);
    run = '';
  };
  for (const atom of atoms) {
    if ('literal' in atom) {
      run += atom.literal;
      continue;
    }
    endRun();
    if (atom.needs !== null) candidates.push(atom.needs);
  }
  endRun();
  return mostSelective(candidates);
}

const shortest = (literals: readonly string[]): number =>
  literals.reduce((least, literal) => Math.min(least, literal.length), Infinity);

/** Longer literals first, then fewer of them, then the earlier one. */
function mostSelective(candidates: readonly (readonly string[])[]): Needs {
  let best: readonly string[] | null = null;
  for (const candidate of candidates) {
    if (best === null) best = candidate;
    else if (shortest(candidate) > shortest(best)) best = candidate;
    else if (shortest(candidate) === shortest(best) && candidate.length < best.length)
      best = candidate;
  }
  return best;
}

function unionOf(branches: readonly Needs[]): Needs {
  if (branches.length === 1) return branches[0] ?? null;
  const union = new Set<string>();
  for (const branch of branches) {
    if (branch === null) return null;
    for (const literal of branch) union.add(literal);
  }
  return union.size > MAX_LITERALS ? null : [...union];
}

/** Without duplicates, and without a literal that another one of the list already implies. */
function tidy(needs: Needs): readonly string[] | null {
  if (needs === null) return null;
  const unique = [...new Set(needs)];
  const kept = unique.filter(
    (literal) => !unique.some((other) => other !== literal && literal.includes(other)),
  );
  return kept.length === 0 || kept.length > MAX_LITERALS ? null : kept;
}
