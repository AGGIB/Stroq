import type { PythonToken } from './inline-python.js';
import {
  ASSIGNMENT,
  ENVIRONMENTS,
  INERT,
  OPAQUE_ATTRIBUTES,
  OPAQUE_MODULES,
  OPAQUE_NAMES,
  OPENERS,
  OS_MODULES,
  OS_SHELLS,
  OS_STARTS,
  RUNS,
  SHELL_RUNS,
  UNREAD_MODULES,
  UNREAD_STARTS,
  isName,
  isOp,
  isOpaqueDunder,
} from './python-vocabulary.js';

/**
 * What the names of a Python program are bound to, for the reader of the processes it starts
 * (`python-processes.ts`): the modules and functions that start processes, by the names its imports
 * give them, and how many times the rest of the program binds each name, with the string a name is
 * given where that is the only time it is bound.
 */

/** Where each bracket closes, or null when two do not pair (`(]`), which Python does not run. */
export function matching(tokens: readonly PythonToken[]): Map<number, number> | null {
  const stack: number[] = [];
  const found = new Map<number, number>();
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i] as PythonToken;
    if (tok.kind !== 'op') continue;
    if (OPENERS[tok.text] !== undefined) stack.push(i);
    else if (tok.text === ')' || tok.text === ']' || tok.text === '}') {
      const open = stack.pop();
      if (open === undefined || OPENERS[(tokens[open] as PythonToken).text] !== tok.text)
        return null;
      found.set(open, i);
    }
  }
  return stack.length === 0 ? found : null;
}

/** What the import statements bind: the modules and functions that start processes, by the names given them. */
export interface Names {
  readonly subprocess: Set<string>;
  readonly os: Set<string>;
  readonly sys: Set<string>;
  /** A name bound to a `subprocess` function, and the function. */
  readonly runs: Map<string, string>;
  /** A name bound to `os.system` or `os.popen`, and the function. */
  readonly shells: Map<string, string>;
  /** A name bound to `sys.executable`. */
  readonly executables: Set<string>;
  /** A name bound to a function that changes the working directory (`os.chdir`, `contextlib.chdir`). */
  readonly chdirs: Map<string, string>;
  /** Names of the `tempfile` module, and names bound to its `mkdtemp` and `TemporaryDirectory`. */
  readonly tempfiles: Set<string>;
  readonly tempDirs: Map<string, string>;
  /** Every name an import binds. */
  readonly imported: Set<string>;
  /** Every module an import names, dotted (`dvc.config`), or `.` for a relative one. */
  readonly modules: Set<string>;
  /** Token ranges of the import statements, which the reading of calls passes over. */
  readonly spans: Array<readonly [number, number]>;
  /** `from m import *`: the names it binds are not known, nor what a name is given. */
  starImport: boolean;
  unread: boolean;
  opaque: boolean;
}

/** A dotted name `a.b.c` at `i`, and the index after it. */
function dotted(tokens: readonly PythonToken[], i: number): { name: string; next: number } | null {
  if (!isName(tokens[i])) return null;
  let name = (tokens[i] as PythonToken).text;
  let next = i + 1;
  while (isOp(tokens[next], '.') && isName(tokens[next + 1])) {
    name += `.${(tokens[next + 1] as PythonToken).text}`;
    next += 2;
  }
  return { name, next };
}

const rootOf = (module: string): string => module.split('.')[0] ?? module;

function judgeModule(names: Names, module: string): void {
  const root = rootOf(module);
  if (UNREAD_MODULES.has(root)) names.unread = true;
  if (OPAQUE_MODULES.has(root)) names.opaque = true;
}

/** `import a.b as c, d`: from `i` (the `import`), and the index after it. */
function readImport(tokens: readonly PythonToken[], i: number, names: Names): number {
  let at = i + 1;
  for (;;) {
    const module = dotted(tokens, at);
    if (module === null) {
      names.unread = true;
      return at;
    }
    at = module.next;
    let alias = rootOf(module.name);
    let aliased = false;
    if (isName(tokens[at], 'as') && isName(tokens[at + 1])) {
      alias = (tokens[at + 1] as PythonToken).text;
      aliased = true;
      at += 2;
    }
    judgeModule(names, module.name);
    names.modules.add(module.name);
    // `import os.path` binds `os`; `import os.path as p` binds the submodule, which is not `os`.
    const bound = aliased ? module.name : rootOf(module.name);
    if (bound === 'subprocess') names.subprocess.add(alias);
    if (OS_MODULES.has(bound)) names.os.add(alias);
    if (bound === 'sys') names.sys.add(alias);
    if (bound === 'tempfile') names.tempfiles.add(alias);
    names.imported.add(alias);
    if (!isOp(tokens[at], ',')) return at;
    at += 1;
  }
}

