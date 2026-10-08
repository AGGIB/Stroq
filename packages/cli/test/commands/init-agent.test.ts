import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runInitCommand } from '../../src/commands/init-agent.js';
import { fakeTerminal } from '../helpers/fake-terminal.js';
import { squash } from '../helpers/flow-deps.js';

// These tests are not about Windows: `init` writes the usual quoted line on every machine they run on.
vi.mock('../../src/commands/hook-command.js', async () =>
  (await import('../helpers/plain-hook-line.js')).plainHookLine(),
);

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

  // The advice is a command to run, and `--user` is part of what was asked for.
  it('keeps --user in the commands it prints when several agents are found', async () => {
    has('.cursor');
    has('.codex');
    const { text } = await bare('--user');
    expect(text).toContain('stroq init --agent cursor --user');
    expect(text).toContain('stroq init --agent codex --user');
  });

  it('keeps --user in the commands it advises after installing', async () => {
    has('.claude');
    has('.cursor');
    const { stderr } = await bare('--user');
    expect(stderr).toContain('stroq init --agent cursor --user');
  });

  it('prints no --user when it was not asked for', async () => {
    has('.claude');
    has('.cursor');
    const { stderr } = await bare();
    expect(stderr).toContain('stroq init --agent cursor');
    expect(stderr).not.toContain('--user');
  });
});

/**
 * On a terminal a person is looking at, `stroq init` draws the first-run screen; everywhere else,
 * and whatever the arguments say not to draw for, it is the plain installer. These hand
 * `runInitCommand` a terminal of their own. They name Copilot, which the self-check has no event
 * for, so that nothing here starts a process.
 */
describe('stroq init on a terminal', () => {
  beforeEach(() => {
    // The spinner turns on a timer of its own where it animates; this clock never runs by itself.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const copilotHooks = (): string => join(cwd, '.github', 'hooks', 'stroq.json');

  it('draws the first-run screen on an interactive terminal, and installs with --yes', async () => {
    const screen = fakeTerminal({ interactive: true });
    const cap = capture();

    const code = await runInitCommand(['--yes', '--agent', 'copilot'], { terminal: screen.term });
    cap.restore();

    expect(code).toBe(0);
    expect(screen.out()).toContain('Agents on this machine');
    expect(screen.out()).toContain('Guard Copilot CLI in this project? yes (--yes)');
    // Copilot reads its hooks when it starts, and its note says to restart it: not guarding yet.
    expect(squash(screen.out())).toContain(
      'Done. Stroq is not guarding Copilot CLI yet: do what its note above says first.',
    );
    expect(existsSync(copilotHooks())).toBe(true);
  });

  it('draws it on the terminal it was given, and prints none of it on the real streams', async () => {
    const screen = fakeTerminal({ interactive: true });
    const cap = capture();

    await runInitCommand(['--yes', '--agent', 'copilot'], { terminal: screen.term });
    cap.restore();

    for (const text of ['Agents on this machine', 'Stroq hooks installed in', 'Done.']) {
      expect(cap.out()).not.toContain(text);
      expect(cap.err()).not.toContain(text);
    }
  });

  it('asks first when it is not told --yes, and changes nothing on a no', async () => {
    const screen = fakeTerminal({ interactive: true, answers: ['n'] });
    const cap = capture();

    const code = await runInitCommand(['--agent', 'copilot'], { terminal: screen.term });
    cap.restore();

    // Not a success: `stroq init && claude` must not go on as if Claude Code were guarded.
    expect(code).toBe(1);
    expect(screen.prompts).toHaveLength(1);
    expect(screen.out()).toContain('Nothing was changed.');
    expect(existsSync(copilotHooks())).toBe(false);
  });

  it('is the plain installer, with no first-run screen, on a terminal that is not interactive', async () => {
    const screen = fakeTerminal({ interactive: false });
    const cap = capture();

    const code = await runInitCommand(['--yes', '--agent', 'copilot'], { terminal: screen.term });
    cap.restore();

    expect(code).toBe(0);
    expect(screen.writes).toEqual([]);
    expect(screen.read).not.toHaveBeenCalled();
    expect(cap.out()).toContain('Stroq hooks installed in');
    expect(cap.out()).not.toContain('Agents on this machine');
    expect(existsSync(copilotHooks())).toBe(true);
  });

  // An interactive terminal in every row: the arguments are the only reason not to draw.
  it.each([
    ['--no-input', ['--no-input', '--agent', 'copilot'], 0, 'Stroq hooks installed in'],
    ['--dry-run', ['--dry-run', '--agent', 'copilot'], 0, '"preToolUse"'],
    ['a bare --dry-run', ['--dry-run'], 0, '"PreToolUse"'],
    ['--agent mcp', ['--yes', '--agent', 'mcp'], 1, 'needs exactly one of --client'],
    ['--agent nonsense', ['--yes', '--agent', 'nonsense'], 1, 'unknown agent "nonsense"'],
  ] as const)(
    'is the plain installer, with no first-run screen, for %s',
    async (_name, args, exit, said) => {
      const screen = fakeTerminal({ interactive: true, answers: ['y'] });
      const cap = capture();

      const code = await runInitCommand([...args], { terminal: screen.term });
      cap.restore();

      expect(code).toBe(exit);
      expect(screen.writes).toEqual([]);
      expect(screen.read).not.toHaveBeenCalled();
      expect(cap.out()).toContain(said);
    },
  );

  it('writes nothing for --dry-run, and prints the config it would write as JSON', async () => {
    const screen = fakeTerminal({ interactive: true });
    const cap = capture();

    await runInitCommand(['--dry-run', '--agent', 'copilot'], { terminal: screen.term });
    cap.restore();

    expect(() => JSON.parse(cap.out())).not.toThrow();
    expect(existsSync(copilotHooks())).toBe(false);
  });
});

describe('stroq init with no --agent, where the home is not set', () => {
  // `os.homedir()` is '' for a `HOME` that is set and empty, and a path joined to '' is the project's own:
  // a folder that came with a repository must not choose the agent.
  it('does not take the folders of the project for the agents of the user', async () => {
    mkdirSync(join(cwd, '.cursor'), { recursive: true });
    mkdirSync(join(cwd, '.codex'), { recursive: true });
    const cap = capture();

    const code = await runInitCommand(['--dry-run'], { home: '' });
    cap.restore();

    expect(code).toBe(0);
    expect(cap.out()).toContain('"PreToolUse"');
    expect(cap.out()).not.toContain('beforeShellExecution');
    expect(cap.err()).not.toContain('was not found here');
  });
});
