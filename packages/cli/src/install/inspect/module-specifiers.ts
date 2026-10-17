// The modules a JavaScript file asks for, and whether the file can be read for them with certainty.
//
// Whether a server's code can be pinned depends on this: Node looks a package up by name in folders above the
// file that asks, and what it finds there is not among the bytes that were confirmed. So the names are read
// from the text, without running it, with the lexer of `js-lexer.ts`.
//
// The reading is best-effort and is built to say so. It lists the specifiers it can read (`import 'x'`,
// `import ... from 'x'`, `export ... from 'x'`, `require('x')` and `import('x')` with a string written out),
// and it names a *concern* for everything it cannot settle: a text it could not lex with certainty, a module
// requested by a name built at run time, a way of loading code that has no name in the text (`code-loading.ts`),
// a name written with escapes. A file with a concern is a file whose imports are not known, and the caller
// treats it as one that may load code from outside its tree. Each concern comes with a reason and a line.
import { builtinModules } from 'node:module';
import { WINDOWS_PATH } from '../path-names.js';
import { LoadingWatch, type Concern } from './code-loading.js';
import { Lexer, lineOf, type Token } from './js-lexer.js';

export type { Concern } from './code-loading.js';

/** The most distinct specifiers one file is read for; a file with more is a concern. */
const MAX_SPECIFIERS = 2000;
/** The most tokens an import or export clause may take before it is given up as something else. */
const MAX_CLAUSE_TOKENS = 2000;

/** Why a file is not fully read, and where. */
export interface Note {
  readonly concern: Concern;
  readonly reason: string;
  /** The line of the first place, counting `\n`. */
  readonly line: number;
}

export interface ModuleScan {
  /** The specifiers asked for, each once, in the order they first appear. */
  readonly specifiers: readonly string[];
  /** Why the file is not fully read, sorted; empty when it is. */
  readonly concerns: readonly Concern[];
  /** One note for each concern, with the first reason and place. */
  readonly notes: readonly Note[];
}

interface ClauseState {
  readonly at: 'clause';
  readonly depth: number;
  readonly closed: boolean;
  readonly used: number;
}

type State =
  | { readonly at: 'idle' }
  | { readonly at: 'require'; readonly guarded: boolean }
  | { readonly at: 'requireMember' }
  | { readonly at: 'resolve' }
  | { readonly at: 'call' }
  | { readonly at: 'callEnd'; readonly specifier: string }
  | { readonly at: 'import' }
  | { readonly at: 'export' }
  /** After a `from` that may be the keyword or a name that is imported: the clause to go on with if it is a name. */
  | { readonly at: 'from'; readonly clause: ClauseState }
  | ClauseState;

const IDLE: State = { at: 'idle' };
const CLAUSE_START: ClauseState = { at: 'clause', depth: 0, closed: false, used: 0 };
const isPunct = (token: Token | null, text: string): boolean =>
  token?.kind === 'punct' && token.text === text;
const isWord = (token: Token | null, text: string): boolean =>
  token?.kind === 'word' && token.text === text;

interface Step {
  readonly state: State;
  readonly found?: string;
  readonly concern?: readonly [Concern, string];
  /** The token must be read again in the new state. */
  readonly again?: true;
}

const COMPUTED_NAME = [
  'computed',
  'a module is requested by a name that is built at run time',
] as const;
const REQUIRE_VALUE = [
  'computed',
  'require is used as a value, so what it loads is not written out',
] as const;
const ESCAPED_NAME = ['escaped', 'a module name is written with escapes'] as const;

/** What follows `import` or `export` when it starts a clause that ends in `from 'x'`. */
function clauseStep(state: ClauseState, token: Token): State | 'abort' {
  const used = state.used + 1;
  if (used > MAX_CLAUSE_TOKENS) return 'abort';
  if (token.kind === 'word' && state.depth === 0 && token.text === 'from')
    return { at: 'from', clause: { ...state, used } };
  if (state.closed) return 'abort';
  if (isPunct(token, '{')) return { ...state, depth: state.depth + 1, used };
  if (isPunct(token, '}'))
    return state.depth === 1
      ? { at: 'clause', depth: 0, closed: true, used }
      : { ...state, depth: Math.max(0, state.depth - 1), used };
  if (token.kind === 'string') return state.depth > 0 ? { ...state, used } : 'abort';
  if (token.kind === 'word')
    return ['import', 'export', 'require'].includes(token.text) ? 'abort' : { ...state, used };
  return isPunct(token, ',') || isPunct(token, '*') ? { ...state, used } : 'abort';
}

