// Whether the code of an MCP server can be held by the pin: does it only ask for what is in its tree?
//
// The pin hashes the files of a server, copies them to a private folder and runs the copy. Node finds a
// package that a file asks for by name in the folders above that file, and above the private copy are
// folders that no digest covers (`<stroq home>/run`, `<stroq home>`, the home folder). So a server that
// asks for a package by name runs, from the confirmed bytes, whatever code is at that name on the day it
// is started. A server can only be pinned when everything it loads is in the tree: written as one file,
// or with what it needs copied into the tree and asked for by a relative path.
//
// This is a best-effort reading of text, and it fails closed. It lists what it can read; for every file
// it cannot read with certainty (too large for the budget, not text, a doubt of the lexer, a module asked
// for by a name built at run time, `createRequire`, `eval`, a file Node would run through a loader) it
// records a concern, and a concern is treated like a package that is not in the tree. The real protection
// is the other layers: a server that lists dependencies is refused, the folder of the private copies is
// write-protected for a sandboxed agent, and the pin itself is tamper-evident and not a proof that no import
// escapes.
import { posix } from 'node:path';
import type { ArtifactKind, Tree, TreeEntry } from '../types.js';
import { Findings } from './findings.js';
import { buildInput, type InspectInput } from './input.js';
import {
  classifySpecifier,
  packageNameOf,
  scanModules,
  type Concern,
  type Note,
} from './module-specifiers.js';
import { hasPackageScope, nestedManifestConcerns, readManifest } from './package-reach.js';

/** The most package names and files one tree is reported for. */
export const MAX_MODULES = 50;
const MAX_FILES_PER_CONCERN = 5;
/** The most text, in bytes, that one tree is read for; a file past it is a concern. The tree limit is 32 MiB. */
export const SCAN_BUDGET_BYTES = 24 * 1024 * 1024;
const NODE_FILE = /\.(?:js|mjs|cjs)$/i;
const IN_MODULES = /(?:^|\/)node_modules\//i;
/** The extensions that Node loads as code or data without a loader. A `.json` is data and loads nothing. */
const LOADED_BY_NODE: ReadonlySet<string> = new Set(['.js', '.mjs', '.cjs', '.json']);
/** Modules of Node that run code from text. */
const RUNS_TEXT: ReadonlySet<string> = new Set(['vm', 'node:vm']);

/** What a reading could not settle in a file, beyond what the scanner says of its text. */
export type ImportsConcern = Concern | 'loader' | 'outside' | 'unreadable' | 'budget';

export const CONCERN_PHRASES: Readonly<Record<ImportsConcern, string>> = {
  doubt: 'its text could not be read with certainty',
  computed: 'it requests a module by a name built at run time, or uses require as a value',
  'dynamic-code':
    'it loads or builds code in a way that has no module name in the text (createRequire, process.binding, eval, new Function, vm)',
  escaped: 'it writes a module name with escapes',
  loader:
    'it loads a file that Node runs natively or through a loader (.node, .wasm, .ts, a file with no extension)',
  outside:
    'it names a place outside the tree (an absolute path, a path that climbs out of the tree, an entry of package.json that points out)',
  unreadable: 'it could not be read as text',
  budget: 'it is past the amount of text the reading takes',
};

/** One file with a concern: where, and what the reading saw there when it can say. */
export interface ConcernedFile {
  readonly path: string;
  readonly reason?: string;
  readonly line?: number;
}

export interface ConcernedFiles {
  readonly concern: ImportsConcern;
  /** Paths of the tree, at most a few. */
  readonly files: readonly string[];
  /** The same files, with the reason and the line of the first place. */
  readonly details: readonly ConcernedFile[];
}

export interface OutsideImports {
  /** The fields of the package.json that list dependencies, by name. */
  readonly declared: readonly string[];
  /** Packages that files of the tree ask for by name and that the tree does not hold, sorted. */
  readonly modules: readonly string[];
  /** What could not be read with certainty, by concern, sorted. */
  readonly concerns: readonly ConcernedFiles[];
}

export interface ReadOptions {
  /** The bytes of text the reading takes; only a test says. */
  readonly budgetBytes?: number;
}

