import { parseDocument } from 'yaml';
import { isPlainObject } from '../commands/config-file.js';
import type { TaggedHit } from './agent-change.js';
import {
  BUILD_CONTEXT,
  BUILD_FILE,
  BUILD_INPUT_CHANGED,
  BUILD_UNRESOLVED,
  COMPOSE_FILE,
  besideFile,
} from './agent-editor.js';
import { hit } from './agent-kinds.js';
import type { Changed } from './git-read.js';
import { resolve, type Resolved, type TreeView } from './git-tree.js';

/**
 * What a dev container already there is built from, followed through a change: anything under its
 * build context or under the folder of one of its compose files, its Dockerfile, and a Dockerfile
 * a compose file names. Each is found as a host on disk finds it, through the links of the tree.
 * A change to any of them, or to a link on the way, fails; so does an input that cannot be worked
 * out (not there, behind a link not read, out of the repository, a compose file that does not read).
 */

/** The most files of one input a change touched that are listed; one more finding counts the rest. */
const MAX_PER_INPUT = 20;
/** The most compose files read in one check; past it, each one left fails as not resolved. */
export const MAX_COMPOSE_FILES = 16;

/** One thing a dev container is built from: what it is, its path, and the dev container's file. */
interface Input {
  readonly kind: 'folder' | 'file' | 'compose';
  readonly path: string;
  readonly devcontainer: string;
}

const KIND_OF: Readonly<Record<string, Input['kind']>> = {
  [BUILD_CONTEXT]: 'folder',
  [BUILD_FILE]: 'file',
  [COMPOSE_FILE]: 'compose',
};

/** The options a compose file is read with: merge keys and a bounded number of aliases. */
const COMPOSE_YAML = { merge: true, uniqueKeys: false, prettyErrors: false, maxAliasCount: 100 };

/**
 * The Dockerfiles the services of a compose file at `path` build from, as repository paths; why
 * not, when the file does not read as a compose file or names one this cannot place.
 */
export function composeDockerfiles(
  path: string,
  text: string,
): { readonly files: readonly string[] } | { readonly why: string } {
  let value: unknown;
  try {
    const doc = parseDocument(text, COMPOSE_YAML);
    if (doc.errors.length > 0) return { why: `${path} does not read as YAML` };
    value = doc.toJS({ maxAliasCount: 100 });
  } catch {
    return { why: `${path} does not read as YAML` };
  }
  if (!isPlainObject(value)) return { why: `${path} is not a compose file` };
  const services = value['services'];
  if (services === undefined || services === null) return { files: [] };
  if (!isPlainObject(services)) return { why: `the services of ${path} are not a table` };
  const files: string[] = [];
  for (const service of Object.values(services)) {
    const build = isPlainObject(service) ? service['build'] : undefined;
    if (build === undefined || build === null) continue;
    const context = typeof build === 'string' ? build : isPlainObject(build) ? build['context'] : 0;
    const dockerfile = isPlainObject(build) ? (build['dockerfile'] ?? 'Dockerfile') : 'Dockerfile';
    if ((context !== undefined && typeof context !== 'string') || typeof dockerfile !== 'string')
      return { why: `a build of ${path} is not one this reads` };
    const folder = besideFile(path, context ?? '.');
    const file = folder === undefined ? undefined : besideFile(`${folder}/x`, dockerfile);
    if (file === undefined)
      return { why: `a build of ${path} leads out of the repository or to another place` };
    files.push(file);
  }
  return { files };
}

const unresolved = (input: Input, why: string): TaggedHit => ({
  ...hit('devcontainer-setting', input.devcontainer, 1, BUILD_UNRESOLVED, `${input.path}: ${why}`),
  severity: 'error',
  status: 'new',
});

const touchedHit = (path: string, devcontainer: string, c: Changed | undefined): TaggedHit => ({
  ...hit('devcontainer-setting', path, 1, BUILD_INPUT_CHANGED, devcontainer),
  severity: 'error',
  status: c?.status === 'A' ? 'new' : 'changed',
});

