// The modules a JavaScript file asks for, and whether the file can be read for them with certainty.
//
// Whether a server's code can be pinned depends on this: Node looks a package up by name in folders above the
// file that asks, and what it finds there is not among the bytes that were confirmed. So the names are read
// from the text, without running it, with the lexer of `js-lexer.ts`.
//
// The reading is best-effort and is built to say so. It lists the specifiers it can read (`import 'x'`,
// `import ... from 'x'`, `export ... from 'x'`, `require('x')` and `import('x')` with a string written out),
// and it names a *concern* for everything it cannot settle: a text it could not lex with certainty, a module
// requested by a name built at run time, a way of loading code that has no name in the text (`createRequire`,
// `process.binding`, `eval`, `new Function`, `require` used as a value), a name written with escapes. A file
// with a concern is a file whose imports are not known, and the caller treats it as one that may load code
// from outside its tree.
import { builtinModules } from 'node:module';
import { Lexer, type Token } from './js-lexer.js';

/** The most distinct specifiers one file is read for; a file with more is a concern. */
export const MAX_SPECIFIERS = 2000;
/** The most tokens an import or export clause may take before it is given up as something else. */
const MAX_CLAUSE_TOKENS = 2000;

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

export interface ModuleScan {
  /** The specifiers asked for, each once, in the order they first appear. */
  readonly specifiers: readonly string[];
  /** Why the file is not fully read, sorted; empty when it is. */
  readonly concerns: readonly Concern[];
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
  | { readonly at: 'from' }
  | { readonly at: 'function' }
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
  readonly concern?: Concern;
  /** The token must be read again in the new state. */
  readonly again?: true;
}

/** What follows `import` or `export` when it starts a clause that ends in `from 'x'`. */
function clauseStep(state: ClauseState, token: Token): State | 'abort' {
  const used = state.used + 1;
  if (used > MAX_CLAUSE_TOKENS) return 'abort';
  if (token.kind === 'word' && state.depth === 0 && token.text === 'from') return { at: 'from' };
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
  return token.escaped === true
    ? { state: IDLE, concern: 'escaped' }
    : after.at === 'callEnd'
      ? { state: after }
      : { state: IDLE, found: token.text };
}

