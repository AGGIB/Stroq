import { neutralizeControls } from '@stroq/core';
import { relative, resolve } from 'node:path';
import { within } from '../commands/config-file.js';
import { assertWriteAllowed, resolveRealPath } from './atomic.js';
import { HardenError, type PlanRefusal } from './types.js';

/**
 * What the two planners share: judging where a path leads before anything of it is read.
 *
 * A plan is a preview, and a preview that is made by reading the file is made of the file. If the
 * path is a link that leaves the tree, the file it leads to is not the owner's config and its
 * content has no business in a diff. So the planner asks the very question the write will ask
 * (`assertWriteAllowed`: the root the caller named, the rule `stroq init` applies, a link that
 * points nowhere) first, and a path that fails it gives a refused plan and an unread file.
 */

export interface PathRefusal {
  readonly refused: Extract<PlanRefusal, 'path-escapes-root' | 'dangling-link'>;
  /** Names the paths involved, and never anything of the file. */
  readonly detail: string;
}

/**
 * Why `file` may not be written (and so not be read for a preview), or `null` when it may. Only
 * the two path refusals are answered here: a failure of the machine itself, such as a working
 * directory that is gone, is thrown as it came.
 */
export function pathRefusal(file: string, root: string | undefined): PathRefusal | null {
  try {
    assertWriteAllowed(file, root === undefined ? {} : { root });
    return null;
  } catch (err) {
    if (
      err instanceof HardenError &&
      (err.code === 'path-escapes-root' || err.code === 'dangling-link')
    ) {
      return { refused: err.code, detail: err.message };
    }
    throw err;
  }
}

/**
 * The file a change to `file` lands in, when a link carries the path to another file than the one
 * it names, and `null` when none does. `real` is `file` with every link followed.
 *
 * A link that stays inside the root is followed, and that is right: a dotfile linked in from a
 * dotfiles directory is how many people keep their settings. But a repository chooses its links
 * too, and one that points `.cursorignore` at `.env` makes the change land in a file the owner
 * never named. So the owner is told. Only links BELOW the root count: the root is measured from
 * where it really is, so a home directory that is itself a link (or `/tmp`, on a Mac) is how the
 * machine is laid out and not something a repository did. Without a root there is nothing to
 * measure from, and every link in the path counts.
 */
export function linkTarget(file: string, real: string, root: string | undefined): string | null {
  const asked = resolve(file);
  const top = root === undefined ? null : resolve(root);
  // The root itself is not "below" itself: a file named as its own root has no way to be unlinked.
  const below = top !== null && asked !== top && within(asked, top);
  const expected = below ? resolve(resolveRealPath(top), relative(top, asked)) : asked;
  return real === expected ? null : real;
}

/**
 * What a plan says to the owner about a link in its path, as the one notice it takes. A plan that
 * was refused for its path has said where the path leads already, and never opened the file.
 */
export function linkNotices(
  file: string,
  real: string,
  root: string | undefined,
  refused: PlanRefusal | undefined,
): readonly string[] {
  if (refused === 'path-escapes-root' || refused === 'dangling-link') return [];
  return linkTarget(file, real, root) === null ? [] : [linkNotice(file, real)];
}

/** Paths come from a repository, so their control characters are made visible. */
const shown = (path: string): string => neutralizeControls(path);

/** The words for a path that is a link: the link, the file it leads to, and where the change goes. */
export const linkNotice = (file: string, real: string): string =>
  `this path is a link: ${shown(file)} leads to ${shown(real)}; the change lands there`;
