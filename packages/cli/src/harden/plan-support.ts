import { assertWriteAllowed } from './atomic.js';
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
