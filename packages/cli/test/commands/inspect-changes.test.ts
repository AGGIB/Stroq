import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runInspect } from '../../src/commands/inspect.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: join(cwd, '.none'),
    },
  });

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'stroq-inspect-changes-'));
  dirs.push(dir);
  git(dir, 'init', '-q', '-b', 'main', '.');
  return dir;
}

function write(dir: string, files: Record<string, string>): void {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
}

function commit(dir: string, files: Record<string, string>): string {
  write(dir, files);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'c');
  return git(dir, 'rev-parse', 'HEAD').trim();
}

interface Run {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

function inspect(...argv: string[]): Run {
  const out: string[] = [];
  const err: string[] = [];
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string) => out.push(String(chunk)) > 0) as typeof stdout;
  process.stderr.write = ((chunk: string) => err.push(String(chunk)) > 0) as typeof stderr;
  try {
    return { code: runInspect(argv), out: out.join(''), err: err.join('') };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
}

const KEYV_SETTINGS = JSON.stringify({
  hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node .vscode/setup.mjs' }] }] },
});
const KEYV_TASKS =
  '// warm up\n{"tasks":[{"label":"warm","command":"node .claude/setup.mjs","runOptions":{"runOn":"folderOpen"}}]}\n';

describe('stroq inspect on a checkout, without a base', () => {
  // Before this mode, a repository whose SessionStart hook runs a script got "Nothing here runs
  // before you approve it ... Open it. Stroq enforces the rest from inside the session." Stroq's
  // hooks never see what another hook runs, so that last sentence was not true for it.
  it('no longer tells you to open a keyv-style repository, and fails on it', () => {
    const dir = repo();
    write(dir, { '.claude/settings.json': KEYV_SETTINGS, '.vscode/tasks.json': KEYV_TASKS });
    const run = inspect(dir);
    expect(run.code).toBe(1);
    expect(run.out).toContain(
      '.claude/settings.json:1  SessionStart hook runs: node .vscode/setup.mjs',
    );
    expect(run.out).toContain('task warm runs when the folder opens: node .claude/setup.mjs');
    expect(run.out).not.toContain('Open it.');
  });

  it('lists an ordinary MCP server without failing', () => {
    const dir = repo();
    write(dir, {
      '.mcp.json': JSON.stringify({ mcpServers: { gh: { command: 'npx', args: ['gh-mcp'] } } }),
    });
    const run = inspect(dir);
    expect(run.code).toBe(0);
    expect(run.out).toContain('MCP server gh starts: npx gh-mcp');
  });

  // A zip download or an unpacked tarball has no .git, and it is exactly the folder you check
  // before you open it with an agent. Its agent files run all the same.
  it('reads the agent files of a folder that is not a git repository', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stroq-inspect-zip-'));
    dirs.push(dir);
    write(dir, {
      '.claude/settings.json': KEYV_SETTINGS,
      '.devcontainer/devcontainer.json': '{"initializeCommand":"id"}',
    });
    const run = inspect(dir);
    expect(run.code).toBe(1);
    expect(run.out).toContain('SessionStart hook runs: node .vscode/setup.mjs');
    expect(run.out).toContain('initializeCommand runs on this machine before the container starts');
    expect(run.out).toContain('not a git repository');
    expect(run.out).not.toContain('nothing for stroq inspect to read');
    const json = JSON.parse(inspect(dir, '--json').out) as { isRepo: boolean; failing: number };
    expect(json).toMatchObject({ isRepo: false, failing: 2 });
  });

  it('fails on nothing with --fail-on none', () => {
    const dir = repo();
    write(dir, { '.claude/settings.json': KEYV_SETTINGS });
    expect(inspect(dir, '--fail-on', 'none').code).toBe(0);
  });

  it('keeps --json and --sarif as the json and sarif formats', () => {
    const dir = repo();
    write(dir, { '.claude/settings.json': KEYV_SETTINGS });
    const json = JSON.parse(inspect(dir, '--json').out) as { agent: Array<{ status: string }> };
    expect(json.agent.map((h) => h.status)).toEqual(['present']);
    expect(inspect(dir, '--format', 'json').out).toBe(inspect(dir, '--json').out);
    expect(inspect(dir, '--format', 'sarif').out).toBe(inspect(dir, '--sarif').out);
  });
});