/** Every folder that holds an entry of the tree, as `a/b` for `a/b/c.js`: `node_modules/x` is "there" when it is in this set. */
function foldersOf(paths: Iterable<string>): Set<string> {
  const folders = new Set<string>();
  for (const path of paths) {
    for (
      let at = posix.dirname(path);
      at !== '.' && at !== '/' && !folders.has(at);
      at = posix.dirname(at)
    )
      folders.add(at);
  }
  return folders;
}

/** Whether `node_modules/<name>` is in the tree in a folder above the file `from`, which is where Node would look. */
function heldAbove(name: string, from: string, folders: ReadonlySet<string>): boolean {
  for (let dir = posix.dirname(from); ; dir = posix.dirname(dir)) {
    const base = dir === '.' ? '' : `${dir}/`;
    if (folders.has(`${base}node_modules/${name}`)) return true;
    if (dir === '.' || dir === '/') return false;
  }
}

/** Where a relative specifier lands in the tree, or null when it climbs out of the root. */
function landing(from: string, specifier: string): string | null {
  const joined = posix.normalize(posix.join(posix.dirname(from), specifier));
  return joined === '..' || joined.startsWith('../') ? null : joined;
}

interface Context {
  readonly folders: ReadonlySet<string>;
  readonly self: string | null;
  /** The paths of the links and nested repositories of the tree. */
  readonly links: ReadonlySet<string>;
}

interface Detail {
  readonly reason?: string;
  readonly line?: number;
}

/** What is found, built up as the files are read: the first detail of each file under each concern. */
class Reading {
  readonly modules = new Set<string>();
  private readonly concerns = new Map<ImportsConcern, Map<string, Detail>>();

  note(concern: ImportsConcern, path: string, detail: Detail = {}): void {
    const files = this.concerns.get(concern) ?? new Map<string, Detail>();
    if (!files.has(path)) files.set(path, detail);
    this.concerns.set(concern, files);
  }

  result(declared: readonly string[]): OutsideImports {
    return {
      declared,
      modules: [...this.modules].sort().slice(0, MAX_MODULES),
      concerns: [...this.concerns]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([concern, files]) => {
          const shown = [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
          const details = shown
            .slice(0, MAX_FILES_PER_CONCERN)
            .map(([path, detail]) => ({ path, ...detail }));
          return { concern, files: details.map((d) => d.path), details };
        }),
    };
  }
}

/** The text of a file of the tree, or null when it is not valid UTF-8 text. */
function textOf(entry: TreeEntry): string | null {
  if (entry.bytes === undefined) return null;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(entry.bytes);
    return text.includes('\u0000') ? null : text;
  } catch {
    return null;
  }
}

/** A relative specifier: does it name a file Node loads on its own, and does it stay in the tree. */
function checkRelative(
  reading: Reading,
  path: string,
  specifier: string,
  input: InspectInput,
  links: ReadonlySet<string>,
): void {
  const paths = input.paths;
  // A `%` is decoded by a URL: `./%2e%2e/x` climbs out of the tree in an ES module.
  if (specifier.includes('%'))
    return reading.note('outside', path, { reason: 'a relative path holds a % escape' });
  const target = landing(path, specifier);
  if (target === null)
    return reading.note('outside', path, { reason: 'a relative path climbs out of the tree' });
  // A link is never followed: Node would, and what it leads to is not in the tree.
  const suffixes = ['', '.js', '.mjs', '.cjs', '.json', '.node', '/index.js'];
  if (suffixes.some((suffix) => links.has(`${target}${suffix}`)))
    return reading.note('outside', path, { reason: 'a relative path leads to a link' });
  const ext = posix.extname(target).toLowerCase();
  if (LOADED_BY_NODE.has(ext)) return;
  // Node tries the name, then the name with `.js`, `.json` and `.node`; a file of another kind that it finds is
  // run as JavaScript or loaded as native code, and neither is read here.
  const withSuffix = (suffix: string): boolean => paths.has(`${target}${suffix}`);
  if (
    paths.has(target) ||
    withSuffix('.node') ||
    (ext !== '' && !withSuffix('.js') && !withSuffix('.json'))
  )
    reading.note('loader', path, {
      reason: 'a relative path names a file Node does not read as a script',
    });
}

