import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Throwaway directories for the tests of the directory reader. Each test makes its own, under the
 * temporary directory of the machine, and none of them looks at the real home. `realpathSync` so that
 * the paths a test compares are the ones the reader resolves to (`/tmp` is a link on macOS).
 */
const made: string[] = [];

export function tempRoot(label = 'dir'): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `stroq-install-${label}-`)));
  made.push(root);
  return root;
}

export function removeTempRoots(): void {
  for (const root of made.splice(0)) rmSync(root, { recursive: true, force: true });
}

/**
 * Writes files under `root`, making the folders they need: `{ 'a/b.txt': 'text' }` puts `b.txt` in
 * a folder `a`. A path is given with `/` and joined the way the platform wants it.
 */
export function writeFiles(
  root: string,
  files: Readonly<Record<string, string | Uint8Array>>,
): void {
  for (const [path, content] of Object.entries(files)) {
    const file = join(root, ...path.split('/'));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}
