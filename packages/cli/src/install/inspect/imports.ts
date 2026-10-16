// Whether the code of an MCP server can be held by the pin: does it only ask for what is in its tree?
//
// The pin hashes the files of a server, copies them to a private folder and runs the copy. Node finds a
// package that a file asks for by name in the folders above that file, and above the private copy are
// folders that no digest covers (`<stroq home>/run`, `<stroq home>`, the home folder). So a server that
// asks for a package by name runs, from the confirmed bytes, whatever code is at that name on the day it
// is started. A server can only be pinned when everything it loads is in the tree: written as one file,
// or with what it needs copied into the tree and asked for by a relative path.
//
// This is a reading of text, like the others: a name that is built at run time is not seen.
import { dirname } from 'node:path/posix';
import type { Tree } from '../types.js';
import { Findings } from './findings.js';
import type { ArtifactKind } from '../types.js';
import { buildInput, type InspectInput } from './input.js';
import { entriesOf, own, ownObject, ownString, parseJsonObject } from './json.js';
import { isBareSpecifier, moduleSpecifiers, packageNameOf } from './module-specifiers.js';

/** The fields of a package.json that name what must be installed for the package to run. */
const RUNTIME_DEPENDENCY_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies'];
/** The most package names one tree is reported for. */
export const MAX_MODULES = 50;
const NODE_FILE = /\.(?:js|mjs|cjs)$/i;
const IN_MODULES = /(?:^|\/)node_modules\//;

export interface OutsideImports {
  /** The fields of the package.json that list dependencies, by name. */
  readonly declared: readonly string[];
  /** Packages that files of the tree ask for by name and that the tree does not hold, sorted. */
  readonly modules: readonly string[];
}

/** Every folder that holds an entry of the tree, as `a/b` for `a/b/c.js`: `node_modules/x` is "there" when it is in this set. */
function foldersOf(paths: Iterable<string>): Set<string> {
  const folders = new Set<string>();
  for (const path of paths) {
    for (let at = dirname(path); at !== '.' && at !== '/' && !folders.has(at); at = dirname(at))
      folders.add(at);
  }
  return folders;
}

/** Whether `node_modules/<name>` is in the tree in a folder above the file `from`, which is where Node would look. */
function heldAbove(name: string, from: string, folders: ReadonlySet<string>): boolean {
  for (let dir = dirname(from); ; dir = dirname(dir)) {
    const base = dir === '.' ? '' : `${dir}/`;
    if (folders.has(`${base}node_modules/${name}`)) return true;
    if (dir === '.' || dir === '/') return false;
  }
}

interface Manifest {
  readonly fields: string[];
  /** The package's own name when it says how it may be asked for by that name (`exports`), else null. */
  readonly self: string | null;
}

function readManifest(input: InspectInput): Manifest {
  const file = input.byPath.get('package.json');
  const manifest = file === undefined ? null : parseJsonObject(file.text);
  if (manifest === null) return { fields: [], self: null };
  const fields = RUNTIME_DEPENDENCY_FIELDS.filter((field) => {
    const group = ownObject(manifest, field);
    return group !== null && entriesOf(group).length > 0;
  });
  return {
    fields,
    self: own(manifest, 'exports') === undefined ? null : ownString(manifest, 'name'),
  };
}

/** What the files of the tree ask for by name that the tree does not hold. */
export function outsideImports(input: InspectInput): OutsideImports {
  const { fields, self } = readManifest(input);
  const folders = foldersOf(input.paths);
  const modules = new Set<string>();
  for (const file of input.texts) {
    if (!NODE_FILE.test(file.path) || IN_MODULES.test(file.path)) continue;
    for (const specifier of moduleSpecifiers(file.text)) {
      if (!isBareSpecifier(specifier)) continue;
      const name = packageNameOf(specifier);
      // A package that asks for itself by its own name is read from the tree, when it says how.
      if (name !== self && !heldAbove(name, file.path, folders)) modules.add(name);
    }
  }
  return { declared: fields, modules: [...modules].sort().slice(0, MAX_MODULES) };
}

export const hasOutsideImports = (found: OutsideImports): boolean =>
  found.declared.length > 0 || found.modules.length > 0;

/** For the readings of a passport: an MCP server whose code the pin cannot hold says so as a blind spot. */
export function inspectImports(input: InspectInput, findings: Findings, kind: ArtifactKind): void {
  if (kind !== 'mcp') return;
  if (hasOutsideImports(outsideImports(input))) findings.tally('outside-imports');
}

/** The same reading of a tree that is not being inspected, for the command that refuses an install. */
export function outsideImportsOfTree(tree: Tree): OutsideImports {
  return outsideImports(buildInput(tree, new Findings()));
}