function readSpecifier(
  reading: Reading,
  path: string,
  specifier: string,
  input: InspectInput,
  context: Context,
): void {
  if (RUNS_TEXT.has(specifier))
    return reading.note('dynamic-code', path, {
      reason: 'loads the vm module, which runs code from text',
    });
  switch (classifySpecifier(specifier)) {
    case 'absolute':
      return reading.note('outside', path, { reason: 'an import names a path outside the tree' });
    case 'data':
      return reading.note('dynamic-code', path, {
        reason: 'a data: URL is the text of a module, which can import any URL',
      });
    case 'relative':
      return checkRelative(reading, path, specifier, input, context.links);
    case 'bare': {
      const name = packageNameOf(specifier);
      if (name !== context.self && !heldAbove(name, path, context.folders))
        reading.modules.add(name);
      return;
    }
    case 'inside':
      // A `#name` is resolved through the nearest package.json; with none in the tree, through one above it.
      if (specifier.startsWith('#') && !hasPackageScope(path, input.paths))
        reading.note('outside', path, {
          reason: 'a # import is resolved through a package.json above the tree',
        });
  }
}

function readFile(reading: Reading, entry: TreeEntry, input: InspectInput, context: Context): void {
  try {
    const text = textOf(entry);
    if (text === null)
      return reading.note('unreadable', entry.path, { reason: 'not valid UTF-8 text' });
    const scan = scanModules(text);
    for (const note of scan.notes) reading.note(note.concern, entry.path, detailOf(note));
    for (const specifier of scan.specifiers)
      readSpecifier(reading, entry.path, specifier, input, context);
  } catch {
    // Whatever the fault was, the file was not read, and that is what the passport says.
    reading.note('unreadable', entry.path, { reason: 'the reading of the file failed' });
  }
}

const detailOf = (note: Note): Detail => ({ reason: note.reason, line: note.line });

/** What the files of the tree ask for that the tree does not hold, and what could not be read. */
function readTree(input: InspectInput, options: ReadOptions): OutsideImports {
  const manifest = readManifest(input);
  const context: Context = {
    folders: foldersOf(input.paths),
    self: manifest.self,
    links: new Set(input.tree.entries.filter((e) => e.kind !== 'file').map((e) => e.path)),
  };
  const reading = new Reading();
  if (manifest.concern !== null)
    reading.note(manifest.concern, 'package.json', {
      reason: 'package.json points out of the tree',
    });
  for (const { concern, path } of nestedManifestConcerns(input))
    reading.note(concern, path, { reason: 'package.json points out of the tree' });
  // A link in the tree is never followed, and what a link to a script stands for was not read.
  for (const entry of input.tree.entries)
    if (entry.kind !== 'file' && NODE_FILE.test(entry.path))
      reading.note('outside', entry.path, { reason: 'a link to a script is not followed' });
  let budget = options.budgetBytes ?? SCAN_BUDGET_BYTES;
  for (const entry of input.tree.entries) {
    if (entry.kind !== 'file' || !NODE_FILE.test(entry.path) || IN_MODULES.test(entry.path))
      continue;
    budget -= entry.size;
    if (budget < 0) reading.note('budget', entry.path);
    else readFile(reading, entry, input, context);
  }
  return reading.result(manifest.fields);
}

/** The reading of a tree is made once: `vet` and `add` ask for it of the same tree. */
const made = new WeakMap<Tree, OutsideImports>();

/** What the files of the tree ask for that the tree does not hold, and what could not be read. */
export function outsideImports(input: InspectInput, options: ReadOptions = {}): OutsideImports {
  if (options.budgetBytes !== undefined) return readTree(input, options);
  const known = made.get(input.tree);
  if (known !== undefined) return known;
  const read = readTree(input, options);
  made.set(input.tree, read);
  return read;
}

export const hasOutsideImports = (found: OutsideImports): boolean =>
  found.declared.length > 0 || found.modules.length > 0 || found.concerns.length > 0;

/** For the readings of a passport: an MCP server whose code the pin cannot hold says so as a blind spot. */
export function inspectImports(input: InspectInput, findings: Findings, kind: ArtifactKind): void {
  if (kind !== 'mcp') return;
  if (hasOutsideImports(outsideImports(input))) findings.tally('outside-imports');
}

/** The same reading of a tree that is not being inspected, for the command that refuses an install. */
export function outsideImportsOfTree(tree: Tree, options: ReadOptions = {}): OutsideImports {
  if (options.budgetBytes === undefined) {
    const known = made.get(tree);
    if (known !== undefined) return known;
  }
  return outsideImports(buildInput(tree, new Findings()), options);
}
