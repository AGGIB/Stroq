// What the package.json files of a tree say about where code is loaded from.
//
// A package.json is read by Node for more than `main`: `exports` and `imports` map names to files, `bin` names
// a start file, and the nearest package.json above a file is the scope of its `#name` imports. So the question
// asked of each one is whether it points out of the tree (an absolute path, a `..`, a `node_modules`, another
// package where a file is expected), and whether it lists what must be installed for the package to run.
import { posix } from 'node:path';
import type { InspectInput } from './input.js';
import { entriesOf, isObject, own, ownObject, ownString, parseJsonObject } from './json.js';
import { inNodeModules, isNodeModules, WINDOWS_PATH } from '../path-names.js';
import type { JsonObject } from './json.js';

/** The fields of a package.json that name what must be installed for the package to run. */
const RUNTIME_DEPENDENCY_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies'];
const MANIFEST_LEAVES_MAX = 1000;
const MANIFEST_DEPTH_MAX = 10;

/** What was wrong with a manifest: it points out of the tree, or could not be read, or has too much to read. */
export type ManifestConcern = 'outside' | 'unreadable' | 'doubt';

export interface Manifest {
  /** The fields that list dependencies. */
  readonly fields: string[];
  /** The package's own name when it says how it may be asked for by that name (`exports`), else null. */
  readonly self: string | null;
  readonly concern: ManifestConcern | null;
}

const pointsOut = (target: string, mustStartInside: boolean): boolean => {
  const segments = target.split(/[\\/]/);
  return (
    target.startsWith('/') ||
    WINDOWS_PATH.test(target) ||
    segments.includes('..') ||
    segments.some(isNodeModules) ||
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

function manifestPointsOut(manifest: JsonObject): ManifestConcern | null {
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

export function readManifest(input: InspectInput): Manifest {
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

const isManifest = (path: string): boolean =>
  (path === 'package.json' || path.endsWith('/package.json')) && !inNodeModules(path);

/**
 * Every other package.json of the tree. A folder with one of its own is a package of its own to Node: its
 * `imports` say what `#name` means for the files below it, and its `exports` and `main` what is loaded. The
 * root one is read by `readManifest`; these are only asked where they point.
 */
export function nestedManifestConcerns(
  input: InspectInput,
): { concern: ManifestConcern; path: string }[] {
  const found: { concern: ManifestConcern; path: string }[] = [];
  for (const entry of input.tree.entries) {
    if (entry.kind !== 'file' || !isManifest(entry.path) || entry.path === 'package.json') continue;
    const file = input.byPath.get(entry.path);
    const manifest = file === undefined ? null : parseJsonObject(file.text);
    const concern = manifest === null ? 'unreadable' : manifestPointsOut(manifest);
    if (concern !== null) found.push({ concern, path: entry.path });
  }
  return found;
}

/**
 * Whether a package.json of the tree is the scope of the file: the nearest one above it. A `#name` import is
 * resolved through that file; with none in the tree, Node goes on up above the tree, to whatever is there.
 */
export function hasPackageScope(from: string, paths: ReadonlySet<string>): boolean {
  for (let dir = posix.dirname(from); ; dir = posix.dirname(dir)) {
    if (paths.has(dir === '.' ? 'package.json' : `${dir}/package.json`)) return true;
    if (dir === '.' || dir === '/') return false;
  }
}
