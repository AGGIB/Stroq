import type { TaggedHit } from './agent-change.js';
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

/** The failing entries for the package manager configs a change reaches, by path or by link. */
export function packageConfigChanges(
  tree: ReadonlyMap<string, TreeEntry>,
  linked: { readonly view: TreeView; readonly unread: number },
  changed: ReadonlyMap<string, Changed>,
  maxSteps: number,
): TaggedHit[] {
  const out = new Map<string, TaggedHit>();
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
 * Each link the change adds, edits or retypes, in any folder, that leads out of the repository, to
 * nothing (or round in a loop), or whose target was not read: what is behind it is in no change
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
  }
  return out;
}
