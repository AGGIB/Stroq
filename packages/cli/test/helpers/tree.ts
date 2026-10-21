import { lstatSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Every entry under `root` with its kind, size and modification time, sorted by path: equal
 * before and after a run means the run created, removed and changed nothing there.
 */
export function treeOf(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      const kind = stat.isDirectory() ? 'd' : stat.isSymbolicLink() ? 'l' : 'f';
      out.push(`${kind} ${relative(root, path)} ${stat.size} ${stat.mtimeMs}`);
      if (kind === 'd') walk(path);
    }
  };
  walk(root);
  return out.sort();
}
