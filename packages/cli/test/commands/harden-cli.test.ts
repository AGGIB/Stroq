import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CLAUDE_READ_DENY_RULES } from '../../src/harden/recipes/credential-paths.js';
import { removeTempDirs, tempDir } from '../harden/helpers.js';
import { GOLDEN_SETTINGS, settingsText } from '../helpers/harden-fixtures.js';
import { CLI_ENTRY } from '../helpers/cli-entry.js';
import { treeHash } from '../helpers/harden-world.js';

afterEach(removeTempDirs);

const onWindows = process.platform === 'win32';

/**
 * `stroq harden` as it is run: the built CLI, a home and a project of its own, and standard input that
 * is not a terminal (as it is for a script, CI, or the shell tool of an agent). Nothing here touches the
 * real home or the real Stroq home: both are named in the environment of the child.
 */
function world() {
  const home = tempDir('cli-home');
  const project = tempDir('cli-project');
  const stroqHome = join(home, '.stroq');
  const run = (args: readonly string[], options: { cwd?: string } = {}) => {
    const result = spawnSync(process.execPath, [CLI_ENTRY, 'harden', ...args], {
      cwd: options.cwd ?? project,
      encoding: 'utf8',
      input: '',
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        STROQ_HOME: stroqHome,
        CLAUDE_CONFIG_DIR: '',
        CI: '',
        TERM: 'xterm',
      },
    });
    return { code: result.status, out: result.stdout, err: result.stderr };
  };
  return { home, project, stroqHome, run };
}

describe('stroq harden, as a command', () => {
  it('plans, refuses to apply without --yes, applies, reports and undoes, with the bytes checked', () => {
    const { home, project, stroqHome, run } = world();
    const file = join(project, '.claude', 'settings.local.json');
    const before = [treeHash(home), treeHash(project)];

    const plan = run(['--scope', 'project']);
    expect(plan.code).toBe(0);
    expect(plan.out).toContain('Nothing was written.');
    expect([treeHash(home), treeHash(project)]).toEqual(before);

    const declined = run(['apply', '--scope', 'project']);
    expect(declined.code).toBe(1);
    expect(declined.err).toContain('or --yes where there is none');
    expect(existsSync(file)).toBe(false);
    expect(existsSync(stroqHome)).toBe(false);

    const applied = run(['apply', '--scope', 'project', '--yes']);
    expect(applied.code).toBe(0);
    expect(applied.out).toContain(
      'To take it back: stroq harden undo --agent claude-code --scope project',
    );
    expect(readFileSync(file, 'utf8')).toBe(GOLDEN_SETTINGS);

    const status = run(['status']);
    expect(status.code).toBe(0);
    expect(status.out).toContain(
      `State: everything Stroq added is in place (${CLAUDE_READ_DENY_RULES.length} of ${CLAUDE_READ_DENY_RULES.length}).`,
    );

    const undone = run(['undo', '--scope', 'project']);
    expect(undone.code).toBe(1);
    expect(readFileSync(file, 'utf8')).toBe(GOLDEN_SETTINGS);

    const taken = run(['undo', '--scope', 'project', '--yes']);
    expect(taken.code).toBe(0);
    expect(existsSync(file)).toBe(false);
    expect(run(['status']).out).toContain('Nothing applied');
  });

  it('puts the user scope in the home the environment names, and nowhere else', () => {
    const { home, project, run } = world();

    const applied = run(['apply', '--yes']);

    expect(applied.code).toBe(0);
    expect(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')).toBe(GOLDEN_SETTINGS);
    expect(existsSync(join(project, '.claude'))).toBe(false);
  });

  it('gives back the exact bytes of a file with other settings', () => {
    const { home, run } = world();
    mkdirSync(join(home, '.claude'));
    const file = join(home, '.claude', 'settings.json');
    const original = settingsText({ model: 'opus', permissions: { deny: ['Read(~/.npmrc)'] } });
    writeFileSync(file, original);

    expect(run(['apply', '--yes']).code).toBe(0);
    expect(readFileSync(file, 'utf8')).not.toBe(original);
    expect(run(['undo', '--yes']).code).toBe(0);

    expect(readFileSync(file, 'utf8')).toBe(original);
  });

  it('prints the plan as one JSON object', () => {
    const { run } = world();

    const result = run(['--json']);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({
      command: 'harden',
      action: 'plan',
      recipe: 'claude-read-deny',
      outcome: { status: 'planned' },
    });
  });

  describe('exit codes', () => {
    it.each([
      [['bogus'], 2],
      [['--bogus'], 2],
      [['--scope', 'galaxy'], 2],
      [['--agent', 'emacs'], 2],
      [['--recipe', 'nothing'], 2],
      [['--agent', 'cursor', '--recipe', 'claude-read-deny'], 2],
      [['plan', '--yes'], 2],
      [['status', '--agent', 'cursor'], 2],
      [['undo', '--json'], 2],
      [['apply', '--json'], 2],
      [['forget'], 2],
      [['--agent', 'codex'], 1],
      [['--agent', 'cursor', '--scope', 'user'], 1],
    ] as const)('%j exits %i, and prints no stack', (args, code) => {
      const { run } = world();

      const result = run(args);

      expect(result.code).toBe(code);
      expect(result.err).not.toMatch(/\n\s+at |TypeError|ERR_PARSE_ARGS/);
      expect(result.err).toMatch(/stroq harden/);
    });

    it('exits 0 for a plan, for no change needed, and for nothing to undo', () => {
      const { run } = world();
      expect(run([]).code).toBe(0);
      run(['apply', '--yes']);
      expect(run(['apply', '--yes']).code).toBe(0);
      run(['undo', '--yes']);
      expect(run(['undo', '--yes']).code).toBe(0);
    });

    it('exits 1 for a file with comments, and prints the lines to add by hand', () => {
      const { home, run } = world();
      mkdirSync(join(home, '.claude'));
      writeFileSync(join(home, '.claude', 'settings.json'), '{ // mine\n}\n');

      const result = run([]);

      expect(result.code).toBe(1);
      expect(result.out).toContain('To make the change by hand');
      expect(result.out).toContain('"Read(./.env)"');
    });

    it.skipIf(onWindows)('exits 3 for a path that is a link, until it is acknowledged', () => {
      const { home, run } = world();
      mkdirSync(join(home, '.claude'));
      mkdirSync(join(home, 'dotfiles'));
      writeFileSync(join(home, 'dotfiles', 'claude.json'), '{}\n');
      symlinkSync(join(home, 'dotfiles', 'claude.json'), join(home, '.claude', 'settings.json'));

      expect(run([]).code).toBe(3);
      expect(run(['apply', '--yes']).code).toBe(3);
      expect(run(['apply', '--yes', '--acknowledge-link']).code).toBe(0);
    });
  });

  it.skipIf(onWindows)('never lets the name of a folder drive the terminal', () => {
    const { project, run } = world();
    const hostile = join(project, 'a\u001b]52;c;QUFB\u0007b');
    mkdirSync(hostile);

    const result = run(['--scope', 'project'], { cwd: hostile });

    expect(result.code).toBe(0);
    expect(result.out).toContain('a\\u001b]52;c;QUFB\\u0007b');
    // eslint-disable-next-line no-control-regex
    expect(result.out + result.err).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
  });
});
