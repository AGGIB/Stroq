// The identifiers that are a concern wherever they stand (see the end of `code-loading-registry.ts`).
//
// `module`, `process`, `globalThis`, `global`, `Reflect`, `Proxy` and `import.meta` are looked at as names and not as
// shapes: an occurrence that is not one of the harmless forms of its name is a concern, however it is reached
// (a member, a computed name, a pattern, a variable, a value handed on). So are the members `eval`, `Function`,
// `constructor` and `__proto__` of anything. The harmless forms are the list in the registry and a few places where the
// name is not a use of the object at all: a comparison, `typeof`, an assignment to it, a key, the name of a parameter.
//
// The token after a name is what tells, and the token after that for a member, so a name waits for them. A name that
// looks like an argument (`f(a, module)`) is held until its bracket closes, because `function (exports, module) {` is
// a parameter and not a use, and a parameter list is told by what follows its `)`: `{` or `=>`.
import { cookString, type Token } from './js-lexer.js';
import {
  HARMLESS_MEMBERS,
  isLiteralValue,
  opensLiteral,
  WATCHED_MEMBERS,
} from './code-loading-registry.js';
import type { Finding } from './code-loading.js';

const isPunct = (token: Token | null, text: string): boolean =>
  token?.kind === 'punct' && token.text === text;
const isMember = (token: Token | null): boolean => isPunct(token, '.') || isPunct(token, '?.');
/**
 * Operators are single characters to the lexer (`===` is three tokens, `||` two): these start one that goes on with
 * the name as an operand or compares it, and so is no use of the object.
 */
const OPERATORS: ReadonlySet<string> = new Set(['=', '!', '|', '&', '?', '=>']);

/** The names that are watched when they stand alone, not as the member of something. */
const STANDALONE: ReadonlySet<string> = new Set(['module', 'process', 'globalThis', 'global']);
/** The names of the global object: a member of it is harmless, and `.process` of it is `process`. */
const GLOBAL_OBJECT: ReadonlySet<string> = new Set(['globalThis', 'global']);
/** Between these a name is chosen and not used: `typeof globalThis !== 'undefined' ? globalThis : global || self`. */
const CHOICE: ReadonlySet<string> = new Set(['?', ':', '|', '&']);
/** Words before a name that ask about it and do not use it. */
const ASKS: ReadonlySet<string> = new Set(['typeof', 'in', 'instanceof', 'break', 'continue']);
/** The deepest bracket nesting that holds a name back until the bracket closes. */
const GROUPS_MAX = 512;

type Stage =
  /** The token after a name decides: `.` and `[` go on; `=>`, `=`, a comparison, a key or an argument are no use. */
  | {
      readonly stage: 'next';
      readonly name: string;
      readonly at: number;
      readonly before: Token | null;
    }
  /** `NAME.`: the member that follows is harmless or it is not. */
  | { readonly stage: 'member'; readonly name: string; readonly at: number }
  /** `NAME[`: a string that is a harmless member, or it is a name this reading does not follow. */
  | { readonly stage: 'bracket'; readonly name: string; readonly at: number }
  | { readonly stage: 'bracket-end'; readonly name: string; readonly at: number }
  /** After `NAME:` in braces: a value that is written out gives the key a value; a name is the target of a pattern. */
  | { readonly stage: 'key-target'; readonly name: string; readonly at: number }
  /** `x.__proto__`: set (`d.__proto__ = b`) it only changes the prototype; read, it leads to `.constructor`. */
  | { readonly stage: 'proto'; readonly at: number; readonly deleted: boolean };

const flagged = (reason: string, at: number): Finding => ({
  concern: 'dynamic-code',
  reason,
  at,
});

interface Group {
  readonly held: Held[];
  readonly head: boolean;
}

/** Words whose bracket is a head and not a parameter list: what stands in it is used, and `{` after it is a block. */
const HEADS: ReadonlySet<string> = new Set(['if', 'while', 'for', 'switch', 'with']);

/** A name that looks like an argument, held back with its finding: if the bracket is a parameter list it is a parameter. */
interface Held {
  readonly name: string;
  readonly finding: Finding;
}

export class Occurrences {
  private prev: Token | null = null;
  private prev2: Token | null = null;
  private prev3: Token | null = null;
  private stage: Stage | null = null;
  /**
   * The names held back in each open bracket, until it is known whether the bracket was a parameter list. A head
   * (`if (...)`, `while (...)`, `with (...)`, a class heritage) is never one, whatever follows it.
   */
  private readonly groups: Group[] = [];
  private heritage = false;
  private overflow = 0;
  /** What the bracket that closed last held back, until the token after it shows what the bracket was. */
  private closed: Held[] = [];
  private closedHead = false;
  /** The parameters of the function whose body opens with the next brace, and of an arrow that may open one. */
  private shadow: ReadonlySet<string> | null = null;
  private arrow: ReadonlySet<string> | null = null;
  /** For each open brace, the parameters it shadows: inside a function a parameter called `module` is not Node's. */
  private readonly braces: (ReadonlySet<string> | null)[] = [];
  /** For each open brace, whether it is an object written out as a value (`x = { ... }`), whose keys bind nothing. */
  private readonly literals: boolean[] = [];
  private braceOverflow = 0;
  /** `?` that wait for their `:`, and whether the last colon was one of them (a choice) or a key. */
  private ternary = 0;
  private colonChooses = false;

