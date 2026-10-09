import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HardenEnv } from '../../src/harden/types.js';

/**
 * Throwaway directories for the harden tests. Every test builds its own home and its own
 * "project" here and passes them in explicitly: nothing in this suite reads or writes the real
 * home directory.
 *
 * `realpathSync` so that the paths a test compares are the ones the engine resolves to
 * (`/tmp` is a link on macOS, and the engine reports real paths).
 */
const made: string[] = [];

export function tempDir(label = 'dir'): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `stroq-harden-${label}-`)));
  made.push(dir);
  return dir;
}

export function removeTempDirs(): void {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export const FIXED_NOW = new Date('2026-10-10T10:00:00.000Z');

/** An env around `home` with a fixed clock, so ids and times in assertions are exact. */
export function fakeEnv(home: string, overrides: Partial<HardenEnv> = {}): HardenEnv {
  return { home, now: () => FIXED_NOW, version: '0.0.0-test', ...overrides };
}

/** A clock that moves forward one second each time it is read, for tests about "newest". */
export function steppingClock(start = FIXED_NOW): () => Date {
  let at = start.getTime();
  return () => {
    const now = new Date(at);
    at += 1000;
    return now;
  };
}
