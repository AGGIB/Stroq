/**
 * Whether a recursive delete is aimed outside the working tree.
 *
 * Lives in its own module because both shell readers need it and neither may own
 * it: `classify-bash.ts` applies it to `rm -rf`, `classify-powershell.ts` to
 * `Remove-Item -Recurse` and `rd /s`, and a second copy of this judgement would be
 * a target one reader called dangerous and the other did not.
 */

/** `C:\…`, `c:/…`, and the bare drive on its own. */
const WINDOWS_DRIVE_PATH = /^[A-Za-z]:(?:[\\/]|$)/;
/** `\\server\share` — someone else's filesystem, never the checkout. */
const UNC_PATH = /^\\\\/;

/** Both separators, one casing, no trailing slash — so two spellings compare equal. */
const foldPath = (path: string): string => path.replace(/[\\/]+/g, '/').replace(/\/+$/, '');

export function isDangerousRmTarget(target: string, cwd: string): boolean {
  const t = target.replace(/["']/g, '');
  if (t === '') return false;
  if (['/', '/*', '.', './', '*', './*'].includes(t)) return true;
  // `~`, `~/…` and `~user/…` expand to a home directory, which is never inside a
  // project checkout; `$VAR` is unknown and `..` points upward — all treated as
  // outside the working tree. `$` also covers PowerShell's `$env:USERPROFILE`,
  // which is the same claim about the same directory in a different spelling.
  if (t.startsWith('~') || t.startsWith('$') || t.startsWith('..')) return true;
  if (UNC_PATH.test(t)) return true;
  /**
   * A Windows absolute path, which the POSIX branch below rejected outright because
   * it does not begin with `/` — so `Remove-Item -Recurse -Force C:\` and
   * `rd /s /q C:\Windows` were both "inside the working tree" and carried no class
   * at all. Compared case-insensitively, because Windows resolves `C:\Src` and
   * `c:\src` to one directory and a case-sensitive test would call the second one
   * an outside target for a delete that is in fact inside the checkout.
   */
  if (WINDOWS_DRIVE_PATH.test(t)) {
    const normalized = foldPath(t).toLowerCase();
    const root = foldPath(cwd).toLowerCase();
    return normalized === '' || !normalized.startsWith(`${root}/`);
  }
  if (!t.startsWith('/')) return false;
  const normalized = t.replace(/\/+$/, '');
  return !normalized.startsWith(`${cwd}/`);
}