describe('stroq inspect --changed-from', () => {
  function keyvChange(): { dir: string; base: string } {
    const dir = repo();
    const base = commit(dir, {
      '.claude/settings.json': JSON.stringify({
        hooks: { PreToolUse: [{ hooks: [{ command: 'npx stroq hook claude-code' }] }] },
      }),
    });
    commit(dir, {
      '.claude/settings.json': JSON.stringify({
        hooks: {
          PreToolUse: [{ hooks: [{ command: 'npx stroq hook claude-code' }] }],
          SessionStart: [{ hooks: [{ command: 'node .vscode/setup.mjs' }] }],
        },
      }),
      '.vscode/tasks.json': KEYV_TASKS,
    });
    return { dir, base };
  }

  it('fails on what the change adds, and shows what was there apart', () => {
    const { dir, base } = keyvChange();
    const run = inspect(dir, '--changed-from', base);
    expect(run.code).toBe(1);
    expect(run.out).toContain('new: SessionStart hook runs: node .vscode/setup.mjs');
    expect(run.out).toContain('new: task warm runs when the folder opens');
    expect(run.out).toMatch(
      /ALREADY THERE BEFORE THIS CHANGE \(1, not failing\)\n.*PreToolUse hook/,
    );
  });

  it('passes a change that only touches other files, and fails it with --fail-on any', () => {
    const dir = repo();
    commit(dir, { '.claude/settings.json': KEYV_SETTINGS });
    const base = git(dir, 'rev-parse', 'HEAD').trim();
    commit(dir, { 'README.md': 'docs\n' });
    expect(inspect(dir, '--changed-from', base).code).toBe(0);
    expect(inspect(dir, '--changed-from', base, '--fail-on', 'any').code).toBe(1);
  });

  // actions/checkout writes includeIf entries into .git/config. A change cannot alter .git, so
  // nothing there is the change's doing and none of it may fail the check.
  it('reads nothing under .git', () => {
    const dir = repo();
    const base = commit(dir, { 'README.md': 'x\n' });
    commit(dir, { 'docs.md': 'y\n' });
    git(dir, 'config', 'includeIf.gitdir:/home/runner/work/.path', '/home/runner/creds');
    git(dir, 'config', 'core.sshCommand', 'ssh -i key');
    expect(inspect(dir, '--changed-from', base).code).toBe(0);
    expect(inspect(dir).code).toBe(1);
  });

  it('writes JSON with the status and whether each one fails', () => {
    const { dir, base } = keyvChange();
    const record = JSON.parse(inspect(dir, '--changed-from', base, '--format', 'json').out) as {
      changedFrom: string;
      base: string;
      failOn: string;
      failing: number;
      agent: Array<{ status: string; failing: boolean; kind: string }>;
    };
    expect(record).toMatchObject({ changedFrom: base, base, failOn: 'new', failing: 2 });
    expect(record.agent.map((h) => `${h.status} ${h.kind} ${h.failing}`)).toEqual([
      'present agent-hook false',
      'new agent-hook true',
      'new editor-autorun-task true',
    ]);
  });

  it('writes a job summary to stdout and the annotations to stderr', () => {
    const { dir, base } = keyvChange();
    const run = inspect(dir, '--changed-from', base, '--format', 'github');
    expect(run.code).toBe(1);
    expect(run.out.startsWith('### stroq inspect\n')).toBe(true);
    expect(run.out).not.toContain('::error');
    expect(run.err.split('\n').filter((l) => l.startsWith('::error '))).toHaveLength(2);
  });

  it('writes SARIF that says which results the change brought', () => {
    const { dir, base } = keyvChange();
    const log = JSON.parse(inspect(dir, '--changed-from', base, '--format', 'sarif').out) as {
      runs: Array<{ results: Array<{ properties: { change: string } }> }>;
    };
    expect(log.runs[0]?.results.map((r) => r.properties.change)).toEqual(['present', 'new', 'new']);
  });

  it('exits 3 when git cannot find the base or the folder is not a repository', () => {
    const dir = repo();
    commit(dir, { 'README.md': 'x\n' });
    const missing = inspect(dir, '--changed-from', 'no-such-branch');
    expect(missing.code).toBe(3);
    expect(missing.err).toContain('cannot find no-such-branch');
    const plain = mkdtempSync(join(tmpdir(), 'stroq-inspect-plain-'));
    dirs.push(plain);
    expect(inspect(plain, '--changed-from', 'HEAD').code).toBe(3);
  });
});

describe('stroq inspect usage errors', () => {
  it.each([
    [['--format', 'yaml']],
    [['--fail-on', 'some']],
    [['--changed-from', '-x']],
    [['--changed-from', '']],
    [['--json', '--format', 'github']],
    [['--json', '--sarif']],
    [['--no-such-flag']],
    [['a', 'b']],
    // Without a base every finding is already there, so --fail-on new could never fail.
    [['--fail-on', 'new']],
  ])('exits 2 for %j', (argv) => {
    expect(inspect(...argv).code).toBe(2);
  });

  it('says --fail-on new needs --changed-from', () => {
    expect(inspect('--fail-on', 'new').err).toContain('--fail-on new needs --changed-from');
  });

  it('exits 2 for a folder that does not exist', () => {
    const run = inspect(join(tmpdir(), 'stroq-inspect-does-not-exist'));
    expect(run.code).toBe(2);
    expect(run.err).toContain('no such directory');
  });
});

// The files this repository ships on purpose (its skill, its AGENTS.md) must not fail the check
// it runs on itself. Read from git's HEAD, so files that are not committed do not count.
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
describe.skipIf(!existsSync(join(ROOT, '.git')))('this repository', () => {
  it('passes its own check with --fail-on any', () => {
    const run = inspect(ROOT, '--changed-from', 'HEAD', '--fail-on', 'any', '--format', 'json');
    const record = JSON.parse(run.out) as { agent: Array<{ severity: string; file: string }> };
    expect(record.agent.filter((h) => h.severity === 'error')).toEqual([]);
    expect(run.code).toBe(0);
  });
});
