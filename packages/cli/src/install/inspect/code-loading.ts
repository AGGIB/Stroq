// The ways a JavaScript file can load or build code without writing the name of a module.
//
// `require('x')` and `import 'x'` show what they load. These do not: `createRequire(import.meta.url)('x')`,
// `module['require'](name)`, `process.binding`, `eval(text)`, `new Function(text)`, `globalThis.Function`,
// `x.constructor.constructor(text)`, `process.execPath` (a node that is started with `-e`), a file written and then
// loaded. Each of them is a reason to say that what the file loads is not known, which is a concern like a doubt of
// the lexer. What is looked for is in `code-loading-registry.ts`, as data.
//
// It is a watch over the tokens, one at a time and in order. A rule that has to see the token after (`Function`
// followed by `.` is `Function.prototype`; followed by anything else it is the constructor used as a value) waits
// for it. What it remembers is small: the last four tokens, the names of the current chain of members
// (`a.b['c']`), the identifiers that were set to the global object, `process` or `module` (`const g = globalThis`),
// the members of process named in the last braces (for a destructuring), and the first place of each fact the caller combines with
// the imports of the file (a node option as an argument matters only where a program is started).
//
// Best-effort: a name that is built from pieces is seen only where it is looked up on the global object, `process`
// or `module`; an object that reaches the global object some other way (`(function () { return this })()`) is not
// followed; a file written under a name built at run time is not seen.
import { cookString, type Token } from './js-lexer.js';
import { Occurrences } from './code-loading-general.js';
import {
  ABSOLUTE_SCRIPT,
  ENVIRONMENT_NAMES,
  GLOBAL_MEMBERS,
  HARMLESS_MEMBERS,
  isLiteralValue,
  LOADED_FILE,
  LOADER_NAMES,
  LOOKUP_MEMBERS,
  MEMBER_ONLY_WRITERS,
  MODULE_ONLY_NAMES,
  NODE_FLAGS,
  NODE_FLAG_PREFIXES,
  opensLiteral,
  PROCESS_MEMBERS,
  REFLECTION_METHODS,
  RUNNERS,
  WRITERS,
  type Entry,
} from './code-loading-registry.js';

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

/** What an identifier stands for, when it is the global object, `process` or `module`. */
type Receiver = 'global' | 'loose' | 'process' | 'module';

const RECEIVERS: ReadonlyMap<string, Receiver> = new Map([
  ['globalThis', 'global'],
  ['global', 'global'],
  ['window', 'loose'],
  ['self', 'loose'],
  ['this', 'loose'],
  ['process', 'process'],
  ['module', 'module'],
]);

/** The most identifiers set to the global object that are followed; more is a doubt, not a silence. */
const ALIASES_MAX = 1000;
/** The deepest nesting of braces that is followed for the scope of an alias; deeper, an alias is kept to the end of the file. */
const SCOPES_MAX = 256;
/** The most keys of one pair of braces that are kept. */
const KEYS_MAX = 64;
/** The longest chain of members that is remembered. */
const CHAIN_MAX = 16;
/** The most tokens after a writer in which the name of the file is looked for. */
const WRITE_WINDOW = 12;
/** After the constructor of a value, these make it the Function constructor in use: a call, or handing it on. */
const CONSTRUCTOR_USED: ReadonlySet<string> = new Set(['(', ';', ',', ')', ']', '}']);
/** Members of a function that call it with text. */
const CALLS: ReadonlySet<string> = new Set(['call', 'apply', 'bind', 'constructor']);
/** The longest string that is read as a command line. */
const COMMAND_MAX = 4096;

const byName = (entries: readonly Entry[]): ReadonlyMap<string, string> =>
  new Map(entries.map((entry) => [entry.name, entry.does]));
const LOADERS = byName(LOADER_NAMES);
const PROCESS = byName(PROCESS_MEMBERS);
const GLOBAL_CODE = byName(GLOBAL_MEMBERS);
const LOOKUP = byName(LOOKUP_MEMBERS);
const MODULE_ONLY = byName(MODULE_ONLY_NAMES);

