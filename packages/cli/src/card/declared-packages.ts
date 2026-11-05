// The packages a project already depends on, so that running one is not "a package a page named".
//
// `knownPackages` (core) reads one folder: its `package.json`, `requirements*.txt`, `pyproject.toml`
// and `node_modules/.bin`. A session is often started at the root of a workspace whose packages are in
// folders below it, so the folders under the session's own are read too, a few levels down, with bounds:
// a hostile or huge tree costs a fixed amount of reading and no more.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { knownPackages } from '@stroq/core';
import type { DeclaredPackages, Ecosystem } from './package-claims.js';
import { NOTHING_DECLARED } from './package-claims.js';

const MAX_DEPTH = 2;
const MAX_FOLDERS = 120;
const SKIP: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'target',
  'vendor',
  '.venv',
  'venv',
  '__pycache__',
  '.next',
  '.cache',
]);

/** The folder and the folders below it that may hold a manifest, breadth first, bounded. */
function foldersUnder(root: string): string[] {
  const found = [root];
  let level = [root];
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    const next: string[] = [];
    for (const dir of level) {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || SKIP.has(entry.name) || entry.name.startsWith('.')) continue;
        if (found.length >= MAX_FOLDERS) return found;
        next.push(join(dir, entry.name));
        found.push(join(dir, entry.name));
      }
    }
    level = next;
  }
  return found;
}

/** What the project at `cwd` declares or has installed, by registry. Nothing for a folder that is gone. */
export function declaredPackages(cwd: string | null): DeclaredPackages {
  if (cwd === null || cwd === '') return NOTHING_DECLARED;
  const npm = new Set<string>();
  const python = new Set<string>();
  for (const dir of foldersUnder(cwd)) {
    const known = knownPackages(dir);
    for (const name of known.npm) npm.add(name);
    for (const name of known.python) python.add(name);
  }
  return {
    has: (name: string, ecosystem: Ecosystem): boolean =>
      (ecosystem === 'npm' ? npm : python).has(
        ecosystem === 'python' ? name.toLowerCase().replace(/[-_.]+/g, '-') : name,
      ),
  };
}
