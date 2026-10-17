// The ways a JavaScript file can load or build code without writing the name of a module.
//
// `require('x')` and `import 'x'` show what they load. These do not: `createRequire(import.meta.url)('x')`,
// `module['require'](name)`, `process.binding`, `eval(text)`, `new Function(text)`, `globalThis.Function`,
// `x.constructor.constructor(text)`, `process.execPath` (a node that is started with `-e`). Each of them is a
// reason to say that what the file loads is not known, which is a concern like a doubt of the lexer.
//
// It is a watch over the tokens, one at a time and in order, with the three before each. A rule that has to see
// the token after (`Function` followed by `.` is `Function.prototype`; followed by anything else it is the
// constructor used as a value) waits for it. Best-effort: a name that is built from pieces is not seen.
import type { Token } from './js-lexer.js';

/** What a reading could not settle. */
export type Concern =
  /** The text could not be lexed with certainty, or has more than the reading takes. */
  | 'doubt'
  /** A module is requested by a name built at run time, or `require` is used as a value. */
  | 'computed'
  /** Code is loaded or built in a way that has no module name in the text. */
  | 'dynamic-code'
  /** A module name is written with escapes, so the text is not the name. */
  | 'escaped';

export interface Finding {
  readonly concern: Concern;
  /** In words, for a person: what the file does that cannot be read. */
  readonly reason: string;
  readonly at: number;
}

/** Names that lead to code loaded without a module name, when used as a word or as a string in brackets. */
const LOADERS: ReadonlySet<string> = new Set([
  'createRequire',
  '_load',
  '_resolveFilename',
  '_compile',
  '_extensions',
]);
/** The same, as the name of a member written as a string: `module['require']`. */
const MEMBER_STRINGS: ReadonlySet<string> = new Set([
  ...LOADERS,
  'require',
  'binding',
  'dlopen',
  'eval',
  'Function',
  'mainModule',
  'execPath',
]);
/** Objects whose members are the machinery of loading: `module`, `process`, `global`. */
const MACHINERY: ReadonlySet<string> = new Set(['module', 'process', 'global', 'globalThis']);
/** Objects that `eval` and `Function` hang off when they are not the plain names. */
const GLOBAL_OBJECTS: ReadonlySet<string> = new Set([
  'global',
  'globalThis',
  'window',
  'self',
  'this',
]);

const isPunct = (token: Token | null, text: string): boolean =>
  token?.kind === 'punct' && token.text === text;
const isWord = (token: Token | null, text?: string): boolean =>
  token?.kind === 'word' && (text === undefined || token.text === text);
const isMember = (token: Token | null): boolean => isPunct(token, '.') || isPunct(token, '?.');
const globalObject = (token: Token | null): boolean =>
  token?.kind === 'word' && GLOBAL_OBJECTS.has(token.text);

/** A token after which an operator stands: it ends an operand, so a `[` after it is a member access. */
export const endsOperand = (token: Token | null): boolean =>
  token !== null &&
  (token.kind === 'string' ||
    token.kind === 'other' ||
    (token.kind === 'word' &&
      !['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'throw'].includes(
        token.text,
      )) ||
    isPunct(token, ')') ||
    isPunct(token, ']'));

type Pending =
  | { readonly kind: 'function'; readonly at: number }
  | { readonly kind: 'member-string'; readonly name: string; readonly at: number }
  | { readonly kind: 'machinery'; readonly object: string; readonly at: number }
  | { readonly kind: 'machinery-end'; readonly object: string; readonly at: number };

const found = (reason: string, at: number): Finding => ({ concern: 'dynamic-code', reason, at });

export class LoadingWatch {
  private prev: Token | null = null;
  private prev2: Token | null = null;
  private pending: Pending | null = null;

