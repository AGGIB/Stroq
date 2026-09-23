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
    // On Windows `pnpm` is `pnpm.cmd`, which Node only runs through a shell.
    const windows = process.platform === 'win32';
    execFileSync(windows ? 'pnpm.cmd' : 'pnpm', ['-r', '--filter', './packages/*', 'build'], {
      cwd: root,
      stdio: 'pipe',
      shell: windows,
    });
  } catch (err) {
    const out = err as { stdout?: Buffer; stderr?: Buffer };
    throw new Error(
      `pnpm build failed before the tests:\n${String(out.stdout ?? '')}${String(out.stderr ?? '')}`,
    );
  }
}
