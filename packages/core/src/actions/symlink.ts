import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

/**
 * Where a path a tool names really goes, or null when it goes where it says.
 *
 * `project_settings.json` can be a symlink to `~/.ssh/authorized_keys`, and the agent is
 * asked, by a README, to "update" it (Wiz GhostApproval, 2026-07; Adversa SymJack, 2026-05).
 * The approval dialog shows the name in the project, the kernel follows the link, and the
 * key is written outside the workspace. A check that reads only the spelling of the path
 * sees a settings file in the project.
 *
 * So the path is resolved on disk: through a link at the end, through a link anywhere
 * above it, and — for a file that does not exist yet — through a link in the directory it
 * would be created in. A link whose target is missing is followed by hand, because a write
 * through it creates the target. This asks the filesystem about one path the agent named,
 * which `normalizePathForMatch` declines to do (see there); the cost is one `lstat` and
 * one `realpath` per file the agent opens, and the question it answers is worth that.
 */
const MAX_HOPS = 40;
const MAX_ANCESTOR_STEPS = 64;

export function resolveThroughLinks(rawPath: string, cwd: string): string | null {
  if (rawPath === '' || rawPath.includes('\0') || rawPath.startsWith('~')) return null;
  const start = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);
  try {
    const real = realpathSync.native(start);
    return real === start ? null : real;
  } catch {
    // Missing: either a file about to be created, or a link whose target is not there.
  }
  let current = start;
  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    let target: string;
    try {
      if (!lstatSync(current).isSymbolicLink()) break;
      target = readlinkSync(current);
    } catch {
      break;
    }
    current = isAbsolute(target) ? target : resolve(dirname(current), target);
  }
  // What is left does not exist, so it is resolved from its nearest ancestor that does: a
  // link in any directory above it still counts, and so does a directory that is itself
  // missing (`proj/lib/LaunchAgents/x.plist` where `lib` is a link to `~/Library`).
  let ancestor = current;
  const rest: string[] = [];
  for (let step = 0; step < MAX_ANCESTOR_STEPS; step += 1) {
    try {
      const real = realpathSync.native(ancestor);
      const resolved = rest.length === 0 ? real : join(real, ...rest);
      return resolved === start ? null : resolved;
    } catch {
      const parent = dirname(ancestor);
      if (parent === ancestor) break;
      rest.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
  return current === start ? null : current;
}