/** Names that are a finding when written as a string in brackets: `module['require']`, `x['eval']`. */
const MEMBER_STRINGS: ReadonlySet<string> = new Set([
  ...LOADERS.keys(),
  ...PROCESS.keys(),
  ...GLOBAL_CODE.keys(),
  'require',
]);

const isPunct = (token: Token | null, text: string): boolean =>
  token?.kind === 'punct' && token.text === text;
const isWord = (token: Token | null, text?: string): boolean =>
  token?.kind === 'word' && (text === undefined || token.text === text);
const isMember = (token: Token | null): boolean => isPunct(token, '.') || isPunct(token, '?.');

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

/** Names of the global object whose being taken out by a pattern is a use of them. */
const TAKEN_FROM_GLOBAL: ReadonlySet<string> = new Set([
  'process',
  'module',
  'require',
  'eval',
  'Function',
  'constructor',
  '__proto__',
]);

/** The value of a string token; null when its escapes cannot be read. */
const valueOf = (token: Token): string | null =>
  token.escaped === true ? cookString(token.text) : token.text;

/**
 * Whether a string is a command line that starts Node with text to run or code to load: `node -e "..."`,
 * `/usr/bin/node --require x`. The words are split on blanks and the options after `node` are looked at one by one.
 */
export function commandRunsNodeCode(command: string): boolean {
  if (command.length > COMMAND_MAX) return false;
  const words = command.split(/\s+/);
  const at = words.findIndex((word) => /(?:^|[\\/])node(?:\.exe)?$/.test(word));
  return at !== -1 && words.slice(at + 1).some(isNodeFlag);
}

const isNodeFlag = (word: string): boolean =>
  NODE_FLAGS.has(word) || NODE_FLAG_PREFIXES.some((prefix) => word.startsWith(prefix));

/** The first place of each fact that matters only together with what the file imports. */
export interface Facts {
  /** An argument that makes node run text or load code. */
  readonly nodeOption?: Finding;
  /** A program that loads code by name from a registry. */
  readonly runner?: Finding;
  /** A script given by a path from the root of a disk. */
  readonly outsideScript?: Finding;
  /** A variable of the environment that makes a Node process load code. */
  readonly environment?: Finding;
  /** A name that is Node's own only where the file imports `module` (`register`). */
  readonly moduleUse?: Finding;
}

type Pending =
  | { readonly kind: 'function'; readonly at: number; readonly key: boolean }
  /** A key called `require` or `constructor`: a name, unless what follows the colon binds it to a variable. */
  | { readonly kind: 'key'; readonly name: string; readonly at: number }
  /** After `require:` or `Function:`: a value that is written out is a literal; a name is a pattern's target. */
  | { readonly kind: 'key-target'; readonly name: string; readonly at: number }
  /** `const { a } = process`: a pattern that takes `a` out of the object itself; `process.env` after it makes it a pattern on a member. */
  | { readonly kind: 'destructured'; readonly finding: Finding }
  | { readonly kind: 'member-string'; readonly name: string; readonly at: number }
  | { readonly kind: 'machinery'; readonly object: string; readonly at: number }
  | { readonly kind: 'machinery-end'; readonly object: string; readonly at: number }
  | { readonly kind: 'passed'; readonly object: string; readonly at: number }
  /** `f().constructor`: used as a value or called, it is the Function constructor; `.name` after it is not. */
  | { readonly kind: 'constructor-value'; readonly at: number; readonly expression: boolean }
  | { readonly kind: 'constructor-member'; readonly at: number };

const found = (reason: string, at: number): Finding => ({ concern: 'dynamic-code', reason, at });

/** An identifier set to the global object, `process` or `module`. A `let` or `const` ends with its block. */
interface Alias {
  readonly receiver: Receiver;
  readonly scoped: boolean;
}

interface Scope {
  /** An object written out as a value (`x = { ... }`), whose keys name properties and bind nothing. */
  readonly literal: boolean;
  readonly named: Set<string>;
  readonly aliases: string[];
  /** Keys called `Function`, held until the brace closes: `{ Function: f } = x` takes the constructor out, a literal does not. */
  readonly keys: Finding[];
}

