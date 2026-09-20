import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

/**
 * Finding a program without running it.
 *
 * Deciding whether an optional tool is installed must not require executing it —
 * `srt --version` on a program that is not `srt` is exactly the thing a launcher
 * should never do — so this is a filesystem probe, the same one `openclawOnPath`
 * already made for the Gateway CLI.
 */

/**
 * Which suffixes count as executable on Windows when nothing says otherwise. The
 * real `PATHEXT` is richer, but a stripped or service environment can be missing it
 * entirely, and without a default every npm-installed CLI (`srt` is `srt.cmd` there)
 * reads as absent.
 */
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/**
 * The first entry on `PATH` that holds `bin` as an executable, or `null`.
 *
 * `env` and `plat` default to the real process; a test overrides them to exercise
 * the Windows rules on a machine that cannot run them, the way `childEnv` does.
 */
export function binOnPath(
  bin: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  plat: NodeJS.Platform = process.platform,
): string | null {
  // On Windows the executable bit does not exist — `access(X_OK)` there reports
  // every readable file as executable — so the suffix is what decides, and an
  // extensionless name has to be tried under each of them.
  const names =
    plat === 'win32'
      ? (env['PATHEXT'] ?? DEFAULT_PATHEXT)
          .split(';')
          .filter((ext) => ext !== '')
          .map((ext) => `${bin}${ext.toLowerCase()}`)
      : [bin];
  for (const entry of (env['PATH'] ?? '').split(delimiter)) {
    if (entry === '') continue;
    for (const name of names) {
      const candidate = join(entry, name);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // not here, or not executable
      }
    }
  }
  return null;
}