function stepClause(state: ClauseState, token: Token): Step {
  const next = clauseStep(state, token);
  return next === 'abort' ? { state: IDLE, again: true } : { state: next };
}

/** A string where a module name is expected: a name with escapes is not the name it spells. */
function named(token: Token, after: State): Step {
  if (token.escaped === true) return { state: IDLE, concern: ESCAPED_NAME };
  return after.at === 'callEnd' ? { state: after } : { state: IDLE, found: token.text };
}

function stepRequest(state: State, token: Token): Step | null {
  switch (state.at) {
    case 'call':
      return token.kind === 'string'
        ? named(token, { at: 'callEnd', specifier: token.text })
        : { state: IDLE, concern: COMPUTED_NAME, again: true };
    case 'callEnd':
      // `require('a' + b)` names no module: the string is closed by `)`, or by `,` before options.
      return isPunct(token, ')') || isPunct(token, ',')
        ? { state: IDLE, found: state.specifier }
        : { state: IDLE, concern: COMPUTED_NAME, again: true };
    case 'from':
      // `from` is the keyword when a string follows. When anything else does, it was a name (`import from from
      // 'x'`, `import * as from from 'x'`) and the clause goes on from it.
      return token.kind === 'string' ? named(token, IDLE) : stepClause(state.clause, token);
    default:
      return null;
  }
}

function stepRequire(state: State, token: Token): Step | null {
  switch (state.at) {
    case 'require':
      if (isPunct(token, '(')) return { state: { at: 'call' } };
      if (isPunct(token, '.')) return { state: { at: 'requireMember' } };
      // `typeof require` asks whether there is one. Any other use of the name, `const r = require`, is a way
      // of calling it that no later `require(` shows.
      return state.guarded
        ? { state: IDLE, again: true }
        : { state: IDLE, concern: REQUIRE_VALUE, again: true };
    case 'requireMember':
      if (isWord(token, 'main')) return { state: IDLE };
      return isWord(token, 'resolve')
        ? { state: { at: 'resolve' } }
        : { state: IDLE, concern: REQUIRE_VALUE, again: true };
    case 'resolve':
      return isPunct(token, '(')
        ? { state: { at: 'call' } }
        : { state: IDLE, concern: REQUIRE_VALUE, again: true };
    default:
      return null;
  }
}

function stepImport(state: State, token: Token): Step | null {
  switch (state.at) {
    case 'import':
      if (isPunct(token, '(')) return { state: { at: 'call' } };
      if (token.kind === 'string') return named(token, IDLE);
      if (isPunct(token, '.')) return { state: IDLE };
      if (token.kind === 'word' || isPunct(token, '{') || isPunct(token, '*'))
        return stepClause(CLAUSE_START, token);
      return { state: IDLE, again: true };
    case 'export':
      return isPunct(token, '{') || isPunct(token, '*')
        ? stepClause(CLAUSE_START, token)
        : { state: IDLE, again: true };
    case 'clause':
      return stepClause(state, token);
    default:
      return null;
  }
}

/** A word that starts something: the next state. */
function stepIdle(token: Token, before: Token | null): Step {
  if (token.kind !== 'word') return { state: IDLE };
  const member = isPunct(before, '.') || isPunct(before, '?.');
  switch (token.text) {
    case 'require':
      return { state: { at: 'require', guarded: isWord(before, 'typeof') } };
    case 'import':
      return member ? { state: IDLE } : { state: { at: 'import' } };
    case 'export':
      return member ? { state: IDLE } : { state: { at: 'export' } };
    default:
      return { state: IDLE };
  }
}

function step(state: State, token: Token, before: Token | null): Step {
  return (
    stepRequest(state, token) ??
    stepRequire(state, token) ??
    stepImport(state, token) ??
    stepIdle(token, before)
  );
}

/** The first reason and place of each concern, in the order they came. */
class Notes {
  private readonly first = new Map<Concern, { reason: string; at: number }>();

  add(concern: Concern, reason: string, at: number): void {
    if (!this.first.has(concern)) this.first.set(concern, { reason, at });
  }