/** What `from M import a as b` binds `b` to, for the modules that start processes. */
function bindFrom(names: Names, module: string, name: string, alias: string): void {
  names.imported.add(alias);
  if (name === '*') {
    names.starImport = true;
    if (module === 'subprocess' || OS_MODULES.has(module)) names.unread = true;
    return;
  }
  if (UNREAD_STARTS.has(name)) names.unread = true;
  if (module === 'subprocess') {
    if (RUNS.has(name) || SHELL_RUNS.has(name)) names.runs.set(alias, name);
    else if (!INERT.has(name)) names.unread = true;
  } else if (OS_MODULES.has(module)) {
    if (OS_SHELLS.has(name)) names.shells.set(alias, name);
    else if (OS_STARTS.has(name)) names.unread = true;
    else if (ENVIRONMENTS.has(name) || OPAQUE_ATTRIBUTES.has(name)) names.opaque = true;
  } else if (module === 'sys') {
    if (name === 'executable') names.executables.add(alias);
    else if (name === 'modules') names.opaque = true;
  } else if (module === 'tempfile' && TEMP_DIRS.has(name)) {
    names.tempDirs.set(alias, name);
  }
  if (CHDIRS.has(name) && (OS_MODULES.has(module) || module === 'contextlib'))
    names.chdirs.set(alias, name);
  if (OPAQUE_NAMES.has(name) || isOpaqueDunder(name)) names.opaque = true;
}

/** `from M import a as b, (c, d)` and `from M import *`: from `i` (the `from`), and the index after it. */
function readFrom(tokens: readonly PythonToken[], i: number, names: Names): number {
  const module = dotted(tokens, i + 1);
  // `raise E from e` and `yield from x` are not imports: nothing is bound.
  if (module === null || !isName(tokens[module.next], 'import')) return i + 1;
  judgeModule(names, module.name);
  names.modules.add(module.name);
  let at = module.next + 1;
  const parenthesised = isOp(tokens[at], '(');
  if (parenthesised) at += 1;
  for (;;) {
    const tok = tokens[at];
    const name = isOp(tok, '*') ? '*' : isName(tok) ? (tok as PythonToken).text : null;
    if (name === null) {
      names.unread = true;
      return at;
    }
    at += 1;
    let alias = name;
    if (isName(tokens[at], 'as') && isName(tokens[at + 1])) {
      alias = (tokens[at + 1] as PythonToken).text;
      at += 2;
    }
    bindFrom(names, module.name, name, alias);
    if (!isOp(tokens[at], ',')) break;
    at += 1;
    if (parenthesised && isOp(tokens[at], ')')) break;
  }
  if (parenthesised && isOp(tokens[at], ')')) at += 1;
  return at;
}

export function readImports(tokens: readonly PythonToken[]): Names {
  // `subprocess`, `os` and `sys` are read as the modules even where they are not imported: a program
  // that uses one without importing it fails, and reading it costs nothing. `posix` and `nt` are
  // common words, and are `os` only where an import says so.
  const names: Names = {
    subprocess: new Set(['subprocess']),
    os: new Set(['os']),
    sys: new Set(['sys']),
    runs: new Map(),
    shells: new Map(),
    executables: new Set(),
    chdirs: new Map(),
    tempfiles: new Set(),
    tempDirs: new Map(),
    imported: new Set(),
    modules: new Set(),
    spans: [],
    starImport: false,
    unread: false,
    opaque: false,
  };
  for (let i = 0; i < tokens.length; i += 1) {
    // `from . import x`, `from .m import x`: a module of the program's own package.
    if (isName(tokens[i], 'from') && (isOp(tokens[i + 1], '.') || isOp(tokens[i + 1], '...')))
      names.modules.add('.');
    const isFrom = isName(tokens[i], 'from') && isName(tokens[i + 1]);
    if (!isFrom && !isName(tokens[i], 'import')) continue;
    const end = isFrom ? readFrom(tokens, i, names) : readImport(tokens, i, names);
    if (end > i + 1) names.spans.push([i, end]);
    i = Math.max(i, end - 1);
  }
  return names;
}

