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
import { entriesOf, isObject, own, ownObject, ownString, parseJsonObject } from './json.js';
import type { JsonObject } from './json.js';
import {
  classifySpecifier,
  packageNameOf,
  scanModules,
  type Concern,
} from './module-specifiers.js';

/** The fields of a package.json that name what must be installed for the package to run. */
const RUNTIME_DEPENDENCY_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies'];
/** The most package names and files one tree is reported for. */
export const MAX_MODULES = 50;
const MAX_FILES_PER_CONCERN = 5;
/** The most text, in bytes, that one tree is read for; a file past it is a concern. The tree limit is 32 MiB. */
export const SCAN_BUDGET_BYTES = 24 * 1024 * 1024;
const NODE_FILE = /\.(?:js|mjs|cjs)$/i;
const IN_MODULES = /(?:^|\/)node_modules\//;
/** The extensions that Node loads as code or data without a loader. A `.json` is data and loads nothing. */
const LOADED_BY_NODE: ReadonlySet<string> = new Set(['.js', '.mjs', '.cjs', '.json']);
const WINDOWS_PATH = /^(?:[A-Za-z]:[\\/]|\\)/;
const MANIFEST_LEAVES_MAX = 1000;
const MANIFEST_DEPTH_MAX = 10;

/** What a reading could not settle in a file, beyond what the scanner says of its text. */
export type ImportsConcern = Concern | 'loader' | 'outside' | 'unreadable' | 'budget';

export const CONCERN_PHRASES: Readonly<Record<ImportsConcern, string>> = {
  doubt: 'its text could not be read with certainty',
  computed: 'it requests a module by a name built at run time, or uses require as a value',
  'dynamic-code':
    'it loads or builds code in a way that has no module name in the text (createRequire, process.binding, eval, new Function)',
  escaped: 'it writes a module name with escapes',
  loader:
    'it loads a file that Node runs natively or through a loader (.node, .wasm, .ts, a file with no extension)',
  outside:
    'it names a place outside the tree (an absolute path, a path that climbs out of the tree, an entry of package.json that points out)',
  unreadable: 'it could not be read as text',
  budget: 'it is past the amount of text the reading takes',
};

export interface ConcernedFiles {
  readonly concern: ImportsConcern;
  /** Paths of the tree, at most a few. */
  readonly files: readonly string[];
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

interface Manifest {
  /** The fields that list dependencies. */
  readonly fields: string[];
  /** The package's own name when it says how it may be asked for by that name (`exports`), else null. */
  readonly self: string | null;
  /** Something in it points out of the tree, or could not be read. */
  readonly concern: ImportsConcern | null;
}

const pointsOut = (target: string, mustStartInside: boolean): boolean => {
  const segments = target.split(/[\\/]/);
  return (
    target.startsWith('/') ||
    WINDOWS_PATH.test(target) ||
    segments.includes('..') ||
    segments.includes('node_modules') ||
    (mustStartInside && !target.startsWith('./'))
  );
};

/** The strings at the leaves of `exports` or `imports`, with a flag when the walk was cut. */
function leavesOf(value: unknown): { leaves: string[]; cut: boolean } {
  const leaves: string[] = [];
  let cut = false;
  const walk = (node: unknown, depth: number): void => {
    if (typeof node === 'string') leaves.push(node);
    else if (depth >= MANIFEST_DEPTH_MAX || leaves.length > MANIFEST_LEAVES_MAX) cut = true;
    else if (Array.isArray(node)) for (const item of node) walk(item, depth + 1);
    else if (isObject(node)) for (const [, item] of entriesOf(node)) walk(item, depth + 1);
  };
  walk(value, 0);
  return { leaves, cut };
}

function manifestPointsOut(manifest: JsonObject): ImportsConcern | null {
  const direct = ['main', 'module'].map((key) => ownString(manifest, key));
  const bin = own(manifest, 'bin');
  const bins = typeof bin === 'string' ? [bin] : isObject(bin) ? Object.values(bin) : [];
  const mapped = ['exports', 'imports'].map((key) => leavesOf(own(manifest, key)));
  if (mapped.some((m) => m.cut)) return 'doubt';
  const outside =
    [...direct, ...bins.filter((v): v is string => typeof v === 'string')].some(
      (target) => target !== null && pointsOut(target, false),
    ) ||
    // `imports` may map a name to another package (`"#dep": "some-package"`) or to Node's own (`node:fs`).
    mapped.some((m, i) =>
      m.leaves.some(
        (target) => !(i === 1 && target.startsWith('node:')) && pointsOut(target, true),
      ),
    );
  return outside ? 'outside' : null;
}

function readManifest(input: InspectInput): Manifest {
  const file = input.byPath.get('package.json');
  if (file === undefined) {
    // A package.json that is in the tree and is not text is not a manifest that can be read.
    const present = input.paths.has('package.json');
    return { fields: [], self: null, concern: present ? 'unreadable' : null };
  }
  const manifest = parseJsonObject(file.text);
  if (manifest === null) return { fields: [], self: null, concern: 'unreadable' };
  const fields = RUNTIME_DEPENDENCY_FIELDS.filter((field) => {
    const group = ownObject(manifest, field);
    return group !== null && entriesOf(group).length > 0;
  });
  const self = own(manifest, 'exports') === undefined ? null : ownString(manifest, 'name');
  return { fields, self, concern: manifestPointsOut(manifest) };
}

interface Reading {
  readonly modules: Set<string>;
  readonly concerns: Map<ImportsConcern, Set<string>>;
}

const note = (reading: Reading, concern: ImportsConcern, path: string): void => {
  const files = reading.concerns.get(concern) ?? new Set<string>();
  files.add(path);
  reading.concerns.set(concern, files);
};

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
  paths: ReadonlySet<string>,
): void {
  const target = landing(path, specifier);
  if (target === null) return note(reading, 'outside', path);
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
    note(reading, 'loader', path);
}

