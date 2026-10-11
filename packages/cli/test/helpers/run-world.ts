import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import { runRun, type RunDeps } from '../../src/commands/run.js';

/**
 * A repository, a Stroq home and a user home of their own, and `stroq run --sandbox -- claude` run in them
 * with what it printed. For the tests of what `stroq run --sandbox` says and does with its config.
 */

export const SRT = '/usr/local/bin/srt';

/** Registers the cleanup that a test file using `world` needs: the directories it made, and the env it stubbed. */
export function useWorlds(): void {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
}

const roots: string[] = [];

/** A directory that is removed after the test, by its real path: where a link leads is not what these tests are about. */
export function scratch(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(dir);
  return dir;
}

export interface World {
  readonly cwd: string;
  readonly home: string;
  readonly userHome: string;
}

/** A git repository to run in, with a Stroq home and a user home of its own, both empty. */
export function world(): World {
  const cwd = scratch('stroq-run-sandbox-');
  const home = join(scratch('stroq-run-home-'), '.stroq');
  const userHome = scratch('stroq-run-user-');
  mkdirSync(home);
  execFileSync('git', ['init', '-q', '.'], { cwd, env: { ...process.env, HOME: cwd } });
  vi.stubEnv('STROQ_HOME', home);
  return { cwd, home, userHome };
}

export function capture(): { readonly text: () => string; readonly restore: () => void } {
  const chunks: string[] = [];
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  const sink = ((chunk: string) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stdout.write = sink;
  process.stderr.write = sink;
  return {
    text: () => chunks.join(''),
    restore: () => {
      process.stdout.write = out;
      process.stderr.write = err;
    },
  };
}

/** `stroq run --sandbox` for `claude`, dry or launched, with what it printed. */
export async function sandboxRun(
  w: World,
  deps: RunDeps,
  flags: readonly string[] = ['--dry-run'],
): Promise<string> {
  const out = capture();
  try {
    const code = await runRun(
      [...flags, '--force', '--no-inspect', '--sandbox', '--', 'claude'],
      w.cwd,
      { srt: () => SRT, isTTY: false, userHome: w.userHome, ...deps },
    );
    expect(code).toBe(0);
  } finally {
    out.restore();
  }
  return out.text();
}