/** Why a resolved path is not what an input of this kind needs, or undefined when it is. */
function notFound(at: Resolved, kind: Input['kind']): string | undefined {
  switch (at.kind) {
    case 'blob':
      return undefined;
    case 'folder':
      return kind === 'folder' ? undefined : 'it is a folder';
    case 'none':
      return 'it is not there';
    case 'outside':
      return 'a link on the way leads out of the repository';
    case 'unread':
      return `a link on the way was not read: ${at.link}`;
    case 'dangling':
      return 'a link on the way leads to nothing';
    case 'submodule':
      return 'it is in a submodule, whose files come from another repository';
  }
}

/**
 * The failing entries for what the dev containers of `found` are built from. `readText` reads the
 * files of the tree it is given, those it can, by their path.
 */
export function buildInputChanges(
  found: readonly TaggedHit[],
  changed: ReadonlyMap<string, Changed>,
  view: TreeView,
  readText: (paths: readonly string[]) => ReadonlyMap<string, string>,
): TaggedHit[] {
  const inputs: Input[] = found.flatMap((h) => {
    const kind = h.kind === 'devcontainer-setting' ? KIND_OF[h.name] : undefined;
    return kind === undefined ? [] : [{ kind, path: h.value, devcontainer: h.file }];
  });
  if (inputs.length === 0) return [];
  const out = new Map<string, TaggedHit>();
  const add = (h: TaggedHit): void => {
    out.set(`${h.file}\u0000${h.name}\u0000${h.value}`, h);
  };
  const places = inputs.map((input) => ({
    input,
    at: resolve(input.path === '.' ? '' : input.path, view),
  }));
  // The compose files read, to find the Dockerfiles they name.
  const composes = places.filter((p) => p.input.kind === 'compose' && p.at.kind === 'blob');
  const texts = readText(
    composes.slice(0, MAX_COMPOSE_FILES).map((p) => (p.at as { path: string }).path),
  );
  const more: { input: Input; at: Resolved }[] = [];
  composes.forEach(({ input, at }, i) => {
    const path = (at as { path: string }).path;
    const text = i < MAX_COMPOSE_FILES ? texts.get(path) : undefined;
    if (text === undefined) {
      add(unresolved(input, 'the compose file was not read'));
      return;
    }
    const named = composeDockerfiles(path, text);
    if ('why' in named) {
      add(unresolved(input, named.why));
      return;
    }
    for (const file of named.files) {
      const derived: Input = { kind: 'file', path: file, devcontainer: input.devcontainer };
      more.push({ input: derived, at: resolve(file, view) });
    }
  });
  for (const { input, at } of [...places, ...more]) {
    const why = notFound(at, input.kind);
    if (why !== undefined) {
      add(unresolved(input, why));
      continue;
    }
    const links = at.kind === 'none' ? [] : at.links;
    for (const link of links)
      if (changed.has(link)) add(touchedHit(link, input.devcontainer, changed.get(link)));
    const target = (at as { path: string }).path;
    if (at.kind === 'blob') {
      if (changed.has(target)) add(touchedHit(target, input.devcontainer, changed.get(target)));
      continue;
    }
    const prefix = target === '' ? '' : `${target}/`;
    const touched = [...changed.keys()].filter((p) => prefix === '' || p.startsWith(prefix)).sort();
    for (const path of touched.slice(0, MAX_PER_INPUT))
      add(touchedHit(path, input.devcontainer, changed.get(path)));
    if (touched.length > MAX_PER_INPUT)
      add({
        ...hit(
          'devcontainer-setting',
          input.devcontainer,
          1,
          BUILD_INPUT_CHANGED,
          `${touched.length - MAX_PER_INPUT} more files under ${target === '' ? '.' : target}`,
        ),
        severity: 'error',
        status: 'changed',
      });
  }
  return [...out.values()];
}
