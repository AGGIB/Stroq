import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runInitCommand } from '../../src/commands/init-agent.js';

/**
 * A bare `stroq init` is the command the front page and the site tell a newcomer to run.
 * It used to install Claude Code's hooks whatever was on the machine, so someone who had
 * only Cursor got a settings file nobody reads, and `stroq doctor` then read green
 * because "at least one agent" was guarded.
 */

let home = '';
let cwd = '';

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stroq-init-agent-home-'));
  cwd = mkdtempSync(join(tmpdir(), 'stroq-init-agent-cwd-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('STROQ_HOME', mkdtempSync(join(tmpdir(), 'stroq-init-agent-stroq-')));
  vi.spyOn(process, 'cwd').mockReturnValue(cwd);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function capture(): { out: () => string; err: () => string; restore: () => void } {
  const out: string[] = [];
  const err: string[] = [];
  const spyOut = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  const spyErr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    err.push(String(chunk));
    return true;
  });
  return {
    out: () => out.join(''),
    err: () => err.join(''),
    restore: () => {
      spyOut.mockRestore();
      spyErr.mockRestore();
    },
  };
}

const has = (dir: string): void => {
  mkdirSync(join(home, dir), { recursive: true });
};

async function bare(
  ...args: string[]
): Promise<{ code: number; text: string; stdout: string; stderr: string }> {
  const cap = capture();
  const code = await runInitCommand(['--dry-run', ...args]);
  cap.restore();
  return { code, text: cap.out() + cap.err(), stdout: cap.out(), stderr: cap.err() };
}

describe('stroq init with no --agent', () => {
  it('installs for the one agent found when it is not Claude Code', async () => {
    has('.cursor');
    const { code, text } = await bare();
    expect(code).toBe(0);
    expect(text).toContain('beforeShellExecution');
    expect(text).not.toContain('"PreToolUse"');
    expect(text).toMatch(/Claude Code was not found here/);
  });

  it('installs for Claude Code as before when it is found', async () => {
    has('.claude');
    const { code, text } = await bare();
    expect(code).toBe(0);
    expect(text).toContain('"PreToolUse"');
  });

  it('installs for Claude Code as before when no agent is found at all', async () => {
    const { code, text } = await bare();
    expect(code).toBe(0);
    expect(text).toContain('"PreToolUse"');
  });

  it('names the other agents found and the command that guards each', async () => {
    has('.claude');
    has('.cursor');
    has('.codex');
    const { text } = await bare();
    expect(text).toContain('not guarded');
    expect(text).toContain('stroq init --agent cursor');
    expect(text).toContain('stroq init --agent codex');
  });

  it('does not offer an agent whose hooks are already there', async () => {
    has('.claude');
    has('.cursor');
    mkdirSync(join(cwd, '.cursor'), { recursive: true });
    // Cursor guarded for real (project scope), then a bare init again.
    const guard = capture();
    await runInitCommand(['--agent', 'cursor']);
    guard.restore();
    const { text } = await bare();
    expect(text).not.toContain('stroq init --agent cursor');
  });

  it('guesses nothing when several agents are found and Claude Code is not one of them', async () => {
    has('.cursor');
    has('.codex');
    const { code, text } = await bare();
    expect(code).toBe(1);
    expect(text).toContain('stroq init --agent cursor');
    expect(text).toContain('stroq init --agent codex');
    expect(text).not.toContain('"PreToolUse"');
    expect(text).not.toContain('beforeShellExecution');
  });

  it('leaves an explicit --agent alone, whatever else is found', async () => {
    has('.cursor');
    has('.codex');
    const { code, text } = await bare('--agent', 'codex');
    expect(code).toBe(0);
    expect(text).toContain('codex');
    expect(text).not.toMatch(/Claude Code was not found here/);
  });

  it('leaves --agent=<name> alone too', async () => {
    has('.cursor');
    const { code, text } = await bare('--agent=cursor');
    expect(code).toBe(0);
    expect(text).not.toMatch(/Claude Code was not found here/);
  });

  // `init --dry-run` prints the config it would write, and prose in front of it is a
  // file that no longer parses; the advice goes to stderr.
  it('keeps --dry-run output pure JSON when it also has advice to give', async () => {
    has('.claude');
    has('.cursor');
    const { stdout, stderr } = await bare();
    expect(() => JSON.parse(stdout)).not.toThrow();
    expect(stderr).toContain('not guarded');
    expect(stdout).not.toContain('not guarded');
  });

  // A folder that came with a repository says what its authors use, not what is
  // installed here; it must not decide which agent's config is written.
  it.each(['.agents', '.cursor', '.codex'])(
    'is not decided by a %s folder in the project',
    async (dir) => {
      mkdirSync(join(cwd, dir), { recursive: true });
      const { code, stdout, stderr } = await bare();
      expect(code).toBe(0);
      expect(stdout).toContain('"PreToolUse"');
      expect(stderr).not.toContain('not guarded');
      expect(stderr).not.toContain('was not found here');
    },
  );
});
