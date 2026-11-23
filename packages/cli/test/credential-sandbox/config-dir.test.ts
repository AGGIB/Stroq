import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runInitCommand } from '../../src/commands/init-agent.js';
import { runInit } from '../../src/commands/init.js';
import { runUninstall } from '../../src/commands/uninstall.js';
import { claudeSandboxStatus, sandboxSummary } from '../../src/credential-sandbox/status.js';
import { claudeConfigDirProblem } from '../../src/paths.js';
import { fakeTerminal } from '../helpers/fake-terminal.js';
import { asked, readJson, useSandboxHome } from './fixture.js';

const f = useSandboxHome();
const said = () => f.out.join('') + f.err.join('');
/** Only the project folder made for the test is in the home: nothing was written anywhere. */
const untouched = () => {
  expect(readdirSync(f.home)).toEqual(['project']);
  expect(readdirSync(f.cwd)).toEqual([]);
};

describe('the settings directory named by CLAUDE_CONFIG_DIR', () => {
  it('is accepted when it is absolute or not set', () => {
    expect(claudeConfigDirProblem({})).toBeNull();
    expect(claudeConfigDirProblem({ CLAUDE_CONFIG_DIR: join(f.home, 'work') })).toBeNull();
    expect(claudeConfigDirProblem({ CLAUDE_CONFIG_DIR: 'work' })).toContain('absolute');
    expect(claudeConfigDirProblem({ CLAUDE_CONFIG_DIR: '' })).toContain('empty');
  });

  it.each(['relative-profile', './profile', '../profile', ''])(
    'init refuses %j with a clear message and writes nothing',
    async (value) => {
      vi.stubEnv('CLAUDE_CONFIG_DIR', value);

      expect(await asked({ enable: true })).toBe(1);
      expect(await runInit(['--user', '--no-input'], { platform: 'darwin' })).toBe(1);

      expect(said()).toContain('CLAUDE_CONFIG_DIR');
      expect(said()).toMatch(/absolute path/);
      expect(said()).toMatch(/Nothing was changed/);
      untouched();
    },
  );

  it('refuses before the first-run screen is drawn', async () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', 'relative-profile');
    const screen = fakeTerminal({ interactive: true, answers: ['y', 'y', 'y'] });

    const code = await runInitCommand(['--user'], {
      cwd: f.cwd,
      home: f.home,
      terminal: screen.term,
    });

    expect(code).toBe(1);
    expect(screen.read).not.toHaveBeenCalled();
    expect(said() + screen.out()).toContain('CLAUDE_CONFIG_DIR');
    untouched();
  });

  it('uninstall refuses it too and leaves an install made under the default folder alone', async () => {
    await asked();
    const before = readJson(f.settings);
    vi.stubEnv('CLAUDE_CONFIG_DIR', 'relative-profile');
    f.out.length = 0;

    expect(await runUninstall(['--user'])).toBe(1);

    expect(said()).toMatch(/CLAUDE_CONFIG_DIR[\s\S]*absolute path/);
    expect(readJson(f.settings)).toEqual(before);
    expect(existsSync(join(f.cwd, 'relative-profile'))).toBe(false);
  });

  it('does not stop an install for another agent or in the project', async () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', 'relative-profile');

    expect(await runInit([], { platform: 'darwin' })).toBe(0);

    expect(existsSync(join(f.cwd, '.claude/settings.json'))).toBe(true);
    expect(existsSync(join(f.cwd, 'relative-profile'))).toBe(false);
  });

  it('doctor does not read a relative folder as the user settings', () => {
    const status = claudeSandboxStatus({
      ...f.where,
      env: { CLAUDE_CONFIG_DIR: 'relative-profile' },
    });

    expect(status.state).toBe('unknown');
    expect(sandboxSummary(status)).toContain('CLAUDE_CONFIG_DIR');
  });
});
