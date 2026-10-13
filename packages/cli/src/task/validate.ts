import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { PermitBody } from '@stroq/core';

const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
};

/** Resolve existing ancestors too, when the Stroq home is not created yet. */
export function canonicalTaskHome(path: string): string {
  let head = resolve(path);
  const suffix: string[] = [];
  while (!existsSync(head)) {
    if (dirname(head) === head) throw new Error('the Stroq home has no accessible filesystem root');
    suffix.unshift(basename(head));
    head = dirname(head);
  }
  return join(realpathSync(head), ...suffix);
}

/** A filesystem carve-out must never re-open the signing key through an ancestor or an alias. */
export function validateTaskPaths(body: PermitBody, home: string, hookOnly: boolean): void {
  if (hookOnly) return;
  const root = body.projectRoot;
  const state = canonicalTaskHome(home);
  if (inside(root, state))
    throw new Error('the project contains the Stroq home; choose a project below it');
  if (/[\[\]{}!]/.test(root))
    throw new Error('sandbox project paths cannot contain pattern metacharacters');
  for (const glob of [...body.scope.read.allow, ...body.scope.write.allow]) {
    if (/[\[\]{}!]/.test(glob)) throw new Error('sandbox globs support only * and ?');
    if (
      process.platform !== 'darwin' &&
      body.scope.write.allow.includes(glob) &&
      /[*?]/.test(glob.replace(/\/\*\*$/, ''))
    )
      throw new Error('this platform supports literal --write roots or a trailing /** only');
  }
  const pending = [root];
  let count = 0;
  while (pending.length > 0) {
    const dir = pending.pop() as string;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (++count > 100_000)
        throw new Error('project is too large to check sandbox aliases (100000 entries)');
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        if (!inside(root, realpathSync(path)))
          throw new Error('project has a link outside its root; no sandbox task started');
      } else if (entry.isDirectory()) pending.push(path);
    }
  }
}