  list(text: string): Note[] {
    return [...this.first]
      .map(([concern, { reason, at }]) => ({ concern, reason, line: lineOf(text, at) }))
      .sort((a, b) => (a.concern < b.concern ? -1 : a.concern > b.concern ? 1 : 0));
  }
}

/** Reads the text of one JavaScript file for the modules it asks for, and for what it does not let be read. */
export function scanModules(text: string, limit = MAX_SPECIFIERS): ModuleScan {
  const lexer = new Lexer(text);
  const watch = new LoadingWatch();
  const found = new Set<string>();
  const notes = new Notes();
  let state: State = IDLE;
  let before: Token | null = null;
  for (let token = lexer.next(); token !== null; token = lexer.next()) {
    for (const finding of watch.see(token)) notes.add(finding.concern, finding.reason, finding.at);
    let result = step(state, token, before);
    if (result.concern !== undefined) notes.add(result.concern[0], result.concern[1], token.at);
    if (result.again === true) {
      result = step(result.state, token, before);
      if (result.concern !== undefined) notes.add(result.concern[0], result.concern[1], token.at);
    }
    state = result.state;
    if (result.found !== undefined) found.add(result.found);
    before = token;
    if (found.size > limit) {
      notes.add('doubt', `the file asks for more than ${limit} different modules`, token.at);
      break;
    }
  }
  const end = watch.end();
  if (end !== null) notes.add(end.concern, end.reason, end.at);
  // The text ended in the middle of something that asks for a module: `require` and a bracket, nothing more.
  if (['call', 'callEnd', 'requireMember', 'resolve'].includes(state.at))
    notes.add('computed', 'the text ends in the middle of a request for a module', text.length);
  if (state.at === 'require' && !state.guarded) notes.add(...REQUIRE_VALUE, text.length);
  if (lexer.doubt !== null) notes.add('doubt', lexer.doubt.reason, lexer.doubt.at);
  const list = notes.list(text);
  return {
    specifiers: [...found].slice(0, limit),
    concerns: list.map((note) => note.concern),
    notes: list,
  };
}

const BUILTINS: ReadonlySet<string> = new Set(builtinModules);
/** A scheme: letters, then a colon. */
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** How a module specifier is looked up. */
export type SpecifierKind =
  /** A package, looked up by name in folders above the file. */
  | 'bare'
  /** A path from the file: `./x`, `../x`. */
  | 'relative'
  /** A path from the root, or a `file:` URL: it names a place outside any tree. */
  | 'absolute'
  /** Node's own, or a `#` import that the package maps itself. */
  | 'inside'
  /** A `data:` URL: the module is the text of the specifier, and it can import any URL. */
  | 'data';

/**
 * How Node looks the specifier up. A scheme that Node cannot load (`https:`) or that belongs to another runtime
 * (`npm:`) is `bare`: its code comes from outside the tree as well.
 */
export function classifySpecifier(specifier: string): SpecifierKind {
  if (specifier === '' || specifier === '.' || specifier === '..') return 'relative';
  if (specifier.startsWith('./') || specifier.startsWith('../')) return 'relative';
  if (specifier.startsWith('/') || WINDOWS_PATH.test(specifier)) return 'absolute';
  if (specifier.startsWith('#') || BUILTINS.has(specifier)) return 'inside';
  // Only the lower-case `node:` and `data:` are what Node takes them for. `NODE:fs` is a package name to `require`, which
  // looks it up in the folders above the file; a scheme is compared as written, and anything else is by name.
  const scheme = SCHEME.exec(specifier)?.[0];
  if (scheme === 'node:') return 'inside';
  if (scheme === 'data:') return 'data';
  return scheme?.toLowerCase() === 'file:' ? 'absolute' : 'bare';
}

/**
 * The package a bare specifier names: `@scope/name` or `name`, without the path inside it. A specifier with a
 * scheme (`https://x/a.js`, `npm:left-pad`) is not a package name and is kept whole.
 */
export function packageNameOf(specifier: string): string {
  if (SCHEME.test(specifier)) return specifier;
  const parts = specifier.split('/');
  return specifier.startsWith('@') && parts.length > 1
    ? `${parts[0]}/${parts[1]}`
    : (parts[0] ?? '');
}