function stepRequest(state: State, token: Token): Step | null {
  switch (state.at) {
    case 'call':
      return token.kind === 'string'
        ? named(token, { at: 'callEnd', specifier: token.text })
        : { state: IDLE, concern: 'computed', again: true };
    case 'callEnd':
      // `require('a' + b)` names no module: the string is closed by `)`, or by `,` before options.
      return isPunct(token, ')') || isPunct(token, ',')
        ? { state: IDLE, found: state.specifier }
        : { state: IDLE, concern: 'computed', again: true };
    case 'from':
      return token.kind === 'string' ? named(token, IDLE) : { state: IDLE, again: true };
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
        : { state: IDLE, concern: 'computed', again: true };
    case 'requireMember':
      if (isWord(token, 'main')) return { state: IDLE };
      return isWord(token, 'resolve')
        ? { state: { at: 'resolve' } }
        : { state: IDLE, concern: 'computed', again: true };
    case 'resolve':
      return isPunct(token, '(')
        ? { state: { at: 'call' } }
        : { state: IDLE, concern: 'computed', again: true };
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

/**
 * A word that is a concern on its own, wherever it stands (an import clause included): a way of loading or
 * building code that leaves no module name in the text.
 */
function wordConcern(token: Token, before: Token | null, beforeThat: Token | null): Concern | null {
  if (token.kind !== 'word') return null;
  const member = isPunct(before, '.');
  switch (token.text) {
    case 'createRequire':
    case '_load':
    case '_resolveFilename':
      return 'dynamic-code';
    case 'eval':
      return member ? null : 'dynamic-code';
    case 'Function':
      return !member && isWord(before, 'new') ? 'dynamic-code' : null;
    case 'binding':
    case 'dlopen':
      return member && isWord(beforeThat, 'process') ? 'dynamic-code' : null;
    case 'resolve':
      return member && isWord(beforeThat, 'meta') ? 'computed' : null;
    default:
      return null;
  }
}

/** A word that starts something: the next state. */
function stepIdle(token: Token, before: Token | null): Step {
  if (token.kind !== 'word') return { state: IDLE };
  const member = isPunct(before, '.');
  switch (token.text) {
    case 'require':
      return { state: { at: 'require', guarded: isWord(before, 'typeof') } };
    case 'import':
      return member ? { state: IDLE } : { state: { at: 'import' } };
    case 'export':
      return member ? { state: IDLE } : { state: { at: 'export' } };
    case 'Function':
      return member || isWord(before, 'new') ? { state: IDLE } : { state: { at: 'function' } };
    default:
      return { state: IDLE };
  }
}

function step(state: State, token: Token, before: Token | null): Step {
  if (state.at === 'function')
    return isPunct(token, '(')
      ? { state: IDLE, concern: 'dynamic-code' }
      : { state: IDLE, again: true };
  return (
    stepRequest(state, token) ??
    stepRequire(state, token) ??
    stepImport(state, token) ??
    stepIdle(token, before)
  );
}

/** Reads the text of one JavaScript file for the modules it asks for, and for what it does not let be read. */
export function scanModules(text: string, limit = MAX_SPECIFIERS): ModuleScan {
  const lexer = new Lexer(text);
  const found = new Set<string>();
  const concerns = new Set<Concern>();
  let state: State = IDLE;
  let before: Token | null = null;
  let beforeThat: Token | null = null;
  for (let token = lexer.next(); token !== null; token = lexer.next()) {
    const own = wordConcern(token, before, beforeThat);
    if (own !== null) concerns.add(own);
    let result = step(state, token, before);
    if (result.concern !== undefined) concerns.add(result.concern);
    if (result.again === true) {
      result = step(result.state, token, before);
      if (result.concern !== undefined) concerns.add(result.concern);
    }
    state = result.state;
    if (result.found !== undefined) found.add(result.found);
    beforeThat = before;
    before = token;
    if (found.size > limit) {
      concerns.add('doubt');
      break;
    }
  }
  // The text ended in the middle of something that asks for a module: `require` and a bracket, nothing more.
  if (['call', 'callEnd', 'requireMember', 'resolve'].includes(state.at)) concerns.add('computed');
  if (state.at === 'require' && !state.guarded) concerns.add('computed');
  if (lexer.doubt !== null) concerns.add('doubt');
  return { specifiers: [...found].slice(0, limit), concerns: [...concerns].sort() };
}

/** The specifiers of a text, for a caller that wants only those. */
export const moduleSpecifiers = (text: string, limit = MAX_SPECIFIERS): string[] => [
  ...scanModules(text, limit).specifiers,
];

const BUILTINS: ReadonlySet<string> = new Set(builtinModules);
/** A drive letter or a backslash start: a path on Windows, which Node reads as one. */
const WINDOWS_PATH = /^(?:[A-Za-z]:[\\/]|\\)/;
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
  /** Node's own, or `data:`, or a `#` import that the package maps itself. */
  | 'inside';

export function classifySpecifier(specifier: string): SpecifierKind {
  if (specifier === '' || specifier === '.' || specifier === '..') return 'relative';
  if (specifier.startsWith('./') || specifier.startsWith('../')) return 'relative';
  if (specifier.startsWith('/') || WINDOWS_PATH.test(specifier)) return 'absolute';
  if (specifier.startsWith('#') || BUILTINS.has(specifier)) return 'inside';
  const scheme = SCHEME.exec(specifier)?.[0]?.toLowerCase();
  if (scheme === 'node:' || scheme === 'data:') return 'inside';
  return scheme === 'file:' ? 'absolute' : 'bare';
}

/**
 * Whether Node looks the specifier up by name in folders above the file that asks. A scheme that Node
 * cannot load (`https:`) or that belongs to another runtime (`npm:`) is counted: its code comes from outside
 * the tree as well.
 */
export const isBareSpecifier = (specifier: string): boolean =>
  classifySpecifier(specifier) === 'bare';

/** The package a bare specifier names: `@scope/name` or `name`, without the path inside it. */
export function packageNameOf(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') && parts.length > 1
    ? `${parts[0]}/${parts[1]}`
    : (parts[0] ?? '');
}