/** How many times the program binds each name outside its imports, and the string a name is given. */
export interface Bindings {
  readonly counts: ReadonlyMap<string, number>;
  /** A name a statement of its own gives a string (`flag = '-v'`), by that string. */
  readonly literals: ReadonlyMap<string, string>;
  /**
   * A name given a new temporary directory, empty when it is made (`d = tempfile.mkdtemp()`, `with
   * tempfile.TemporaryDirectory() as d`), or the directory the program started in (`old = os.getcwd()`),
   * by what made it (the name before the dot, if any, and the function) and how many times it was given
   * one that way (`times`, -1 where two of them were made differently).
   */
  readonly temporaryDirectories: ReadonlyMap<
    string,
    { readonly owner: string | null; readonly fn: string; readonly times: number }
  >;
}

/** Functions that change the working directory. */
export const CHDIRS = new Set(['chdir', 'fchdir']);
/** Functions of `tempfile` that make a new directory. */
const TEMP_DIRS = new Set(['mkdtemp', 'TemporaryDirectory']);

/**
 * `X.fn()` or `fn()` at `at`, called with nothing: the function and the name before it, or null.
 * Nothing given means no `dir=` and no prefix, so the directory is a new one under the system's own.
 */
function emptyCall(
  tokens: readonly PythonToken[],
  at: number,
): { readonly owner: string | null; readonly fn: string; readonly end: number } | null {
  const dotted = isName(tokens[at]) && isOp(tokens[at + 1], '.') && isName(tokens[at + 2]);
  const fnAt = dotted ? at + 2 : at;
  if (!isName(tokens[fnAt]) || !isOp(tokens[fnAt + 1], '(') || !isOp(tokens[fnAt + 2], ')'))
    return null;
  return {
    owner: dotted ? (tokens[at] as PythonToken).text : null,
    fn: (tokens[fnAt] as PythonToken).text,
    end: fnAt + 3,
  };
}

/** Keywords that a colon follows at the start of a statement, which is not an annotation. */
const COLON_KEYWORDS = new Set(['else', 'try', 'finally', 'lambda']);
/** Statements whose words up to the end of the line are names they bind. */
const NAME_LISTS = new Set(['global', 'nonlocal', 'del', 'lambda', 'case']);

/**
 * The names the program binds outside its imports, and how many times: an assignment's target (with
 * the last name of an attribute, so that `os.system = f` and `sys.executable = x` count), an
 * annotated name, a `for` target, what follows `as`, `def` or `class`, the names of `global`,
 * `nonlocal`, `del`, `lambda` and `case`, and a parameter. A keyword argument (`run(shell=True)`) is
 * inside brackets, and is not one; a name that is the start of an attribute, an item or a call
 * (`sys.argv = x`, `del sys.modules[k]`, `d[k] = v`) is what is changed, and is not bound again.
 */
