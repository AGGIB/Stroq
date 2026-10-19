import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Scratch git repositories for the tests of `stroq inspect --changed-from`. Each lives in a
 * temporary folder of its own, with HOME and the global git config pointed inside it, so no
 * setting of the machine running the tests reaches it.
 */

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: join(cwd, '.none'),
    },
  });
}

/** A new repository on `main`; its folder is added to `dirs` for the caller to remove. */
export function scratchRepo(dirs: string[], prefix = 'stroq-scratch-repo-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  git(dir, 'init', '-q', '-b', 'main', '.');
  return dir;
}

export function writeFiles(dir: string, files: Readonly<Record<string, string>>): void {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
}

/** Writes `files`, commits everything in the folder, and returns the commit. */
export function commitFiles(dir: string, files: Readonly<Record<string, string>> = {}): string {
  writeFiles(dir, files);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'c');
  return git(dir, 'rev-parse', 'HEAD').trim();
}

/** A `.claude/settings.json` with one command hook per event. */
export const hookSettings = (hooks: Readonly<Record<string, string>>): string =>
  JSON.stringify({
    hooks: Object.fromEntries(
      Object.entries(hooks).map(([event, command]) => [
        event,
        [{ hooks: [{ type: 'command', command }] }],
      ]),
    ),
  });