export class LoadingWatch {
  /** The last four tokens, the newest first. */
  private recent: (Token | null)[] = [null, null, null, null];
  private pending: Pending | null = null;
  /** The names of the chain of members that the last token is part of: `a.b['c']` is `a`, `b`, `c`. */
  private chain: string[] = [];
  private readonly aliases = new Map<string, Alias>();
  /** An identifier just set to the global object, `process` or `module`, until the next token shows it was the whole value. */
  private candidate: { readonly name: string; readonly receiver: Receiver } | null = null;
  private aliasesFull = false;
  /** The open braces: the members of process named inside each, and the aliases declared in it with let or const. */
  private readonly scopes: Scope[] = [{ literal: false, named: new Set(), aliases: [], keys: [] }];
  /** The keys that the brace which closed last held, until the next token shows whether it was a pattern. */
  private closedKeys: Finding[] = [];
  /** Braces deeper than `SCOPES_MAX`, which are counted and not kept. */
  private overflow = 0;
  private keyCandidate: string | null = null;
  /** The keys named inside the brace that closed last. */
  private closed: ReadonlySet<string> = new Set();
  /** The declaration the last token is part of: `let`, `const` or `var`, and how deep it stands. */
  private declaration: { readonly keyword: string; readonly depth: number } | null = null;
  private write: { left: number } | null = null;
  /** The identifiers that are a concern in any position. */
  private readonly occurrences = new Occurrences();
  private facts: {
    -readonly [K in keyof Facts]: Facts[K];
  } = {};

  /** Reads the next token of the file, in order; what it finds is returned. */
  see(token: Token): Finding[] {
    const out: Finding[] = [];
    this.settleAlias(token);
    if (this.closedKeys.length > 0) {
      if (isPunct(token, '=')) out.push(...this.closedKeys);
      this.closedKeys = [];
    }
    const resolved = this.resolve(token);
    if (resolved !== null) out.push(resolved);
    out.push(...this.own(token));
    out.push(...this.occurrences.see(token));
    this.advance(token);
    return out;
  }

  /** The facts found so far; the caller decides what they mean from the imports of the file. */
  collected(): Facts {
    return this.facts;
  }

  private get prev(): Token | null {
    return this.recent[0] ?? null;
  }
  private get prev2(): Token | null {
    return this.recent[1] ?? null;
  }
  private get prev3(): Token | null {
    return this.recent[2] ?? null;
  }
  private get prev4(): Token | null {
    return this.recent[3] ?? null;
  }

  /** Moves on to the next token: the recent ones, the chain, and the braces. */
  private advance(token: Token): void {
    this.recent = [token, this.recent[0] ?? null, this.recent[1] ?? null, this.recent[2] ?? null];
    this.advanceChain(token);
    if (this.write !== null) {
      this.write.left -= 1;
      if (this.write.left <= 0 || isPunct(token, ';')) this.write = null;
    }
    this.advanceScopes(token);
  }

  /** Whether the brace the last token stands in is an object written out as a value (a deeper nesting is not trusted). */
  private inLiteral(): boolean {
    return this.overflow === 0 && this.scopes.at(-1)!.literal;
  }

  private depth(): number {
    return this.scopes.length + this.overflow;
  }

  /** The braces: where an alias declared with `let` or `const` ends, and the members of process named in a pattern. */
  private advanceScopes(token: Token): void {
    this.noteKey(token);
    if (isPunct(token, '{') || isPunct(token, '${')) {
      if (this.scopes.length < SCOPES_MAX) {
        // `prev` is the brace itself here, so the token before it is `prev2`.
        const literal = isPunct(token, '{') && opensLiteral(this.prev2, this.inLiteral());
        this.scopes.push({ literal, named: new Set(), aliases: [], keys: [] });
      } else this.overflow += 1;
    } else if (isPunct(token, '}')) {
      if (this.overflow > 0) this.overflow -= 1;
      else if (this.scopes.length > 1) {
        const scope = this.scopes.pop()!;
        this.closed = scope.named;
        this.closedKeys = scope.keys;
        for (const name of scope.aliases)
          if (this.aliases.get(name)?.scoped === true) this.aliases.delete(name);
      } else this.closed = new Set();
    } else if (isPunct(token, ';')) this.declaration = null;
    else if (token.kind === 'word') {
      if (token.text === 'let' || token.text === 'const' || token.text === 'var')
        this.declaration = { keyword: token.text, depth: this.depth() };
    }
  }

