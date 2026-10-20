import { commandWords, pathOf } from './run-words.js';

/**
 * What a file of the repository that a hook runs names in turn: the modules a script imports or
 * requires, the files a shell script sources or calls, the plugins a tool's config names. Not a
 * parser of any language: every quoted string and every import line is taken for a name, so this
 * finds more than runs, never less, for what is written out. A name made at run time (a variable,
 * `importlib.import_module(name)`) is not found; the follow says so where it widens.
 *
 * Every step is a split or one pass over the text, so the work is linear in its length.
 */

/** How the names in a file are read. */
export type Lang = 'js' | 'py' | 'sh' | 'other';

/** The extensions node, tsx, bun and deno try for a name with none, in order. */
export const JS_EXTENSIONS: readonly string[] = [
  '.js',
  '.cjs',
  '.mjs',
  '.jsx',
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.json',
  '.node',
];

const JS_FILE = /\.(?:[cm]?[jt]sx?|json5?|ya?ml|toml)$/i;
const PY_FILE = /\.pyw?$/i;
const SH_FILE = /\.(?:sh|bash|zsh|ksh|dash)$/i;

/** Programs whose file is read as JavaScript, or as Python, when it has no extension. */
export const JS_RUNNERS: ReadonlySet<string> = new Set([
  'node',
  'nodejs',
  'tsx',
  'ts-node',
  'bun',
  'deno',
]);
export const PY_RUNNERS: ReadonlySet<string> = new Set([
  'python',
  'python2',
  'python3',
  'py',
  'pypy',
  'pypy3',
]);
export const SH_RUNNERS: ReadonlySet<string> = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'fish',
  'source',
  '.',
]);

/** How a file is read: by its extension, or else by the program that runs it. */
export function langOf(path: string, runner = ''): Lang {
  if (JS_FILE.test(path)) return 'js';
  if (PY_FILE.test(path)) return 'py';
  if (SH_FILE.test(path)) return 'sh';
  const name = runner.toLowerCase();
  if (JS_RUNNERS.has(name)) return 'js';
  if (PY_RUNNERS.has(name) || /^python[\d.]*$/.test(name)) return 'py';
  if (SH_RUNNERS.has(name) || name === '') return 'sh';
  return 'other';
}

/** The names one file holds. */
export interface References {
  /** Paths, relative to the file or to the folder the command runs in. */
  readonly paths: readonly string[];
  /** Python modules, dotted, with the dots in front of a relative import kept. */
  readonly modules: readonly string[];
  /** Packages by name (`lib`, `@scope/lib/sub`), found in a `node_modules` folder. */
  readonly packages: readonly string[];
  /** True when the file held more names than are read: the follow widens. */
  readonly cut: boolean;
}

/** The most names one file gives the follow; a file with more widens it. */
export const MAX_REFERENCES = 4096;
/** The longest quoted string taken for a name: longer than a path can be is none. */
const MAX_NAME = 4096;

/** The text of each string quoted with `'`, `"` or a backquote, on one line, in order. */
function quotedStrings(text: string): string[] {
  const out: string[] = [];
  let quote = '';
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i] as string;
    if (quote === '') {
      if (c === '"' || c === "'" || c === '`') {
        quote = c;
        start = i + 1;
      }
      continue;
    }
    if (c === '\\') {
      i += 1;
      continue;
    }
    if (c === '\n') {
      quote = '';
      continue;
    }
    if (c === quote) {
      if (i - start <= MAX_NAME) out.push(text.slice(start, i));
      quote = '';
    }
  }
  return out;
}