  /** Reads the next token of the file, in order; what it finds is returned. */
  see(token: Token): Finding[] {
    const out: Finding[] = [];
    const resolved = this.resolve(token);
    if (resolved !== null) out.push(resolved);
    const own = this.own(token);
    if (own !== null) out.push(own);
    this.prev2 = this.prev;
    this.prev = token;
    return out;
  }

  /** What the token after a waiting rule decides. */
  private resolve(token: Token): Finding | null {
    const pending = this.pending;
    this.pending = null;
    if (pending === null) return null;
    switch (pending.kind) {
      case 'function':
        // `Function.prototype` reads a property of the constructor; any other use makes code from text.
        return isPunct(token, '.')
          ? null
          : found('uses the Function constructor, which makes code from text', pending.at);
      case 'member-string':
        return isPunct(token, ']')
          ? found(`reaches ${pending.name} by a string, which hides it from a reader`, pending.at)
          : null;
      case 'machinery':
        // A string alone in the brackets is looked at by its own rule; anything else is a name made at run time.
        if (token.kind === 'string') {
          this.pending = { kind: 'machinery-end', object: pending.object, at: pending.at };
          return null;
        }
        return found(
          `reaches a member of ${pending.object} by a name made at run time`,
          pending.at,
        );
      case 'machinery-end':
        return isPunct(token, ']')
          ? null
          : found(`reaches a member of ${pending.object} by a name made at run time`, pending.at);
    }
  }

  private own(token: Token): Finding | null {
    if (token.kind === 'word') return this.word(token);
    if (token.kind === 'string') return this.string(token);
    if (isPunct(token, '[') && isWord(this.prev) && !isMember(this.prev2)) {
      const object = (this.prev as Token).text;
      if (MACHINERY.has(object)) this.pending = { kind: 'machinery', object, at: token.at };
    }
    return null;
  }

  private string(token: Token): Finding | null {
    // `x['eval']` is a member access (an operand before the bracket), `['eval', 'arguments']` is a list.
    if (isPunct(this.prev, '[') && endsOperand(this.prev2) && MEMBER_STRINGS.has(token.text))
      this.pending = { kind: 'member-string', name: token.text, at: token.at };
    return null;
  }

  private word(token: Token): Finding | null {
    const member = isMember(this.prev);
    switch (token.text) {
      case 'createRequire':
      case '_load':
      case '_resolveFilename':
      case '_compile':
      case '_extensions':
        return found(`uses ${token.text}, which loads modules`, token.at);
      case 'eval':
        return !member || globalObject(this.prev2)
          ? found('uses eval, which runs code from text', token.at)
          : null;
      case 'Function':
        return this.functionWord(token, member);
      case 'constructor':
        return member && isWord(this.prev2, 'constructor')
          ? found('uses .constructor.constructor, which makes code from text', token.at)
          : null;
      case 'binding':
      case 'dlopen':
      case 'execPath':
      case 'mainModule':
        return member && isWord(this.prev2, 'process')
          ? found(`uses process.${token.text}`, token.at)
          : null;
      case 'resolve':
        return member && isWord(this.prev2, 'meta') && isPunct(this.prev, '.')
          ? { concern: 'computed', reason: 'uses import.meta.resolve', at: token.at }
          : null;
      default:
        return null;
    }
  }

  private functionWord(token: Token, member: boolean): Finding | null {
    if (isWord(this.prev, 'instanceof') || isWord(this.prev, 'typeof')) return null;
    if (member) {
      return globalObject(this.prev2)
        ? found('uses the Function constructor, which makes code from text', token.at)
        : null;
    }
    if (isWord(this.prev, 'new'))
      return found('uses the Function constructor, which makes code from text', token.at);
    this.pending = { kind: 'function', at: token.at };
    return null;
  }

  /** The text ended: a rule that waited for another token has nothing to wait for. */
  end(): Finding | null {
    const pending = this.pending;
    this.pending = null;
    return pending?.kind === 'function'
      ? found('uses the Function constructor, which makes code from text', pending.at)
      : null;
  }
}
