import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The directory one run puts all its temporary files in. */
const RUN_PREFIX = 'stroq-test-run-';
/** A run directory older than this was left by a run that did not end properly. */
const STALE_MS = 60 * 60 * 1000;

/** Removes a directory of ours. A failure is said, not thrown: it must not stop a run of tests. */
function remove(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch (err) {
    console.warn(`could not remove ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Removes the run directories that earlier runs left behind when they were killed. Anything
 * else in the temporary directory is not ours and is not touched.
 */
function removeStaleRuns(parent: string): void {
  const now = Date.now();
  for (const name of readdirSync(parent)) {
    if (!name.startsWith(RUN_PREFIX)) continue;
    const path = join(parent, name);
    try {
      if (now - statSync(path).mtimeMs > STALE_MS) remove(path);
    } catch {
      // Gone since it was listed: another run ended and removed it.
    }
  }
}

/**
 * Builds the packages once, before any test file runs, so the end-to-end tests spawn
 * the bundle users get (`packages/cli/test/helpers/cli-entry.ts`) and never a stale
 * one. About 3 s, against the TypeScript compile every spawn used to pay.
 *
 * It also gives the run one temporary directory of its own and removes it at the end. The
 * tests make thousands of directories (a fake home for every file, a project for every
 * case) and none removes its own: before this, a developer's temporary directory held 60,000
 * of them, 870 MiB, after a few weeks of runs, and a full disk made unrelated tests fail.
 */
export default function setup(): () => void {
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
  const parent = tmpdir();
  removeStaleRuns(parent);
  const runDir = mkdtempSync(join(parent, RUN_PREFIX));
  // `os.tmpdir()` reads these, in the test workers and in the CLIs they spawn, which inherit them.
  for (const name of ['TMPDIR', 'TMP', 'TEMP']) process.env[name] = runDir;
  return () => remove(runDir);
}
