import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowDeps } from '../../src/commands/init-flow.js';
import { runInteractiveInit, tilde } from '../../src/commands/init-interactive.js';
import { readInstallRecord } from '../../src/commands/install-record.js';
import { stroqVersion } from '../../src/version.js';
import { fakeTerminal, fakeTimers, type FakeTerminalOptions } from '../helpers/fake-terminal.js';
import { squash } from '../helpers/flow-deps.js';

// These tests are not about Windows: `init` writes the usual quoted line on every machine they run on.
vi.mock('../../src/commands/hook-command.js', async () =>
  (await import('../helpers/plain-hook-line.js')).plainHookLine(),
);

/**
 * The wiring of the first-run screen, with the real installer behind it: a home and a project made
 * for each test, and a self-check that starts nothing. What the person sees is a fake terminal's.
 */
let home = '';
let cwd = '';
let stroqHome = '';

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stroq-interactive-home-'));
  cwd = mkdtempSync(join(tmpdir(), 'stroq-interactive-cwd-'));
  stroqHome = mkdtempSync(join(tmpdir(), 'stroq-interactive-stroq-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('STROQ_HOME', stroqHome);
  vi.spyOn(process, 'cwd').mockReturnValue(cwd);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const has = (dir: string): void => {
  mkdirSync(join(home, dir), { recursive: true });
};

const hookCommandsIn = (file: string, event: string): string[] => {
  const settings = JSON.parse(readFileSync(file, 'utf8')) as {
    hooks: Record<string, { hooks: { command: string }[] }[]>;
  };
  return (settings.hooks[event] ?? []).flatMap((group) => group.hooks.map((h) => h.command));
};

/** Runs the screen as `args` say, for a person who types `terminal.answers`; the check starts nothing. */
async function init(args: string[], terminal: FakeTerminalOptions = {}) {
  const fake = fakeTerminal(terminal);
  const check = vi.fn<FlowDeps['check']>(async () => null);
  const code = await runInteractiveInit(
    args,
    fake.term,
    { cwd, home },
    { check, timers: fakeTimers().timers },
  );
  return { code, fake, check };
}

describe('tilde', () => {
  it('shows a path inside the home directory from ~', () => {
    expect(tilde('/home/ann/.aws/credentials', '/home/ann')).toBe('~/.aws/credentials');
  });

  it('shows the home directory itself as ~', () => {
    expect(tilde('/home/ann', '/home/ann')).toBe('~');
  });

  it('leaves a path outside the home directory alone', () => {
    expect(tilde('/srv/app/.env', '/home/ann')).toBe('/srv/app/.env');
  });

  it('does not take a longer name that starts with the home for a path inside it', () => {
    expect(tilde('/home/ann2/.env', '/home/ann')).toBe('/home/ann2/.env');
    expect(tilde('/home/alice/.env', '/home/al')).toBe('/home/alice/.env');
  });

  it('writes Windows separators as slashes', () => {
    expect(tilde('C:\\Users\\ann\\.aws\\credentials', 'C:\\Users\\ann')).toBe('~/.aws/credentials');
  });

  // `os.homedir()` is '' for a HOME that is set and empty, and every path starts with ''.
  it('leaves a path alone when there is no home directory to be inside of', () => {
    expect(tilde('/srv/app/.env', '')).toBe('/srv/app/.env');
  });
});

describe('runInteractiveInit, answered yes with --yes', () => {
  it('guards Claude Code in the project when it is found in the home directory', async () => {
    has('.claude');

    const { code, fake } = await init(['--yes']);

    expect(code).toBe(0);
    const file = join(cwd, '.claude', 'settings.json');
    expect(existsSync(file)).toBe(true);
    const commands = hookCommandsIn(file, 'PreToolUse');
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatch(/ hook claude-code$/);
    expect(fake.out()).toContain('Claude Code');
    expect(fake.out()).toContain('Guard Claude Code in this project? yes (--yes)');
    expect(fake.out()).toContain('Done. Stroq is guarding Claude Code');
  });

  it('shows the version of the CLI in its header', async () => {
    const { fake } = await init(['--yes']);

    expect(fake.out()).toContain(`stroq ${stroqVersion()}`);
  });

  it('checks the command that was written, and no other', async () => {
    has('.claude');

    const { check } = await init(['--yes']);

    const written = hookCommandsIn(join(cwd, '.claude', 'settings.json'), 'PreToolUse')[0];
    expect(check).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledWith('claude-code', written);
    expect(readInstallRecord().entries['claude-code:project']?.command).toBe(written);
  });

  it('says the agent could not be tested from here when the check cannot run', async () => {
    has('.claude');

    const { code, fake } = await init(['--yes']);

    expect(code).toBe(0);
    expect(fake.out()).toContain("can't be tested from here");
  });

  // The screen cuts the project from the path at a slash, so on Windows it shows the whole path.
  it.skipIf(process.platform === 'win32')(
    'shows the config of the agent from the project, as the docs show it',
    async () => {
      has('.claude');

      const { fake } = await init(['--yes']);

      expect(fake.out()).toMatch(/✔ Claude Code\s+\.claude\/settings\.json/);
      expect(fake.out()).toMatch(/– Cursor\s+not found/);
    },
  );

  it('guards Claude Code when no agent at all is found, as the plain installer does', async () => {
    const { code, fake } = await init(['--yes']);

    expect(code).toBe(0);
    expect(existsSync(join(cwd, '.claude', 'settings.json'))).toBe(true);
    expect(fake.out()).toContain('Guard Claude Code in this project?');
    expect(fake.out()).toMatch(/– Claude Code\s+not found/);
  });

  it('guards each agent that is found when Claude Code is not one of them', async () => {
    has('.cursor');
    has('.codex');

    const { code, fake, check } = await init(['--yes']);

    expect(code).toBe(0);
    expect(existsSync(join(cwd, '.cursor', 'hooks.json'))).toBe(true);
    expect(existsSync(join(cwd, '.codex', 'hooks.json'))).toBe(true);
    expect(existsSync(join(cwd, '.claude', 'settings.json'))).toBe(false);
    expect(fake.out()).toContain('Guard these 2 agents in this project?');
    expect(check.mock.calls.map(([id]) => id)).toEqual(['cursor', 'codex']);
  });

  it('writes the user config, not the project, with --user', async () => {
    has('.claude');

    const { code, fake } = await init(['--user', '--yes']);

    expect(code).toBe(0);
    expect(existsSync(join(home, '.claude', 'settings.json'))).toBe(true);
    expect(existsSync(join(cwd, '.claude', 'settings.json'))).toBe(false);
    expect(fake.out()).toContain('Guard Claude Code in your user config?');
    expect(fake.out()).toMatch(/✔ Claude Code\s+~\/\.claude\/settings\.json/);
  });

  it('installs for Copilot only with --agent copilot, though Claude Code is here too', async () => {
    has('.claude');

    const { code, fake, check } = await init(['--agent', 'copilot', '--yes']);

    expect(code).toBe(0);
    expect(existsSync(join(cwd, '.github', 'hooks', 'stroq.json'))).toBe(true);
    expect(existsSync(join(cwd, '.claude', 'settings.json'))).toBe(false);
    expect(fake.out()).toContain('Guard Copilot CLI in this project?');
    expect(check.mock.calls.map(([id]) => id)).toEqual(['copilot']);
  });

  it('takes --agent=<name> as it takes --agent <name>', async () => {
    const { code } = await init(['--agent=copilot', '--yes']);

    expect(code).toBe(0);
    expect(existsSync(join(cwd, '.github', 'hooks', 'stroq.json'))).toBe(true);
  });

  it('installs nothing, and exits 1, for an agent that is not one it knows', async () => {
    const { code, fake } = await init(['--agent', 'nonsense', '--yes']);

    expect(code).toBe(1);
    expect(squash(fake.out())).toContain('nothing was installed');
    expect(existsSync(join(cwd, '.claude'))).toBe(false);
  });

  it('shows where it keeps what it records, from ~ when that is inside the home', async () => {
    vi.stubEnv('STROQ_HOME', join(home, '.stroq'));

    const { fake } = await init(['--yes']);

    expect(squash(fake.out())).toContain('writes ~/.stroq: the audit log');
  });

  it('shows where it keeps what it records, in full, when that is outside the home', async () => {
    const { fake } = await init(['--yes']);

    expect(squash(fake.out())).toContain(`writes ${stroqHome}: the audit log`);
  });
});

describe('runInteractiveInit, asking', () => {
  it('asks before it writes, and guards the agent when the answer is yes', async () => {
    has('.claude');

    const { code, fake } = await init([], { answers: ['y'] });

    expect(code).toBe(0);
    expect(fake.prompts).toHaveLength(1);
    expect(fake.prompts[0]).toContain('Guard Claude Code in this project?');
    expect(existsSync(join(cwd, '.claude', 'settings.json'))).toBe(true);
  });

  it('changes nothing when the answer is n', async () => {
    has('.claude');

    const { code, fake, check } = await init([], { answers: ['n'] });

    expect(code).toBe(1);
    expect(existsSync(join(cwd, '.claude', 'settings.json'))).toBe(false);
    expect(existsSync(join(stroqHome, 'install.json'))).toBe(false);
    expect(fake.out()).toContain('Nothing was changed.');
    expect(check).not.toHaveBeenCalled();
  });

  it('changes nothing when the input ends before there is an answer', async () => {
    has('.claude');

    const { code } = await init([]);

    expect(code).toBe(1);
    expect(existsSync(join(cwd, '.claude'))).toBe(false);
  });
});

describe('runInteractiveInit, when the installer fails', () => {
  it('exits 1, says why, and leaves the file as it was', async () => {
    has('.claude');
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    const file = join(cwd, '.claude', 'settings.json');
    writeFileSync(file, '{ not json');

    const { code, fake, check } = await init(['--yes']);

    expect(code).toBe(1);
    expect(fake.out()).toContain('Claude Code: cannot parse');
    expect(fake.out()).toContain(
      'Run `stroq init --agent claude-code --no-input` to see everything it said.',
    );
    expect(readFileSync(file, 'utf8')).toBe('{ not json');
    expect(check).not.toHaveBeenCalled();
    expect(readInstallRecord().entries['claude-code:project']).toBeUndefined();
  });
});

describe('runInteractiveInit, what the installer prints', () => {
  /** The real streams, caught: what reaches them is what a person would see scroll by. */
  function spyOnStreams(): { out: string[]; err: string[] } {
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      err.push(String(chunk));
      return true;
    });
    return { out, err };
  }

  it('does not reach the real standard output or error: the screen shows it instead', async () => {
    has('.claude');
    const streams = spyOnStreams();

    const { fake } = await init(['--yes']);

    const leaked = `${streams.out.join('')}${streams.err.join('')}`;
    for (const printed of [
      'Stroq hooks installed in',
      'PreToolUse',
      'To remove them',
      'Agents on this machine',
    ])
      expect(leaked).not.toContain(printed);
    expect(fake.out()).toContain('hooks installed in');
  });

  it('puts what the installer wrote on standard error on the screen, and not on the real one', async () => {
    mkdirSync(join(cwd, '.github', 'hooks'), { recursive: true });
    writeFileSync(join(cwd, '.github', 'hooks', 'stroq.json'), '{"foreign": true}\n');
    const streams = spyOnStreams();

    const { fake } = await init(['--agent', 'copilot', '--yes']);

    expect(streams.err.join('')).not.toContain('which Stroq did not write');
    expect(squash(fake.out())).toContain('which Stroq did not write');
  });

  it('puts the notes of an agent under its line on the screen', async () => {
    const { fake } = await init(['--agent', 'copilot', '--yes']);

    expect(squash(fake.out())).toContain(
      'Copilot reads its hooks when the CLI starts: restart "copilot" before this takes effect.',
    );
  });

  it('puts both streams back after an install that worked', async () => {
    has('.claude');
    spyOnStreams();
    const patched = { out: process.stdout.write, err: process.stderr.write };

    await init(['--yes']);

    expect(process.stdout.write).toBe(patched.out);
    expect(process.stderr.write).toBe(patched.err);
  });

  it('puts both streams back after an installer that threw', async () => {
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    writeFileSync(join(cwd, '.claude', 'settings.json'), '{ not json');
    spyOnStreams();
    const patched = { out: process.stdout.write, err: process.stderr.write };

    const { code } = await init(['--yes']);

    expect(code).toBe(1);
    expect(process.stdout.write).toBe(patched.out);
    expect(process.stderr.write).toBe(patched.err);
  });
});

