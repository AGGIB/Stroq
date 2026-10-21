import { posix } from 'node:path';
import type { TaggedHit } from './agent-change.js';
import { foldPath } from './agent-surface.js';
import { hit } from './agent-kinds.js';
import { PACKAGE_CONFIG, isPackageConfig, keyed } from './agent-lines.js';
import { readBlobs, type Changed, type TreeEntry } from './git-read.js';
import { SYMLINK, linkMatters, resolve, under, type TreeView } from './git-tree.js';

/**
 * The configs of npm, yarn and bun that a change reaches, as a package manager opens them: by
 * their own path, and through the links of the tree, a link to the file and a link to a folder it
 * is in included. A change that adds, edits, retypes or deletes one, or the file a link leads it
 * to, or a link on the way, fails once for the config; nothing of its text is read or shown. One
 * behind a link that was not read, that leads nowhere or out of the repository, fails too.
 */

/** The most package manager configs read for the paths they name. */
export const MAX_CONFIGS_READ = 64;
/** A link's target is a path; one longer than a path can be is not a link a checkout makes. */
const MAX_LINK_BYTES = 4096;
/** What a byte that is not UTF-8 decodes to. */
const REPLACEMENT = '�';

/**
 * `view` with the target of every link of the tree read, up to `max` links; `unread` counts the
 * links left unread, past the bound, too long, or not UTF-8.
 */
export function withAllLinks(
  top: string,
  tree: ReadonlyMap<string, TreeEntry>,
  view: TreeView,
  max: number,
): { readonly view: TreeView; readonly unread: number } {
  const all = view.sorted.filter((p) => tree.get(p)?.mode === SYMLINK);
  const missing = all.filter((p) => !view.targets.has(p)).slice(0, max);
  const targets = new Map(view.targets);
  const entries = missing
    .map((p) => tree.get(p) as TreeEntry)
    .filter((e) => e.size <= MAX_LINK_BYTES);
  const blobs = readBlobs(top, entries);
  for (const p of missing) {
    const text = blobs.get((tree.get(p) as TreeEntry).oid);
    if (text !== undefined && !text.includes(REPLACEMENT)) targets.set(p, text);
  }
  return {
    view: { ...view, targets },
    unread: all.filter((p) => !targets.has(p)).length,
  };
}

/**
 * Every path a package manager may open its config by: each of the tree's own, and each one
 * reached through a link to a folder, links inside it followed, a loop once. `stoppedAt` is where
 * the walk stopped at `maxSteps` entries.
 */
function configPaths(
  view: TreeView,
  maxSteps: number,
): { readonly paths: readonly string[]; readonly stoppedAt?: string } {
  const paths = new Set(view.sorted.filter((p) => isPackageConfig(p)));
  const queue: { virtual: string; real: string; seen: readonly string[] }[] = [];
  for (const link of view.sorted) {
    if (view.tree.get(link)?.mode !== SYMLINK) continue;
    const at = resolve(link, view);
    if (at.kind === 'folder') queue.push({ virtual: link, real: at.path, seen: [at.path] });
  }
  let steps = 0;
  for (let i = 0; i < queue.length; i += 1) {
    const { virtual, real, seen } = queue[i] as (typeof queue)[number];
    for (const path of under(view.sorted, real)) {
      steps += 1;
      if (steps > maxSteps) return { paths: [...paths], stoppedAt: virtual };
      const reached = `${virtual}/${real === '' ? path : path.slice(real.length + 1)}`;
      if (isPackageConfig(reached)) paths.add(reached);
      if (view.tree.get(path)?.mode !== SYMLINK) continue;
      const at = resolve(reached, view);
      if (at.kind === 'folder' && !seen.includes(at.path))
        queue.push({ virtual: reached, real: at.path, seen: [...seen, at.path] });
    }
  }
  return { paths: [...paths] };
}

const unreadable = (path: string, why: string): TaggedHit => ({
  ...hit('unreadable-config', path, 1, 'link', why),
  status: 'new',
});

/** Yarn's own program and its plugins, which it runs: any change under them fails. */
const YARN_CODE = /(?:^|\/)\.yarn\/(?:releases|plugins)\//;
/** A word of a config that looks like a path: with a `/`, from a `.`, or with an extension. */
const PATHLIKE = /^(?:\.{1,2}\/|[^/][^:]*\/|[^@/:]+\.[A-Za-z0-9]{1,6}$)/;
/** The variables a path may start with that name the folder an install runs in. */
const KNOWN_PREFIX = /^\$(?:INIT_CWD|PWD)(?![A-Za-z0-9_])\/*/;

interface Named {
  /** The paths named, from the config's folder and, for INIT_CWD and PWD, from the top. */
  readonly paths: readonly string[];
  /** True when a path is behind a variable this cannot place. */
  readonly unplaced: boolean;
}