export function bindingsOutsideImports(
  tokens: readonly PythonToken[],
  match: ReadonlyMap<number, number>,
  skip: (i: number) => boolean,
): Bindings {
  const counts = new Map<string, number>();
  const literals = new Map<string, string>();
  const temporaryDirectories = new Map<
    string,
    { owner: string | null; fn: string; times: number }
  >();
  const madeBy = (name: string, made: { owner: string | null; fn: string }): void => {
    const before = temporaryDirectories.get(name);
    const same = before === undefined || (before.owner === made.owner && before.fn === made.fn);
    temporaryDirectories.set(name, {
      owner: made.owner,
      fn: made.fn,
      times: !same || before?.times === -1 ? -1 : (before?.times ?? 0) + 1,
    });
  };
  const bump = (name: string): void => {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  };
  const mark = (at: number): void => {
    const tok = tokens[at];
    const next = tokens[at + 1];
    if (tok === undefined || tok.kind !== 'name') return;
    if (isOp(next, '.') || isOp(next, '[') || isOp(next, '(')) return;
    bump(tok.text);
  };
  // The depth of brackets before each token, read once so that a statement can be skipped over.
  const depthAt = new Int32Array(tokens.length + 1);
  for (let i = 0, depth = 0; i < tokens.length; i += 1) {
    const tok = tokens[i] as PythonToken;
    depthAt[i] = depth;
    if (tok.kind === 'op' && OPENERS[tok.text] !== undefined) depth += 1;
    else if (tok.kind === 'op' && ')]}'.includes(tok.text)) depth -= 1;
  }
  const startsStatement = (at: number): boolean => {
    const before = tokens[at - 1];
    return (
      before === undefined ||
      before.kind === 'nl' ||
      isOp(before, ';') ||
      (isOp(before, ':') && depthAt[at - 1] === 0)
    );
  };
  const endsStatement = (at: number): boolean => {
    const tok = tokens[at];
    return tok === undefined || tok.kind === 'nl' || isOp(tok, ';');
  };
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i] as PythonToken;
    if (skip(i)) continue;
    if (tok.kind === 'op' && ASSIGNMENT.has(tok.text) && (depthAt[i] === 0 || tok.text === ':=')) {
      const value = tokens[i + 1];
      // `flag = '-v'`, and `flag: str = '-v'`, where the name before the colon is what is bound.
      const annotated = isOp(tokens[i - 2], ':') && isName(tokens[i - 3]) && startsStatement(i - 3);
      const at = annotated ? i - 3 : i - 1;
      if (
        tok.text === '=' &&
        isName(tokens[at]) &&
        isName(tokens[i - 1]) &&
        (annotated || startsStatement(at)) &&
        value?.kind === 'str' &&
        value.value !== undefined &&
        endsStatement(i + 2)
      )
        literals.set((tokens[at] as PythonToken).text, value.value);
      // `d = tempfile.mkdtemp()`: a new, empty directory.
      const made =
        tok.text === '=' && isName(tokens[i - 1]) && startsStatement(i - 1)
          ? emptyCall(tokens, i + 1)
          : null;
      // `old = os.getcwd()`: the directory the program started in, to go back to.
      if (
        made !== null &&
        (made.fn === 'mkdtemp' || made.fn === 'getcwd') &&
        endsStatement(made.end)
      )
        madeBy((tokens[i - 1] as PythonToken).text, made);
      for (let j = i - 1; j >= 0; j -= 1) {
        const before = tokens[j] as PythonToken;
        if (before.kind === 'name') mark(j);
        else if (before.kind !== 'op' || !',()[]*.'.includes(before.text)) break;
      }
    } else if (isName(tok, 'for')) {
      let j = i + 1;
      for (; j < tokens.length; j += 1) {
        const next = tokens[j] as PythonToken;
        if (isName(next, 'in') || isName(next, 'for') || next.kind === 'nl' || isOp(next, ':'))
          break;
        mark(j);
      }
      i = j - 1;
    } else if (tok.kind === 'name' && (tok.text === 'as' || tok.text === 'class')) {
      // `with ctx() as (a, b):` binds every name of the target.
      const close =
        isOp(tokens[i + 1], '(') || isOp(tokens[i + 1], '[') ? match.get(i + 1) : undefined;
      if (close !== undefined) for (let j = i + 2; j < close; j += 1) mark(j);
      else if (isName(tokens[i + 1])) bump((tokens[i + 1] as PythonToken).text);
    } else if (isName(tok, 'with')) {
      // `with tempfile.TemporaryDirectory() as d:`: `d` is a new, empty directory.
      const made = emptyCall(tokens, i + 1);
      if (
        made !== null &&
        made.fn === 'TemporaryDirectory' &&
        isName(tokens[made.end], 'as') &&
        isName(tokens[made.end + 1])
      )
        madeBy((tokens[made.end + 1] as PythonToken).text, made);
    } else if (isName(tok, 'def')) {
      if (isName(tokens[i + 1])) bump((tokens[i + 1] as PythonToken).text);
      const close = isOp(tokens[i + 2], '(') ? match.get(i + 2) : undefined;
      if (close !== undefined) {
        for (let j = i + 3; j < close; j += 1) mark(j);
        i = close;
      }
    } else if (tok.kind === 'name' && NAME_LISTS.has(tok.text)) {
      // To the end of the statement or the colon of this level: `case {'k': v}:` binds `v`, past the
      // colon of the mapping, and `lambda x={1: 2}: x` has its parameters up to its own colon.
      let j = i + 1;
      for (; j < tokens.length; j += 1) {
        const next = tokens[j] as PythonToken;
        if (next.kind === 'nl' || isOp(next, ';') || (isOp(next, ':') && depthAt[j] === depthAt[i]))
          break;
        if (next.kind === 'name' && NAME_LISTS.has(next.text)) break;
        mark(j);
      }
      i = j - 1;
    } else if (
      tok.kind === 'name' &&
      isOp(tokens[i + 1], ':') &&
      depthAt[i] === 0 &&
      startsStatement(i) &&
      !COLON_KEYWORDS.has(tok.text)
    ) {
      // `flag: str = '-v'` binds `flag`, and so does `flag: str` alone.
      bump(tok.text);
    }
  }
  return { counts, literals, temporaryDirectories };
}
