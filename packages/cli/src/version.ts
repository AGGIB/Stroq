import { readFileSync } from 'node:fs';

/**
 * The published CLI version, read from the package manifest rather than duplicated
 * in source so it can never disagree with the artifact npm actually ships.
 * `../package.json` resolves to the same file from `src/version.ts` and from the
 * bundled `dist/index.js`, and npm always includes the manifest in the tarball.
 */
export function stroqVersion(): string {
  const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  return (JSON.parse(raw) as { version: string }).version;
}
