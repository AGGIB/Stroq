import { parseDocument } from 'yaml';
import type { TaggedHit } from './agent-change.js';
import {
  BUILD_CONTEXT,
  BUILD_FILE,
  BUILD_INPUT_CHANGED,
  BUILD_UNRESOLVED,
  COMPOSE_ANYWHERE,
  COMPOSE_FILE,
  besideFile,
} from './agent-editor.js';
import { hit } from './agent-kinds.js';
import { foldPath } from './agent-surface.js';
import type { Changed } from './git-read.js';
import { resolve, type Resolved, type TreeView } from './git-tree.js';

/**
 * What a dev container already there is built from, followed through a change, coarsely: anything
 * under its build context, its Dockerfile, and, when it names compose files, anything under the
 * folder of each of them and under the dev container's own folder, and every file named like a
 * compose file or a Dockerfile anywhere. A compose file is not read for what its services build.
 * Each input is found as a host on disk finds it, through the links of the tree, and what a change
 * touched is matched in any letter case, each part folded as the most forgiving disk opens it. A
 * change to any of them, or to a link on the way, fails; so does an input that cannot be worked out
 * (not there, behind a link not read or in a submodule, leading nowhere or out of the repository).
 */

/** The most files of one input a change touched that are listed; one more finding counts the rest. */
const MAX_PER_INPUT = 20;

/** A file named like a compose file or a Dockerfile, by its folded name. */
const COMPOSE_OR_DOCKERFILE =
  /^(?:(?:docker-)?compose[^/]*\.ya?ml|dockerfile[^/]*|containerfile[^/]*|[^/]*\.(?:dockerfile|containerfile))$/;

/** Keys of a compose file whose strings, wherever they are, are taken for paths from its folder. */
const PATH_KEYS: ReadonlySet<string> = new Set(['file', 'env_file']);
/** Keys that bring in another compose file: not followed, so every change counts. */
const OTHER_FILES: ReadonlySet<string> = new Set(['include', 'extends']);
/**
 * The keys of a service's `build` known to name no file: the context and the Dockerfile, read on
 * their own, and settings that point at nothing on disk. Any other makes every change count, and so
 * do the ones that can name a local path: `cache_from` and `cache_to` (`type=local,src=...`), `ssh`
 * (a key file), `secrets` (a file the top-level `secrets` name), `additional_contexts`.
 */
const BUILD_KEYS: ReadonlySet<string> = new Set([
  'args',
  'context',
  'dockerfile',
  'dockerfile_inline',
  'entitlements',
  'extra_hosts',
  'isolation',
  'labels',
  'network',
  'no_cache',
  'platforms',
  'privileged',
  'pull',
  'shm_size',
  'tags',
  'target',
  'ulimits',
]);
/** The most nodes of one compose file walked; past it, the file counts as one not read. */
const MAX_COMPOSE_NODES = 100_000;
/** The most compose files read in one check; past it, each one left counts as one not read. */
export const MAX_COMPOSE_FILES = 16;
/** How a compose file is read: merge keys, and a bounded number of aliases. */
const COMPOSE_YAML = { merge: true, uniqueKeys: false, prettyErrors: false, maxAliasCount: 100 };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Every string at or under `value`, charged to `budget`. */
function stringsUnder(value: unknown, out: string[], budget: { left: number }): void {
  const stack = [value];
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    budget.left -= 1;
    if (typeof next === 'string') out.push(next);
    else if (typeof next === 'object' && next !== null) stack.push(...Object.values(next));
  }
}

/** The context and the Dockerfile one service builds from, or undefined for a build not known. */
function servicePaths(build: unknown): string[] | undefined {
  if (build === undefined || build === null) return [];
  if (typeof build === 'string') return [build, `${build}/Dockerfile`];
  if (!isObj(build) || Object.keys(build).some((key) => !BUILD_KEYS.has(key))) return undefined;
  const context = build['context'] ?? '.';
  const dockerfile =
    build['dockerfile'] ?? (build['dockerfile_inline'] === undefined ? 'Dockerfile' : undefined);
  if (typeof context !== 'string') return undefined;
  if (dockerfile === undefined) return [context];
  return typeof dockerfile === 'string' ? [context, `${context}/${dockerfile}`] : undefined;
}

/**
 * The paths a compose file names, from its folder, read without following it any further: each
 * service's build context (a string `build` is one) and its Dockerfile from that context, and
 * every string under `file` or `env_file` anywhere. Undefined, so that every
 * change counts, when the file does not read as YAML or is past the bound, brings in another
 * compose file (`include`, `extends`), builds with a key this does not know, or names a path with
 * a `$`, which compose expands from the environment.
 */
export function composePaths(text: string): readonly string[] | undefined {
  let value: unknown;
  try {
    const doc = parseDocument(text, COMPOSE_YAML);
    if (doc.errors.length > 0) return undefined;
    value = doc.toJS({ maxAliasCount: 100 });
  } catch {
    return undefined;
  }
  const paths: string[] = [];
  const budget = { left: MAX_COMPOSE_NODES };
  const stack = [value];
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    budget.left -= 1;
    if (budget.left < 0) return undefined;
    if (typeof next !== 'object' || next === null) continue;
    for (const [key, child] of Object.entries(next)) {
      if (OTHER_FILES.has(key)) return undefined;
      if (PATH_KEYS.has(key)) stringsUnder(child, paths, budget);
      if (typeof child === 'object' && child !== null) stack.push(child);
    }
  }
  const services = isObj(value) ? value['services'] : undefined;
  if (services !== undefined && services !== null && !isObj(services)) return undefined;
  for (const service of Object.values(services ?? {})) {
    if (!isObj(service)) continue;
    const built = servicePaths(service['build']);
    if (built === undefined) return undefined;
    paths.push(...built);
  }
  if (budget.left < 0 || paths.some((p) => p.includes('$'))) return undefined;
  return [...new Set(paths)];
}