  /** Reads the next token, in order. */
  see(token: Token): Finding[] {
    const out: Finding[] = [];
    this.settleGroup(token, out);
    this.resolve(token, out);
    this.start(token, out);
    this.prev3 = this.prev2;
    this.prev2 = this.prev;
    this.prev = token;
    return out;
  }

  /** The text ended: what was waiting for a token is a use. */
  end(): Finding[] {
    const out = this.closed.map((held) => held.finding);
    this.closed = [];
    const stage = this.stage;
    this.stage = null;
    if (stage !== null && !(stage.stage === 'proto' && stage.deleted)) {
      const name = stage.stage === 'proto' ? '.__proto__' : stage.name;
      out.push(flagged(`uses ${name} in a way this reading does not follow`, stage.at));
    }
    return out;
  }

  /**
   * A bracket that closed held back some names: a parameter list lets them go (and they are the function's own inside
   * its braces), anything else says they were uses.
   */
  private settleGroup(token: Token, out: Finding[]): void {
    const arrow = this.arrow;
    this.arrow = null;
    const held = this.closed;
    const head = this.closedHead;
    this.closed = [];
    this.closedHead = false;
    this.shadow = isPunct(token, '{') ? arrow : null;
    if (held.length === 0) return;
    const names = new Set(held.map((one) => one.name));
    if (head) out.push(...held.map((one) => one.finding));
    else if (isPunct(token, '{')) this.shadow = new Set([...(this.shadow ?? []), ...names]);
    else if (isPunct(token, '=>')) this.arrow = names;
    else out.push(...held.map((one) => one.finding));
  }

  /** Whether the innermost open brace is an object written out as a value (a deeper nesting is not trusted). */
  private inLiteral(): boolean {
    return this.braceOverflow === 0 && this.literals.at(-1) === true;
  }

  private shadowed(name: string): boolean {
    return this.braces.some((names) => names?.has(name) === true);
  }

  private resolve(token: Token, out: Finding[]): void {
    const stage = this.stage;
    this.stage = null;
    if (stage === null) return;
    switch (stage.stage) {
      case 'next':
        this.next(stage, token, out);
        return;
      case 'member': {
        if (GLOBAL_OBJECT.has(stage.name) && token.kind === 'word') {
          // `globalThis.process` is process; any other member of the global object is read where it is named.
          if (token.text === 'process')
            this.stage = { stage: 'next', name: 'process', at: stage.at, before: null };
          return;
        }
        const harmless = HARMLESS_MEMBERS.get(stage.name);
        if (token.kind === 'word' && harmless?.has(token.text) === true) return;
        const member = token.kind === 'word' ? `.${token.text}` : '';
        out.push(
          flagged(`reaches ${stage.name}${member}, which this reading does not follow`, stage.at),
        );
        return;
      }
      case 'bracket': {
        const harmless = HARMLESS_MEMBERS.get(stage.name);
        const value =
          token.kind === 'string'
            ? token.escaped === true
              ? cookString(token.text)
              : token.text
            : null;
        if (value !== null && harmless?.has(value) === true) {
          this.stage = { stage: 'bracket-end', name: stage.name, at: stage.at };
          return;
        }
        out.push(
          flagged(
            `reaches a member of ${stage.name} by a name this reading does not follow`,
            stage.at,
          ),
        );
        return;
      }
      case 'key-target':
        if (!isLiteralValue(token) && !this.inLiteral())
          out.push(
            flagged(
              `${stage.name} is taken into a variable by a pattern, which this reading does not follow`,
              stage.at,
            ),
          );
        return;
      case 'proto':
        // Set, compared or deleted (`delete o.__proto__` is how a library keeps the prototype out), it leads nowhere.
        if (!(token.kind === 'punct' && OPERATORS.has(token.text)) && !stage.deleted)
          out.push(flagged('reads .__proto__, which this reading does not follow', stage.at));
        return;
      case 'bracket-end':
        if (!isPunct(token, ']'))
          out.push(
            flagged(`reaches a member of ${stage.name} by a name made at run time`, stage.at),
          );
        return;
    }
  }