  /** The keys of the braces: a word after `{` or `,` that is followed by `:`, `,`, `}` or `=`. */
  private noteKey(token: Token): void {
    const candidate = this.keyCandidate;
    this.keyCandidate = null;
    if (
      candidate !== null &&
      token.kind === 'punct' &&
      (token.text === ':' || token.text === ',' || token.text === '}' || token.text === '=')
    ) {
      const named = this.scopes.at(-1)!.named;
      if (named.size < KEYS_MAX) named.add(candidate);
    }
    // `prev` is already the token itself here: the one before it is `prev2`.
    if (token.kind === 'word' && (isPunct(this.prev2, '{') || isPunct(this.prev2, ',')))
      this.keyCandidate = token.text;
  }

  private advanceChain(token: Token): void {
    // `prev` is already the token itself: look at the one before it.
    const before = this.prev2;
    if (token.kind === 'word') {
      if (isMember(before)) this.chain.push(token.text);
      else this.chain = [token.text];
    } else if (token.kind === 'string' && isPunct(before, '[')) {
      this.chain.push(valueOf(token) ?? '?');
    } else if (!(isMember(token) || isPunct(token, '[') || isPunct(token, ']'))) this.chain = [];
    if (this.chain.length > CHAIN_MAX) this.chain = [this.chain[0]!, ...this.chain.slice(-8)];
  }

  /** What an identifier stands for: the global object, `process` or `module`, by its name or because it was set to one. */
  private receiverOf(token: Token | null): Receiver | null {
    if (token?.kind !== 'word') return null;
    return RECEIVERS.get(token.text) ?? this.aliases.get(token.text)?.receiver ?? null;
  }

  private isGlobal(token: Token | null): boolean {
    const kind = this.receiverOf(token);
    return kind === 'global' || kind === 'loose';
  }

  /** What the token after a waiting rule decides. */
  private resolve(token: Token): Finding | null {
    const pending = this.pending;
    this.pending = null;
    if (pending === null) return null;
    switch (pending.kind) {
      case 'function':
        // `Function.prototype` reads a property of the constructor; any other use makes code from text.
        if (isPunct(token, '.')) return null;
        // A key called `Function` is a name, unless what follows the colon is a variable it is taken into.
        if (pending.key && isPunct(token, ':')) {
          this.pending = { kind: 'key-target', name: 'Function', at: pending.at };
          return null;
        }
        return found('uses the Function constructor, which makes code from text', pending.at);
      case 'key':
        if (!isPunct(token, ':')) return null;
        if (pending.name === 'constructor') {
          // `{ constructor: C } = x` takes the constructor out of a value; `{ constructor: Foo }` as a literal does not.
          // The braces show which when they close: an `=` after them is a pattern.
          if (this.overflow === 0)
            this.scopes
              .at(-1)!
              .keys.push(found('takes .constructor out of a value by a pattern', pending.at));
          return null;
        }
        this.pending = { kind: 'key-target', name: pending.name, at: pending.at };
        return null;
      case 'key-target':
        // `{ require: 1 }` and `{ Function: 'x' }` give the key a value; `{ require: r }` may bind it, in a pattern,
        // but not in an object that is written out as a value.
        return isLiteralValue(token) || this.inLiteral()
          ? null
          : {
              concern: pending.name === 'require' ? 'computed' : 'dynamic-code',
              reason: `${pending.name} is taken into a variable by a pattern, which this reading does not follow`,
              at: pending.at,
            };
      case 'destructured':
        // `const { FOO } = process.env` takes from a member, which is read where it is named (`env` is data).
        return isMember(token) || isPunct(token, '[') ? null : pending.finding;
      case 'member-string':
        return isPunct(token, ']')
          ? found(`reaches ${pending.name} by a string, which hides it from a reader`, pending.at)
          : null;
      case 'machinery':
        // A string alone in the brackets is looked at by its own rule; anything else is a name made at run time.
        if (token.kind === 'string') {
          this.pending = { kind: 'machinery-end', object: pending.object, at: pending.at };
          return valueOf(token) === null
            ? found(
                `reaches a member of ${pending.object} by a name written with an escape that cannot be read`,
                pending.at,
              )
            : null;
        }
        return found(
          `reaches a member of ${pending.object} by a name made at run time`,
          pending.at,
        );
      case 'machinery-end':
        return isPunct(token, ']')
          ? null
          : found(`reaches a member of ${pending.object} by a name made at run time`, pending.at);
      case 'constructor-value':
        if (isMember(token)) {
          this.pending = { kind: 'constructor-member', at: pending.at };
          return null;
        }
        // The constructor of an expression (a function value, a call) used or handed on is in use; the constructor of a
        // name, only when it is called: `Error.captureStackTrace(this, e.constructor)` is a class.
        return (pending.expression &&
          (CONSTRUCTOR_USED.has(token.text) || token.kind === 'string')) ||
          isPunct(token, '(')
          ? found('uses .constructor.constructor, which makes code from text', pending.at)
          : null;
      case 'constructor-member':
        return isWord(token) && CALLS.has(token.text)
          ? found('uses .constructor.constructor, which makes code from text', pending.at)
          : null;
      case 'passed':
        // `Reflect.get(globalThis, name)` hands the object to code that picks the member; `globalThis.x` does not.
        return isMember(token) || isPunct(token, '[')
          ? null
          : found(
              `passes ${pending.object} to Reflect or Object, which can reach any member of it by a name`,
              pending.at,
            );
    }
  }