/**
 * Every word of a package manager's config that looks like a path, from the config's folder: what
 * `yarnPath`, `plugins`, `script-shell`, `preload` or `node-options` name, taken without reading
 * which key a word is the value of. An address, an absolute path and `~` are left out. A path
 * behind `$INIT_CWD` or `$PWD` is placed from the config's folder and from the top; one behind any
 * other variable is not placed, and the config fails.
 */
function namedPaths(config: string, text: string): Named {
  const folder = posix.dirname(config) === '.' ? '' : posix.dirname(config);
  const paths: string[] = [];
  let unplaced = false;
  const place = (from: string, word: string): void => {
    const path = posix.normalize(posix.join(from, word)).replace(/\/+$/, '');
    if (path !== '.' && path !== '..' && !path.startsWith('../')) paths.push(path);
  };
  // `${NAME}` is read as `$NAME`; any other `${...}` (a default, a slice) is not placed.
  if (/\$\{(?![A-Za-z_][A-Za-z0-9_]*\})/.test(text)) unplaced = true;
  const words = text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, '$$$1');
  for (const raw of words.split(/[\s"'=,;\[\]{}()]+/)) {
    if (raw === '' || raw.includes('://') || raw.startsWith('/') || raw.startsWith('~')) continue;
    const known = KNOWN_PREFIX.test(raw);
    const word = known ? `./${raw.replace(KNOWN_PREFIX, '')}` : raw;
    if (word.includes('$')) {
      unplaced ||= /\/|\.[A-Za-z0-9]{1,6}$/.test(word);
      continue;
    }
    if (!PATHLIKE.test(word)) continue;
    place(folder, word);
    if (known && folder !== '') place('', word);
  }
  return { paths, unplaced };
}

/** What a hit for a file a package manager runs or loads is named. */
export const PACKAGE_RUNS = 'package manager runs it';
/** What the hit for the configs that were not read is named. */
export const PACKAGE_UNREAD = 'package manager configs';

const unreadHit = (path: string, name: string, why: string): TaggedHit => ({
  ...hit('unreadable-config', path, 1, name, why),
  status: 'new',
});

/**
 * A failing entry for each file the change adds or edits that a package manager runs or loads:
 * under `.yarn/releases` or `.yarn/plugins`, or a path a config of `texts` names, or under it,
 * each also found through the links of the tree; and one for a link on the way that was not read,
 * or a config that names a path this cannot place.
 */
function packageRunChanges(
  texts: ReadonlyMap<string, string>,
  changed: ReadonlyMap<string, Changed>,
  view: TreeView,
): TaggedHit[] {
  const out: TaggedHit[] = [];
  /** Folded folders or files, and the config (or `yarn`) that runs what is in them. */
  const places: [string, string][] = [];
  const follow = (path: string, by: string): void => {
    places.push([foldPath(path), by]);
    const at = resolve(path, view);
    if (at.kind === 'unread') {
      out.push(
        unreadHit(
          by === 'yarn' ? path : by,
          'link',
          `a link on the way to ${path}, which a package manager runs, was not read: ${at.link}`,
        ),
      );
      return;
    }
    if (at.kind === 'none') return;
    for (const link of at.links) if (changed.has(link)) places.push([foldPath(link), by]);
    if (at.kind === 'blob' || at.kind === 'folder') places.push([foldPath(at.path), by]);
  };
  for (const [config, text] of texts) {
    const named = namedPaths(config, text);
    for (const path of named.paths) follow(path, config);
    if (named.unplaced)
      out.push(
        unreadHit(
          config,
          'named path',
          'it names a path behind a variable other than INIT_CWD or PWD, which cannot be placed, so what the package manager runs is not known',
        ),
      );
  }
  // Each .yarn folder of the tree, by its own path, links included.
  const yarns = new Set<string>();
  for (const path of view.sorted) {
    const parts = path.split('/');
    parts.forEach((part, i) => {
      if (foldPath(part) === '.yarn') yarns.add(parts.slice(0, i + 1).join('/'));
    });
  }
  for (const dir of yarns)
    for (const sub of ['releases', 'plugins']) follow(`${dir}/${sub}`, 'yarn');
  for (const [path, c] of changed) {
    if (c.status === 'D') continue;
    const folded = foldPath(path);
    const by = YARN_CODE.test(folded)
      ? 'yarn'
      : places.find(([p]) => folded === p || folded.startsWith(`${p}/`))?.[1];
    if (by !== undefined)
      out.push({
        ...hit('agent-api-redirect', path, 1, PACKAGE_RUNS, by),
        status: c.status === 'A' ? 'new' : 'changed',
      });
  }
  return out;
}

/** The failing entries for the package manager configs a change reaches, by path or by link. */
export function packageConfigChanges(
  tree: ReadonlyMap<string, TreeEntry>,
  linked: { readonly view: TreeView; readonly unread: number },
  changed: ReadonlyMap<string, Changed>,
  maxSteps: number,
  texts: ReadonlyMap<string, string> = new Map(),
  unreadConfigs: readonly string[] = [],
): TaggedHit[] {
  const out = new Map<string, TaggedHit>();
  for (const h of packageRunChanges(texts, changed, linked.view))
    out.set(`\u0000runs\u0000${h.file}\u0000${h.name}`, h);
  // A config not read (a link, too large, past the cap) could name anything: it fails, counted.
  const firstUnread = unreadConfigs[0];
  if (firstUnread !== undefined)
    out.set(
      '\u0000unread configs',
      unreadHit(
        firstUnread,
        PACKAGE_UNREAD,
        `${unreadConfigs.length} package manager configs were not read (a link, too large, or past the ${MAX_CONFIGS_READ} read), so what they name is not known`,
      ),
    );
  const fails = (path: string, isNew: boolean, what: string): void => {
    if (!out.has(path))
      out.set(path, {
        ...hit('agent-api-redirect', path, 1, PACKAGE_CONFIG, keyed(what)),
        status: isNew ? 'new' : 'changed',
      });
  };
  for (const [path, c] of changed)
    if (isPackageConfig(path))
      fails(path, c.status === 'A', `${c.status} ${tree.get(path)?.oid ?? 'deleted'}`);
  const { view, unread } = linked;
  const { paths, stoppedAt } = configPaths(view, maxSteps);
  for (const path of paths) {
    if (out.has(path)) continue;
    const at = resolve(path, view);
    if (at.kind === 'none' || at.kind === 'folder') continue;
    const touched = at.links.filter((l) => changed.has(l));
    if (at.kind === 'unread')
      out.set(path, unreadable(path, `a link on the way was not read: ${at.link}`));
    else if (at.kind === 'outside')
      out.set(path, {
        ...hit('config-link-outside', path, 1, 'link', at.target),
        severity: 'error',
        status: touched.length > 0 ? 'new' : 'present',
      });
    else if (at.kind === 'dangling')
      out.set(path, {
        ...hit('unreadable-config', path, 1, 'link', 'a link on the way leads to nothing'),
        status: touched.length > 0 ? 'new' : 'present',
      });
    else if (touched.length > 0 || changed.has(at.path)) {
      const all = [...touched, at.path].flatMap((p) => changed.get(p)?.status ?? []);
      fails(
        path,
        all.every((s) => s === 'A'),
        `${all.join('')} ${at.kind === 'blob' ? tree.get(at.path)?.oid : at.oid}`,
      );
    }
  }
  if (stoppedAt !== undefined)
    out.set(
      stoppedAt,
      unreadable(
        stoppedAt,
        `the walk through links for package manager configs stopped here, after ${maxSteps} entries`,
      ),
    );
  // A link to an agent config or folder that was not read fails already, where it is.
  const missed = view.sorted.filter(
    (p) => tree.get(p)?.mode === SYMLINK && !view.targets.has(p) && !linkMatters(p),
  );
  const first = missed[0];
  if (unread > 0 && first !== undefined)
    out.set(
      `\u0000${first}`,
      unreadable(
        first,
        `${missed.length} links of the tree were not read, so a package manager config behind one is not known`,
      ),
    );
  return [...out.values()];
}

/**
 * Each link the change adds, edits or retypes, in any folder, that leads anywhere but to a file or a
 * folder of the tree: out of the repository, to nothing (or round in a loop), into a submodule, or
 * through a link whose target was not read: what is behind it is in no change
 * to review, and a reader may never name it (a package config or an agent folder behind a folder
 * link out of the tree). `reported` holds the paths another reading already failed.
 */
export function changedLinkHits(
  tree: ReadonlyMap<string, TreeEntry>,
  view: TreeView,
  changed: ReadonlyMap<string, Changed>,
  reported: ReadonlySet<string>,
): TaggedHit[] {
  const out: TaggedHit[] = [];
  for (const [path, c] of changed) {
    if (c.status === 'D' || tree.get(path)?.mode !== SYMLINK || reported.has(path)) continue;
    const status = c.status === 'A' ? 'new' : 'changed';
    const at = resolve(path, view);
    if (at.kind === 'outside')
      out.push({
        ...hit('config-link-outside', path, 1, 'link', at.target),
        severity: 'error',
        status,
      });
    else if (at.kind === 'dangling')
      out.push({
        ...hit(
          'unreadable-config',
          path,
          1,
          'link',
          'the link leads to nothing, or round in a loop',
        ),
        status,
      });
    else if (at.kind === 'unread')
      out.push({
        ...hit('unreadable-config', path, 1, 'link', `a link on the way was not read: ${at.link}`),
        status,
      });
    else if (at.kind === 'submodule')
      out.push({
        ...hit(
          'unreadable-config',
          path,
          1,
          'link',
          `the link leads into the submodule ${at.path}, whose files come from another repository`,
        ),
        status,
      });
  }
  return out;
}
