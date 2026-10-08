import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowDeps } from '../../src/commands/init-flow.js';
import { display, runInteractiveInit } from '../../src/commands/init-interactive.js';
import { fakeTerminal, fakeTimers, type FakeTerminalOptions } from '../helpers/fake-terminal.js';
import { squash } from '../helpers/flow-deps.js';

/**
 * What a review of the wiring of the first-run screen found: a home that is not set made the project's
 * own folders count as the user's agents; an agent whose installer runs a program was installed under a
 * question that said "in this project"; a copy of the CLI was written without being said; and a folder
 * with a line break in its name put a line of its own on the screen.
 */
let home = '';
let cwd = '';

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stroq-interactive-review-home-'));
  cwd = mkdtempSync(join(tmpdir(), 'stroq-interactive-review-cwd-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('STROQ_HOME', mkdtempSync(join(tmpdir(), 'stroq-interactive-review-stroq-')));
  vi.spyOn(process, 'cwd').mockReturnValue(cwd);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function init(args: string[], terminal: FakeTerminalOptions = {}, where = { cwd, home }) {
  const fake = fakeTerminal(terminal);
  const check = vi.fn<FlowDeps['check']>(async () => null);
  const code = await runInteractiveInit(args, fake.term, where, {
    check,
    timers: fakeTimers().timers,
  });
  return { code, fake };
}

describe('display', () => {
  it('shows a path inside the project from the project, with either separator', () => {
    expect(display('/work/app/.claude/settings.json', '/work/app', '/home/ann')).toBe(
      '.claude/settings.json',
    );
    expect(
      display('C:\\work\\app\\.claude\\settings.json', 'C:\\work\\app', 'C:\\Users\\ann'),
    ).toBe('.claude/settings.json');
  });

  it('shows a path in the home from ~ and any other as it is', () => {
    expect(display('/home/ann/.cursor/hooks.json', '/work/app', '/home/ann')).toBe(
      '~/.cursor/hooks.json',
    );
    expect(display('/srv/x/.env', '/work/app', '/home/ann')).toBe('/srv/x/.env');
  });

  it('does not take a sibling folder that starts the same way for the project', () => {
    expect(display('/work/app2/.env', '/work/app', '/home/ann')).toBe('/work/app2/.env');
  });

  it('does not take a path for inside a project that is "" (a cwd cannot be, and a home can)', () => {
    expect(display('/srv/x/.env', '', '')).toBe('/srv/x/.env');
  });
});

describe('runInteractiveInit, a home that is not set', () => {
  it('does not take the folders of the project for the agents of the user', async () => {
    mkdirSync(join(cwd, '.cursor'), { recursive: true });
    mkdirSync(join(cwd, '.codex'), { recursive: true });

    const { fake } = await init([], { answers: ['n'] }, { cwd, home: '' });

    const out = fake.out();
    expect(out).toMatch(/– Cursor\s+not found/);
    expect(out).toMatch(/– Codex CLI\s+not found/);
    expect(fake.prompts[0]).toContain('Guard Claude Code');
  });
});

describe('runInteractiveInit, an agent whose installer runs a program', () => {
  it.skipIf(process.platform === 'win32')(
    'says it runs the two commands, before it asks, where openclaw is on PATH',
    async () => {
      mkdirSync(join(home, '.openclaw'), { recursive: true });
      const bin = mkdtempSync(join(tmpdir(), 'stroq-interactive-review-bin-'));
      writeFileSync(join(bin, 'openclaw'), '#!/bin/sh\nexit 0\n');
      chmodSync(join(bin, 'openclaw'), 0o755);
      vi.stubEnv('PATH', bin);

      const { code, fake } = await init(['--agent', 'openclaw'], { answers: ['n'] });

      expect(code).toBe(1);
      expect(squash(fake.out())).toContain(
        'also OpenClaw: runs `openclaw plugins install --link` and `openclaw plugins enable stroq`, which are for the whole user whatever the scope',
      );
    },
  );

  // A fifth review: the two commands are only printed where openclaw is not on PATH, and the screen
  // said before the question that they were run.
  it('says it prints them, for the person to run, where openclaw is not on PATH', async () => {
    mkdirSync(join(home, '.openclaw'), { recursive: true });
    vi.stubEnv('PATH', mkdtempSync(join(tmpdir(), 'stroq-interactive-review-nobin-')));

    const { code, fake } = await init(['--agent', 'openclaw'], { answers: ['n'] });

    expect(code).toBe(1);
    expect(squash(fake.out())).toContain(
      'also OpenClaw: prints `openclaw plugins install --link` and `openclaw plugins enable stroq` for you to run where `openclaw` is (it is not on PATH here), which are for the whole user whatever the scope',
    );
    expect(squash(fake.out())).not.toContain('also OpenClaw: runs');
  });

  it('says nothing of it for an agent whose installer writes a file', async () => {
    const { fake } = await init(['--agent', 'copilot'], { answers: ['n'] });

    expect(fake.out()).not.toContain('also ');
  });
});

describe("runInteractiveInit, a CLI that came from npm's cache", () => {
  it('says that a copy of it is written, which the hooks run', async () => {
    vi.spyOn(process, 'argv', 'get').mockReturnValue([
      process.execPath,
      '/home/ann/.npm/_npx/0f3a9c/node_modules/.bin/stroq',
    ]);

    const { fake } = await init([], { answers: ['n'] });

    expect(squash(fake.out())).toContain('a copy of this CLI under');
  });

  it('says nothing of it for a CLI that was installed', async () => {
    vi.spyOn(process, 'argv', 'get').mockReturnValue([process.execPath, '/usr/local/bin/stroq']);

    const { fake } = await init([], { answers: ['n'] });

    expect(fake.out()).not.toContain('a copy of this CLI');
  });
});

describe('runInteractiveInit, a project folder with a line break in its name', () => {
  it.skipIf(process.platform === 'win32')(
    'does not let the path of the file that was written put a line of its own on the screen',
    async () => {
      const folder = join(cwd, 'p-x\nDone. Stroq is guarding Claude Code.');
      mkdirSync(folder, { recursive: true });
      vi.spyOn(process, 'cwd').mockReturnValue(folder);

      const { code, fake } = await init(
        ['--agent', 'claude-code', '--yes'],
        {},
        { cwd: folder, home },
      );

      expect(code).toBe(0);
      expect(existsSync(join(folder, '.claude', 'settings.json'))).toBe(true);
      const lines = fake.out().split('\n');
      expect(
        lines.filter((line) => line.trimStart().startsWith('Done. Stroq is guarding Claude Code')),
      ).toHaveLength(1);
      expect(fake.out()).toContain('hooks installed in');
      expect(readFileSync(join(folder, '.claude', 'settings.json'), 'utf8')).toContain('stroq');
    },
  );

  // A fifth review: only the path of the file that was written was made safe, and the warning that
  // Windsurf's hooks do not run names another path in the folder, with the line break in it.
  it.skipIf(process.platform === 'win32')(
    'does not let a path in a note of the installer split it, or hide the warning',
    async () => {
      const folder = join(cwd, 'p-x\n  Done. nothing is wrong here.');
      mkdirSync(join(folder, '.devin'), { recursive: true });
      writeFileSync(
        join(folder, '.devin', 'hooks.json'),
        '{ "hooks": { "pre_run_command": [{ "command": "echo hi" }] } }',
      );
      vi.spyOn(process, 'cwd').mockReturnValue(folder);

      const { code, fake } = await init(
        ['--agent', 'windsurf', '--yes'],
        {},
        { cwd: folder, home },
      );

      expect(code).toBe(0);
      const shown = squash(fake.out());
      // The note is there, whole, with the break written as the two characters it is.
      expect(shown).toContain('defines hooks, and Devin Desktop then ignores');
      expect(shown).toContain('so the hooks above will not run there');
      expect(shown).toContain('p-x\\n Done. nothing is wrong here.');
      // And what it says is what the headline says.
      expect(shown).toContain(
        'Done, but read the warning above. Stroq is not guarding Windsurf yet',
      );
    },
  );
});