  private own(token: Token): Finding[] {
    switch (token.kind) {
      case 'word':
        return this.word(token);
      case 'string':
        return this.string(token);
      case 'punct':
        return this.punct(token);
      default:
        return [];
    }
  }

  private punct(token: Token): Finding[] {
    if (!isPunct(token, '[') || !isWord(this.prev)) return [];
    const receiver = this.receiverOf(this.prev);
    if (receiver !== 'global' && receiver !== 'process' && receiver !== 'module') return [];
    // `a.process[x]` is a property of something else; `globalThis.process[x]` is process itself.
    const viaGlobal =
      (this.prev as Token).text === 'process' && this.receiverOf(this.prev3) === 'global';
    if (isMember(this.prev2) && !viaGlobal) return [];
    this.pending = { kind: 'machinery', object: (this.prev as Token).text, at: token.at };
    return [];
  }

  private string(token: Token): Finding[] {
    const out: Finding[] = [];
    const value = valueOf(token);
    // `x['eval']` is a member access (an operand before the bracket), `['eval', 'arguments']` is a list.
    if (isPunct(this.prev, '[') && endsOperand(this.prev2)) {
      if (value !== null && MEMBER_STRINGS.has(value))
        this.pending = { kind: 'member-string', name: value, at: token.at };
      const lookup = value === null ? undefined : LOOKUP.get(value);
      if (lookup !== undefined && this.receiverOf(this.prev2) === 'module')
        out.push(found(`uses module.${value}, which ${lookup}`, token.at));
      if (value === 'constructor' && this.chain.at(-1) === 'constructor')
        out.push(found('uses .constructor.constructor, which makes code from text', token.at));
    }
    // `const p = require('node:process')` is process under another name.
    if (
      (value === 'process' || value === 'node:process') &&
      isPunct(this.prev, '(') &&
      isWord(this.prev2, 'require') &&
      isPunct(this.prev3, '=') &&
      isWord(this.prev4)
    )
      this.setAlias((this.prev4 as Token).text, 'process', false);
    if (value !== null) this.stringFacts(token, value, out);
    return out;
  }

