import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The developer tools that used to be commands (`pnpm dev:bench`, `dev:coverage`, `dev:prove`), as a
 * process of their own: `scripts/dev/<name>.ts` run by tsx from the repository root, the way the script
 * in package.json runs it. Nothing here starts a shell.
 */
export const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url));

/** The arguments to `process.execPath` that run the tool `name` with `args`. */
export const devToolArgv = (
  name: 'bench' | 'coverage' | 'prove',
  ...args: readonly string[]
): string[] => ['--import', 'tsx', join(REPO_ROOT, 'scripts', 'dev', `${name}.ts`), ...args];