describe('runInteractiveInit, what it reads', () => {
  const SECRET = 'stroq_test_secret_value_12345';
  /** The words after "reads" and before "writes": the line as a person reads it. */
  const readsOf = (out: string): string => / reads (.*?) writes /.exec(squash(out))?.[1] ?? '';

  const withCredentials = (): void => {
    mkdirSync(join(home, '.aws'), { recursive: true });
    writeFileSync(
      join(home, '.aws', 'credentials'),
      `[default]\naws_access_key_id = AKIAIOSFODNN7EXAMPLE\naws_secret_access_key = ${SECRET}\n`,
    );
    writeFileSync(join(cwd, '.env'), `API_TOKEN=${SECRET}_from_env\n`);
    writeFileSync(join(cwd, '.env.example'), 'API_TOKEN=\n');
  };

  // `reads` is the list `FileSecretIndex.sourcePaths` gives, which is absolute paths; unlike `home`
  // and the config paths, it is not shortened with `tilde` before it is shown.
  it('lists a credential file of the home directory from ~, which is how the docs spell it', async () => {
    withCredentials();

    const { fake } = await init(['--yes']);

    expect(readsOf(fake.out())).toContain('~/.aws/credentials');
    expect(readsOf(fake.out())).not.toContain(home);
  });

  it('lists the .env file of the project, and not the example next to it', async () => {
    withCredentials();

    const { fake } = await init(['--yes']);

    expect(readsOf(fake.out())).toContain('.env');
    expect(readsOf(fake.out())).not.toContain('.env.example');
  });

  it('shows no value that is in those files, anywhere on the screen', async () => {
    withCredentials();

    const { fake } = await init([], { answers: ['y'] });

    expect(fake.out()).not.toContain(SECRET);
    expect(fake.prompts.join('')).not.toContain(SECRET);
    expect(fake.out()).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('says it reads credential files in general when none is there yet', async () => {
    const { fake } = await init(['--yes']);

    expect(readsOf(fake.out())).toContain(
      'credential files and project .env files, if there are any',
    );
  });
});
