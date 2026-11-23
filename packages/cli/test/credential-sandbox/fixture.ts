import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, vi } from 'vitest';
import { runInit } from '../../src/commands/init.js';
import type { SandboxChoices } from '../../src/credential-sandbox/rules.js';
import type { SandboxLocation } from '../../src/credential-sandbox/status.js';

/**
 * A throwaway home for one test: its own `~/.claude`, `~/.stroq` and project folder, with what the
 * commands print kept in `out` (stdout) and `err` (stderr). Nothing here reads a real home, and
 * every file a test puts in it is inert text.
 */
export interface SandboxHome {
  home: string;
  cwd: string;
  settings: string;
  stroq: string;
  out: string[];
  err: string[];
  where: SandboxLocation;
}

export const entry = (path: string) => ({ path, mode: 'deny' });

export function save(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
}

export const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf8'));

/** The one ownership record of this home. */
export function ledgerFile(stroq: string): string {
  const dir = join(stroq, 'sandbox');
  return join(dir, readdirSync(dir)[0]!);
}

/** A user-scope install on macOS, as an interactive run makes it once a person has answered. */
export const asked = (choices: SandboxChoices = {}, args: string[] = []) =>
  runInit(['--user', ...args], { platform: 'darwin', sandbox: choices });

export function useSandboxHome(): SandboxHome {
  const f = {} as SandboxHome;
  beforeEach(() => {
    f.home = mkdtempSync(join(tmpdir(), 'stroq-credentials-'));
    f.cwd = join(f.home, 'project');
    mkdirSync(f.cwd);
    f.settings = join(f.home, '.claude/settings.json');
    f.stroq = join(f.home, '.stroq');
    f.out = [];
    f.err = [];
    f.where = {
      home: f.home,
      cwd: f.cwd,
      platform: 'darwin',
      managedDir: join(f.home, 'managed'),
      env: {},
    };
    vi.stubEnv('HOME', f.home);
    vi.stubEnv('USERPROFILE', f.home);
    vi.stubEnv('CLAUDE_CONFIG_DIR', undefined);
    vi.stubEnv('STROQ_HOME', f.stroq);
    vi.spyOn(process, 'cwd').mockReturnValue(f.cwd);
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      f.out.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      f.err.push(String(chunk));
      return true;
    });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  return f;
}