const PACKAGE = /^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._/-]*)?$/;
const MODULE = /^\.*[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const isPathLike = (s: string): boolean =>
  s.startsWith('./') ||
  s.startsWith('../') ||
  (s.includes('/') && !s.includes('://') && !/\s/.test(s));

/** Each name of an import list (`a as b, c`) as a module of `from`, after a `from ... import`. */
function importedNames(list: string, from: string, into: string[]): void {
  for (const part of list.replace(/[()\\]/g, ' ').split(',')) {
    const name = part.trim().split(/\s+/)[0] ?? '';
    if (name !== '' && name !== '*')
      into.push(from.endsWith('.') ? `${from}${name}` : `${from}.${name}`);
  }
}

/**
 * The modules a Python file imports: `import a.b as c, d` and `from .x import y, z`, statements
 * split at a line's end or a `;`, and a `from x import (` list read on to its `)`.
 */
function pythonImports(text: string): string[] {
  const out: string[] = [];
  let open: string | undefined;
  for (const raw of text.split(/[\n;]/)) {
    const hash = raw.indexOf('#');
    const statement = hash === -1 ? raw : raw.slice(0, hash);
    if (open !== undefined) {
      importedNames(statement, open, out);
      if (statement.includes(')')) open = undefined;
      continue;
    }
    const words = statement.trim().split(/\s+/);
    if (words[0] === 'import') {
      for (const part of words.slice(1).join(' ').split(','))
        out.push(part.trim().split(/\s+/)[0] ?? '');
      continue;
    }
    const from = words[1];
    if (words[0] !== 'from' || from === undefined) continue;
    out.push(from);
    const at = words.indexOf('import');
    if (at === -1) continue;
    const list = words.slice(at + 1).join(' ');
    importedNames(list, from, out);
    if ((list.includes('(') && !list.includes(')')) || list.endsWith('\\')) open = from;
  }
  return out;
}

/** The names a file of the given language holds. */
export function referencesOf(text: string, lang: Lang): References {
  const paths: string[] = [];
  const modules: string[] = [];
  const packages: string[] = [];
  if (lang === 'sh') {
    for (const word of commandWords(text)) {
      const path = pathOf(word);
      if (path !== undefined) paths.push(path);
    }
  } else {
    for (const s of quotedStrings(text)) {
      if (isPathLike(s)) paths.push(s);
      else if (lang === 'js' && PACKAGE.test(s) && !s.startsWith('node:')) packages.push(s);
      if (lang === 'py' && MODULE.test(s)) modules.push(s);
    }
    if (lang === 'py') {
      modules.push(...pythonImports(text).filter((m) => MODULE.test(m)));
    }
  }
  const total = paths.length + modules.length + packages.length;
  const unique = <T>(list: readonly T[]): T[] => [...new Set(list)];
  return {
    paths: unique(paths).slice(0, MAX_REFERENCES),
    modules: unique(modules).slice(0, MAX_REFERENCES),
    packages: unique(packages).slice(0, MAX_REFERENCES),
    cut: total > 3 * MAX_REFERENCES,
  };
}

/**
 * The files a JavaScript runtime may load for `path`: itself, with each extension it tries, the
 * index of a folder by that name, and the folder's package.json, whose `main` can name any file.
 */
export function jsCandidates(path: string): string[] {
  const base = path === '' || path === '.' ? '' : path;
  const own = base === '' ? [] : [base, ...JS_EXTENSIONS.map((ext) => `${base}${ext}`)];
  const index = JS_EXTENSIONS.map((ext) => (base === '' ? `index${ext}` : `${base}/index${ext}`));
  return [...own, ...index, base === '' ? 'package.json' : `${base}/package.json`];
}

/**
 * The files Python may load for a module, from a folder on its path: each package on the way,
 * with its `__init__.py`, and the module as a file or as a package.
 */
export function pyCandidates(module: string, folder: string): string[] {
  const join = (p: string): string => (folder === '' ? p : `${folder}/${p}`);
  const parts = module.split('.');
  const out: string[] = [];
  for (let n = 1; n <= parts.length; n += 1) {
    const path = parts.slice(0, n).join('/');
    out.push(join(`${path}.py`), join(`${path}/__init__.py`));
  }
  out.push(join(`${parts.join('/')}/__main__.py`));
  return out;
}
