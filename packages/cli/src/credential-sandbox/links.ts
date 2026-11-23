import { lstatSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { realTarget, within } from '../commands/config-file.js';
import type { KeyPath } from './rules.js';

/**
 * Where a listed key path really is, when a link stands on the way to it.
 *
 * The sandbox runtime denies the path it is given. Where that path is a link (`~/.npmrc` kept in
 * `~/dotfiles`), or sits under a folder that is one (`~/.config`), the file itself has another
 * path, which stays readable unless that path is listed too.
 */
export type LinkedPath =
  | {
      readonly kind: 'target';
      /** The real path as settings write it: from `~/` inside the home, absolute outside it. */
      readonly target: string;
      /** The same place as an absolute path, for a settings entry written that way. */
      readonly real: string;
      /** False for a target that holds the home folder: listing it would close the home. */
      readonly listable: boolean;
    }
  /** A link that leads nowhere, or in a circle: there is no target to list. */
  | { readonly kind: 'unresolved' };

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    // A path that is not there, or cannot be looked at, is not a link this can follow.
    return false;
  }
}

/** The link behind one `~/…` key path, or undefined when the path is where it says it is. */
export function linkedPath(home: string, keyPath: string): LinkedPath | undefined {
  const rest = keyPath.slice('~/'.length);
  const realHome = realTarget(home);
  const real = realTarget(join(home, rest));
  if (real === join(realHome, rest))
    return isLink(join(home, rest)) ? { kind: 'unresolved' } : undefined;
  const inside = real !== realHome && within(real, realHome);
  return {
    kind: 'target',
    target: inside ? '~/' + relative(realHome, real).split(sep).join('/') : real,
    real,
    listable: !within(realHome, real),
  };
}

/** The targets to list beside the key paths in `ids`, and the links whose target cannot be listed. */
export function linkTargets(
  home: string,
  ids: readonly KeyPath[],
): {
  readonly targets: Readonly<Partial<Record<KeyPath, string>>>;
  readonly skipped: readonly { readonly path: KeyPath; readonly target: string | null }[];
} {
  const targets: Partial<Record<KeyPath, string>> = {};
  const skipped: { path: KeyPath; target: string | null }[] = [];
  for (const id of ids) {
    const link = linkedPath(home, id);
    if (link === undefined) continue;
    if (link.kind === 'target' && link.listable) targets[id] = link.target;
    else skipped.push({ path: id, target: link.kind === 'target' ? link.target : null });
  }
  return { targets, skipped };
}