/** One thing a dev container is built from: what it is, its path, and the dev container's file. */
interface Input {
  readonly kind: 'folder' | 'file' | 'compose' | 'names';
  readonly path: string;
  readonly devcontainer: string;
}

const KIND_OF: Readonly<Record<string, Input['kind']>> = {
  [BUILD_CONTEXT]: 'folder',
  [BUILD_FILE]: 'file',
  [COMPOSE_FILE]: 'compose',
  [COMPOSE_ANYWHERE]: 'names',
};

interface Touched {
  readonly path: string;
  readonly c: Changed;
  readonly folded: string;
}

const unresolved = (input: Input, why: string): TaggedHit => ({
  ...hit('devcontainer-setting', input.devcontainer, 1, BUILD_UNRESOLVED, `${input.path}: ${why}`),
  severity: 'error',
  status: 'new',
});

/** Why a resolved path is not one to follow, or undefined when it is a file or a folder. */
function notFound(at: Resolved): string | undefined {
  switch (at.kind) {
    case 'blob':
    case 'folder':
      return undefined;
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

const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/** The failing entries for what the dev containers of `found` are built from. */
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
  const touched: Touched[] = [...changed]
    .map(([path, c]) => ({ path, c, folded: foldPath(path) }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const out = new Map<string, TaggedHit>();
  const fails = (path: string, devcontainer: string, c: Changed | undefined): void => {
    out.set(`${path}\u0000${devcontainer}`, {
      ...hit('devcontainer-setting', path, 1, BUILD_INPUT_CHANGED, devcontainer),
      severity: 'error',
      status: c?.status === 'A' ? 'new' : 'changed',
    });
  };
  const failsEach = (input: Input, where: string, matches: readonly Touched[]): void => {
    for (const t of matches.slice(0, MAX_PER_INPUT)) fails(t.path, input.devcontainer, t.c);
    if (matches.length > MAX_PER_INPUT)
      out.set(`\u0000more\u0000${input.devcontainer}\u0000${where}`, {
        ...hit(
          'devcontainer-setting',
          input.devcontainer,
          1,
          BUILD_INPUT_CHANGED,
          `${matches.length - MAX_PER_INPUT} more files under ${where}`,
        ),
        severity: 'error',
        status: 'changed',
      });
  };
  const composes: { input: Input; target: string }[] = [];
  for (const input of inputs) {
    if (input.kind === 'names') {
      const named = touched.filter((t) => COMPOSE_OR_DOCKERFILE.test(baseName(t.folded)));
      failsEach(input, input.path, named);
      continue;
    }
    const at = resolve(input.path === '.' ? '' : input.path, view);
    const why = notFound(at);
    if (why !== undefined || (at.kind !== 'blob' && at.kind !== 'folder')) {
      out.set(`\u0000${input.devcontainer}\u0000${input.path}`, unresolved(input, why ?? ''));
      continue;
    }
    const { path: target, links } = at;
    for (const link of links)
      if (changed.has(link)) fails(link, input.devcontainer, changed.get(link));
    const folded = foldPath(target);
    if (input.kind === 'compose' && at.kind === 'blob') composes.push({ input, target });
    if (at.kind === 'blob') {
      failsEach(
        input,
        target,
        touched.filter((t) => t.folded === folded),
      );
      continue;
    }
    const prefix = target === '' ? '' : `${folded}/`;
    failsEach(
      input,
      target === '' ? '.' : target,
      touched.filter((t) => prefix === '' || t.folded.startsWith(prefix)),
    );
  }
  // What each compose file names, from its folder as named and as found through links. One that
  // was not read, or does not read as YAML, could name anything: every change counts.
  const texts = readText(composes.slice(0, MAX_COMPOSE_FILES).map((c) => c.target));
  composes.forEach(({ input, target }, i) => {
    const text = i < MAX_COMPOSE_FILES ? texts.get(target) : undefined;
    const paths = text === undefined ? undefined : composePaths(text);
    if (paths === undefined) {
      failsEach(input, `the repository, as ${target} could not be read`, touched);
      return;
    }
    const places = new Set<string>();
    let open = false;
    for (const from of [input.path, target])
      for (const p of paths) {
        const path = besideFile(from, p);
        const at = path === undefined ? undefined : resolve(path === '.' ? '' : path, view);
        if (
          path === undefined ||
          at === undefined ||
          (at.kind !== 'blob' && at.kind !== 'folder')
        ) {
          open = true;
          continue;
        }
        places.add(path);
        places.add(at.path);
        for (const link of at.links) places.add(link);
      }
    if (open) {
      failsEach(
        input,
        `the repository, as ${target} names a path that was not worked out`,
        touched,
      );
      return;
    }
    for (const place of places) {
      const f = foldPath(place);
      const prefix = place === '' || place === '.' ? '' : `${f}/`;
      failsEach(
        input,
        place,
        touched.filter((t) => prefix === '' || t.folded === f || t.folded.startsWith(prefix)),
      );
    }
  });
  return [...out.values()];
}
