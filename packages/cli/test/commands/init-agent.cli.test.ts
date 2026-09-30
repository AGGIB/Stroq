import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLI_ENTRY } from '../helpers/cli-entry.js';

/**
 * `init-agent.test.ts` calls `runInitCommand` directly, which is not how a user reaches
 * it: `stroq init` goes through the command table in `index.ts`. These run the built CLI,
 * in a home and a project made for the test (the repository's own directory has a
 * `.claude` and would always be read as Claude Code).
 */
function init(homeDirs: readonly string[], ...args: string[]) {
  const home = mkdtempSync(join(tmpdir(), 'stroq-init-cli-home-'));
  const project = mkdtempSync(join(tmpdir(), 'stroq-init-cli-project-'));
  for (const dir of homeDirs) mkdirSync(join(home, dir), { recursive: true });
  return spawnSync(process.execPath, [CLI_ENTRY, 'init', '--dry-run', ...args], {
    cwd: project,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      STROQ_HOME: mkdtempSync(join(tmpdir(), 'stroq-init-cli-stroq-')),
    },
    timeout: 60_000,
  });
}

describe('stroq init, through the built CLI', () => {
  it('guards the one agent found when it is not Claude Code', () => {
    const r = init(['.cursor']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('beforeShellExecution');
    expect(r.stdout).not.toContain('"PreToolUse"');
    expect(r.stderr).toContain('Claude Code was not found here');
  });

  it('installs nothing and says what to run when several other agents are found', () => {
    const r = init(['.cursor', '.codex']);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('stroq init --agent cursor');
    expect(r.stdout).toContain('stroq init --agent codex');
  });

  it('guards Claude Code when nothing is found, as it always did', () => {
    const r = init([]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('"PreToolUse"');
  });

  it('leaves an explicit --agent alone', () => {
    const r = init(['.cursor', '.codex'], '--agent', 'codex');
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain('was not found here');
  });
});