function readSpecifiers(
  reading: Reading,
  path: string,
  specifiers: readonly string[],
  input: InspectInput,
  context: { folders: ReadonlySet<string>; self: string | null },
): void {
  for (const specifier of specifiers) {
    const kind = classifySpecifier(specifier);
    if (kind === 'absolute') note(reading, 'outside', path);
    else if (kind === 'relative') checkRelative(reading, path, specifier, input.paths);
    else if (kind === 'bare') {
      const name = packageNameOf(specifier);
      if (name !== context.self && !heldAbove(name, path, context.folders))
        reading.modules.add(name);
    }
  }
}

function readFile(
  reading: Reading,
  entry: TreeEntry,
  input: InspectInput,
  context: { folders: ReadonlySet<string>; self: string | null },
): void {
  try {
    const text = textOf(entry);
    if (text === null) return note(reading, 'unreadable', entry.path);
    const scan = scanModules(text);
    for (const concern of scan.concerns) note(reading, concern, entry.path);
    readSpecifiers(reading, entry.path, scan.specifiers, input, context);
  } catch {
    // Whatever the fault was, the file was not read, and that is what the passport says.
    note(reading, 'unreadable', entry.path);
  }
}

/** What the files of the tree ask for that the tree does not hold, and what could not be read. */
export function outsideImports(input: InspectInput, options: ReadOptions = {}): OutsideImports {
  const manifest = readManifest(input);
  const context = { folders: foldersOf(input.paths), self: manifest.self };
  const reading: Reading = { modules: new Set(), concerns: new Map() };
  if (manifest.concern !== null) note(reading, manifest.concern, 'package.json');
  let budget = options.budgetBytes ?? SCAN_BUDGET_BYTES;
  for (const entry of input.tree.entries) {
    if (entry.kind !== 'file' || !NODE_FILE.test(entry.path) || IN_MODULES.test(entry.path))
      continue;
    budget -= entry.size;
    if (budget < 0) note(reading, 'budget', entry.path);
    else readFile(reading, entry, input, context);
  }
  return {
    declared: manifest.fields,
    modules: [...reading.modules].sort().slice(0, MAX_MODULES),
    concerns: [...reading.concerns]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([concern, files]) => ({
        concern,
        files: [...files].sort().slice(0, MAX_FILES_PER_CONCERN),
      })),
  };
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
  return outsideImports(buildInput(tree, new Findings()), options);
}