  /** Facts that matter with the imports of the file, and the name of a file that is written. */
  private stringFacts(token: Token, value: string, out: Finding[]): void {
    if (this.write !== null && LOADED_FILE.test(value))
      out.push(found('writes a file that Node can load as code', token.at));
    const first = value.length <= COMMAND_MAX ? (value.split(/\s+/)[0] ?? '') : '';
    if (isNodeFlag(value) || commandRunsNodeCode(value))
      this.facts.nodeOption ??= found('starts node with text to run or code to load', token.at);
    if (RUNNERS.has(value) || RUNNERS.has(first))
      this.facts.runner ??= found('starts a program that loads code by name', token.at);
    if (ABSOLUTE_SCRIPT.test(value))
      this.facts.outsideScript ??= found('starts a script from outside the tree', token.at);
    if (ENVIRONMENT_NAMES.has(value))
      this.facts.environment ??= found('sets how a Node process loads code', token.at);
  }

  private word(token: Token): Finding[] {
    const out: Finding[] = [];
    const member = isMember(this.prev);
    const name = token.text;
    this.track(token);
    this.passing(token);
    const loader = LOADERS.get(name);
    if (loader !== undefined) out.push(found(`uses ${name}, which ${loader}`, token.at));
    const moduleOnly = MODULE_ONLY.get(name);
    if (moduleOnly !== undefined)
      this.facts.moduleUse ??= found(`uses ${name}, which ${moduleOnly}`, token.at);
    if (ENVIRONMENT_NAMES.has(name))
      this.facts.environment ??= found('sets how a Node process loads code', token.at);
    if (WRITERS.has(name) && (member || !MEMBER_ONLY_WRITERS.has(name)))
      this.write = { left: WRITE_WINDOW };
    const finding = this.rule(token, member);
    if (finding !== null) out.push(finding);
    if (
      (name === 'require' || name === 'constructor') &&
      !member &&
      (isPunct(this.prev, '{') || isPunct(this.prev, ','))
    )
      this.pending ??= { kind: 'key', name, at: token.at };
    return out;
  }

  /** `Reflect.get(globalThis, ...)`: the object is handed to a call that picks a member by a name. */
  private passing(token: Token): void {
    const receiver = this.receiverOf(token);
    if (receiver !== 'global' && receiver !== 'process' && receiver !== 'module') return;
    if (
      isPunct(this.prev, '(') &&
      isWord(this.prev2) &&
      REFLECTION_METHODS.has((this.prev2 as Token).text) &&
      isMember(this.prev3) &&
      (isWord(this.prev4, 'Reflect') || isWord(this.prev4, 'Object'))
    )
      this.pending = { kind: 'passed', object: token.text, at: token.at };
  }

  /**
   * A candidate for an alias of the global object, `process` or `module`: `const g = globalThis`. A name that is set to
   * anything else is no longer an alias: minified code gives the same short name to many things.
   */
  private track(token: Token): void {
    if (!isPunct(this.prev, '=') || !isWord(this.prev2) || isMember(this.prev3)) return;
    const name = (this.prev2 as Token).text;
    const receiver = this.receiverOf(token);
    if (receiver === null) this.aliases.delete(name);
    else this.candidate = { name, receiver };
  }

  /** `const argv = process.argv` is not an alias of process: the value goes on with a member, a call or a bracket. */
  private settleAlias(token: Token): void {
    const candidate = this.candidate;
    this.candidate = null;
    if (candidate === null) return;
    if (isMember(token) || isPunct(token, '[') || isPunct(token, '(')) return;
    // A `let` or `const` of this block is gone at its end; a `var`, or an assignment, is kept to the end of the file.
    const declaration = this.declaration;
    const scoped =
      declaration !== null &&
      declaration.keyword !== 'var' &&
      declaration.depth === this.depth() &&
      this.overflow === 0;
    this.setAlias(candidate.name, candidate.receiver, scoped);
  }

  private setAlias(name: string, receiver: Receiver, scoped: boolean): void {
    if (this.aliases.size >= ALIASES_MAX && !this.aliases.has(name)) {
      this.aliasesFull = true;
      return;
    }
    this.aliases.set(name, { receiver, scoped });
    if (scoped) this.scopes.at(-1)!.aliases.push(name);
  }