  /** The token after a name that stands alone. */
  private next(stage: Extract<Stage, { stage: 'next' }>, token: Token, out: Finding[]): void {
    const { name, at, before } = stage;
    if (isMember(token)) {
      this.stage = { stage: 'member', name, at };
      return;
    }
    if (isPunct(token, '[')) {
      this.stage = { stage: 'bracket', name, at };
      return;
    }
    // Places where the name is not a use of the object it names: a parameter, an assignment, a comparison, a function
    // or a method with that name.
    if (isPunct(token, '=>')) {
      // `module => module.exports`: the name is the one parameter, and is the function's own in its braces.
      this.arrow = new Set([name]);
      return;
    }
    if (token.kind === 'punct' && OPERATORS.has(token.text)) return;
    if (isPunct(token, '(')) return;
    // A key (`{ process: 1 }`), whose value decides whether it is a name or the source of a pattern's target, or a label
    // at the start of a statement (`process: for (;;) {}`).
    if (isPunct(token, ':')) {
      if (isPunct(before, '{') || isPunct(before, ',')) {
        this.stage = { stage: 'key-target', name, at };
        return;
      }
      if (before === null || isPunct(before, ';') || isPunct(before, '}')) return;
    }
    const finding = flagged(`passes ${name} on as a value, which this reading does not follow`, at);
    const argumentLike = isPunct(before, '(') || isPunct(before, ',');
    // Brackets deeper than `GROUPS_MAX` are counted and not kept: a name in one cannot be held until its bracket closes,
    // so it is a use at once.
    const group = this.overflow === 0 ? this.groups.at(-1) : undefined;
    if (argumentLike && (isPunct(token, ',') || isPunct(token, ')')) && group !== undefined) {
      group.held.push({ name, finding });
      return;
    }
    out.push(finding);
  }

  /** The braces, for the parameters a function shadows; and the `?` and `:` of a choice, told from the key of an object. */
  private punctuation(token: Token): void {
    if (isPunct(token, '{') || isPunct(token, '${')) {
      this.heritage = false;
      if (this.braces.length < GROUPS_MAX && this.braceOverflow === 0) {
        this.braces.push(this.shadow);
        // `prev` is still the token before the brace here.
        this.literals.push(isPunct(token, '{') && opensLiteral(this.prev, this.inLiteral()));
      } else this.braceOverflow += 1;
    } else if (isPunct(token, '}')) {
      if (this.braceOverflow > 0) this.braceOverflow -= 1;
      else {
        this.braces.pop();
        this.literals.pop();
      }
    } else if (isPunct(token, '?')) {
      // `??` is two of them and is no choice.
      if (isPunct(this.prev, '?')) this.ternary = Math.max(0, this.ternary - 1);
      else this.ternary += 1;
    } else if (isPunct(token, ':')) {
      this.colonChooses = this.ternary > 0;
      if (this.colonChooses) this.ternary -= 1;
    }
  }

  private start(token: Token, out: Finding[]): void {
    this.punctuation(token);
    if (isPunct(token, '(')) {
      const head = this.heritage || (this.prev?.kind === 'word' && HEADS.has(this.prev.text));
      if (this.groups.length < GROUPS_MAX) this.groups.push({ held: [], head });
      else this.overflow += 1;
      return;
    }
    if (isPunct(token, ')')) {
      if (this.overflow > 0) this.overflow -= 1;
      else {
        const group = this.groups.pop();
        this.closed = group?.held ?? [];
        this.closedHead = group?.head ?? false;
      }
      return;
    }
    if (token.kind !== 'word') return;
    const name = token.text;
    if (name === 'extends') this.heritage = true;
    if (isMember(this.prev)) {
      if (name === 'meta' && this.prev2?.kind === 'word' && this.prev2.text === 'import')
        this.stage = { stage: 'next', name: 'import.meta', at: token.at, before: null };
      else if (name === '__proto__')
        this.stage = {
          stage: 'proto',
          at: token.at,
          deleted: this.prev3?.kind === 'word' && this.prev3.text === 'delete',
        };
      else if (WATCHED_MEMBERS.has(name))
        out.push(flagged(`uses .${name}, which this reading does not follow`, token.at));
      return;
    }
    if (!STANDALONE.has(name) || this.shadowed(name)) return;
    // `import process from 'node:process'` and `import * as process` declare the name; its uses are read as they come.
    if (this.prev?.kind === 'word' && (this.prev.text === 'import' || this.prev.text === 'as'))
      return;
    // `typeof process`, `'env' in process` and `x === module` ask about the name and do not use it.
    if (this.prev?.kind === 'word' && ASKS.has(this.prev.text)) return;
    // `const { env } = process`: the names taken out are looked at where the pattern is read.
    if (isPunct(this.prev, '=') && isPunct(this.prev2, '}')) return;
    if (isPunct(this.prev, '=') && (isPunct(this.prev2, '=') || isPunct(this.prev2, '!'))) return;
    // A name that is chosen between others is not yet used: it is the variable it is given to that is.
    // After a `:` it is a choice only in a ternary; `{ p: process }` is a value given to a key.
    if (this.prev?.kind === 'punct' && CHOICE.has(this.prev.text) && name !== 'module') {
      if (this.prev.text !== ':' || this.colonChooses) return;
    }
    // A function or a class declared with the name is not the object.
    if (this.prev?.kind === 'word' && (this.prev.text === 'function' || this.prev.text === 'class'))
      return;
    this.stage = {
      stage: 'next',
      name,
      at: token.at,
      before: this.prev,
    };
  }
}
