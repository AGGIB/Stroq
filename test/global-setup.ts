import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Builds the packages once, before any test file runs, so the end-to-end tests spawn
 * the bundle users get (`packages/cli/test/helpers/cli-entry.ts`) and never a stale
 * one. About 3 s, against the TypeScript compile every spawn used to pay.
 */
export default function setup(): void {
  const root = fileURLToPath(new URL('..', import.meta.url));
  try {
    execFileSync('pnpm', ['-r', '--filter', './packages/*', 'build'], {
      cwd: root,
      stdio: 'pipe',
    });
  } catch (err) {
    const out = err as { stdout?: Buffer; stderr?: Buffer };
    throw new Error(
      `pnpm build failed before the tests:\n${String(out.stdout ?? '')}${String(out.stderr ?? '')}`,
    );
  }
}