  /** The finding for a word by its position: the plain names `eval` and `Function`, and what hangs off a receiver. */
  private rule(token: Token, member: boolean): Finding | null {
    switch (token.text) {
      case 'eval':
        return !member || this.isGlobal(this.prev2)
          ? found('uses eval, which runs code from text', token.at)
          : null;
      case 'Function':
        return this.functionWord(token, member);
      case 'constructor':
        return this.constructorWord(token, member);
      case 'require':
        // `require.main.require('x')` loads through the main module, with its lookup paths.
        return member && this.chain[0] === 'require' && this.chain.at(-1) === 'main'
          ? found(
              'uses require.main.require, which loads a module through the main module',
              token.at,
            )
          : null;
      case 'resolve':
        return member && isWord(this.prev2, 'meta') && isPunct(this.prev, '.')
          ? { concern: 'computed', reason: 'uses import.meta.resolve', at: token.at }
          : null;
      case 'paths':
        return member && this.receiverOf(this.prev2) === 'module'
          ? found(`uses module.paths, which ${LOOKUP.get('paths')}`, token.at)
          : null;
      default:
        return this.processMember(token, member) ?? this.destructured(token);
    }
  }

  private processMember(token: Token, member: boolean): Finding | null {
    const does = PROCESS.get(token.text);
    if (does === undefined || !member || this.receiverOf(this.prev2) !== 'process') return null;
    return found(`uses process.${token.text}, which ${does}`, token.at);
  }

  /** `const { binding } = process`: a member of process taken out by a pattern, and then used by its own name. */
  private destructured(token: Token): Finding | null {
    const receiver = this.receiverOf(token);
    if (receiver === null || !isPunct(this.prev, '=') || !isPunct(this.prev2, '}')) return null;
    const harmless = HARMLESS_MEMBERS.get(receiver === 'process' ? 'process' : 'module');
    const global = receiver === 'global' || receiver === 'loose';
    for (const key of this.closed) {
      // The global object has no harmless members to list: the names that lead to code are the ones refused.
      const bad = global ? TAKEN_FROM_GLOBAL.has(key) : harmless?.has(key) !== true;
      if (bad) {
        this.pending ??= {
          kind: 'destructured',
          finding: found(
            `takes ${key} out of ${token.text} by a pattern, which this reading does not follow`,
            token.at,
          ),
        };
        return null;
      }
    }
    return null;
  }

  private constructorWord(token: Token, member: boolean): Finding | null {
    if (!member) return null;
    if (this.chain.at(-1) === 'constructor' || this.chain[0] === 'Function')
      return found('uses .constructor.constructor, which makes code from text', token.at);
    // The constructor of any value is the Function constructor if the value is a function: once it is called it is a
    // use, and `.name`, `.prototype` and a comparison are not. For a value that is written as an expression, the call
    // of a function or `(async () => {})`, handing it on is a use as well. `this` is an instance (`this.constructor`).
    if (!isWord(this.prev2, 'this'))
      this.pending = {
        kind: 'constructor-value',
        at: token.at,
        expression: isPunct(this.prev2, ')') || isPunct(this.prev2, ']'),
      };
    return null;
  }

  private functionWord(token: Token, member: boolean): Finding | null {
    if (isWord(this.prev, 'instanceof') || isWord(this.prev, 'typeof')) return null;
    if (member) {
      return this.isGlobal(this.prev2)
        ? found('uses the Function constructor, which makes code from text', token.at)
        : null;
    }
    if (isWord(this.prev, 'new'))
      return found('uses the Function constructor, which makes code from text', token.at);
    this.pending = {
      kind: 'function',
      at: token.at,
      key: isPunct(this.prev, '{') || isPunct(this.prev, ','),
    };
    return null;
  }

  /** The text ended: a rule that waited for another token has nothing to wait for. */
  end(): Finding[] {
    const out = this.occurrences.end();
    const pending = this.pending;
    this.pending = null;
    if (this.aliasesFull)
      out.push({
        concern: 'doubt',
        reason: `more than ${ALIASES_MAX} names are set to the global object, process or module`,
        at: 0,
      });
    if (pending?.kind === 'constructor-value' && pending.expression)
      out.push(found('uses .constructor.constructor, which makes code from text', pending.at));
    if (pending?.kind === 'function')
      out.push(found('uses the Function constructor, which makes code from text', pending.at));
    if (pending?.kind === 'destructured') out.push(pending.finding);
    return out;
  }
}
