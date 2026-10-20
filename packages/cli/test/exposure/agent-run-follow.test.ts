import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { isFailing, type TaggedHit } from '../../src/exposure/agent-change.js';
import { agentChanges } from '../../src/exposure/agent-git.js';
import { commitFiles, git, hookSettings, scratchRepo } from '../helpers/scratch-repo.js';

/**
 * A hook already there runs more of the repository than the path it names: the tests a test
 * runner finds, the file an interpreter finds for a name with no extension, what that file
 * imports or sources in turn, the plugins a tool's config names. A change to any of those runs
 * in the next session, so it fails like a change to the script itself.
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
): readonly TaggedHit[] {
  const dir = scratchRepo(dirs);
  const base = commitFiles(dir, before);
  commitFiles(dir, after);
  return agentChanges(dir, base).hits;
}

const hookRuns = (
  command: string,
  files: Readonly<Record<string, string>>,
  edits: Readonly<Record<string, string>>,
): string[] =>
  failing(
    change({ '.claude/settings.json': hookSettings({ PostToolUse: command }), ...files }, edits),
  );

/** Whether the change fails on `file` as a file the hook runs. */
const failsOn = (fails: readonly string[], file: string): boolean =>
  fails.some((f) => f.endsWith(` agent-run-file-changed ${file}`));

describe('a test runner a hook starts runs the tests it finds', () => {
  it.each([
    [
      'pytest tests/',
      { 'tests/test_a.py': '1\n' },
      { 'tests/test_a.py': 'import os\n' },
      'tests/test_a.py',
    ],
    [
      'pytest -q',
      { 'tests/test_a.py': '1\n' },
      { 'tests/test_b.py': 'import os\n' },
      'tests/test_b.py',
    ],
    [
      'python3 -m pytest tests',
      { 'tests/test_a.py': '1\n' },
      { 'tests/test_a.py': '2\n' },
      'tests/test_a.py',
    ],
    ['jest', { 'a.test.js': '1\n' }, { 'a.test.js': '2\n' }, 'a.test.js'],
    ['vitest run', { 'a.test.js': '1\n' }, { 'a.test.js': '2\n' }, 'a.test.js'],
    ['mocha test/', { 'test/a.js': '1\n' }, { 'test/a.js': '2\n' }, 'test/a.js'],
    [
      'npm test',
      { 'package.json': '{"scripts":{"test":"jest"}}', 'a.test.js': '1\n' },
      { 'a.test.js': '2\n' },
      'a.test.js',
    ],
    ['node --test', { 'a.test.js': '1\n' }, { 'a.test.js': '2\n' }, 'a.test.js'],
    ['bun test', { 'a.test.ts': '1\n' }, { 'a.test.ts': '2\n' }, 'a.test.ts'],
    ['deno test', { 'a_test.ts': '1\n' }, { 'a_test.ts': '2\n' }, 'a_test.ts'],
    ['go test ./...', { 'a_test.go': '1\n' }, { 'a_test.go': '2\n' }, 'a_test.go'],
    ['cargo test', { 'src/lib.rs': '1\n' }, { 'src/lib.rs': '2\n' }, 'src/lib.rs'],
  ])('`%s`', (command, files, edits, file) => {
    expect(failsOn(hookRuns(command, files, edits), file)).toBe(true);
  });
});

describe('the file an interpreter finds for a name with no extension', () => {
  it.each([
    [
      'node .claude/hooks/guard',
      { '.claude/hooks/guard.js': '1\n' },
      { '.claude/hooks/guard.js': '2\n' },
      '.claude/hooks/guard.js',
    ],
    [
      'node .claude/hooks/guard',
      { '.claude/hooks/guard/index.js': '1\n' },
      { '.claude/hooks/guard/index.js': '2\n' },
      '.claude/hooks/guard/index.js',
    ],
    [
      'node .claude/hooks/guard',
      { '.claude/hooks/guard/index.js': '1\n' },
      { '.claude/hooks/guard.js': '2\n' },
      '.claude/hooks/guard.js',
    ],
    [
      'node scripts/run',
      { 'scripts/run.js': '1\n' },
      { 'scripts/run.js': '2\n' },
      'scripts/run.js',
    ],
    [
      'npx tsx scripts/run',
      { 'scripts/run.ts': '1\n' },
      { 'scripts/run.ts': '2\n' },
      'scripts/run.ts',
    ],
    ['bun scripts/run', { 'scripts/run.ts': '1\n' }, { 'scripts/run.ts': '2\n' }, 'scripts/run.ts'],
    ['node .', { 'index.js': '1\n' }, { 'index.js': '2\n' }, 'index.js'],
    [
      'node scripts',
      { 'scripts/index.js': '1\n' },
      { 'scripts/index.js': '2\n' },
      'scripts/index.js',
    ],
    [
      'python3 -m hooks.guard',
      { 'hooks/guard.py': '1\n' },
      { 'hooks/__init__.py': '2\n' },
      'hooks/__init__.py',
    ],
  ])('`%s`', (command, files, edits, file) => {
    expect(failsOn(hookRuns(command, files, edits), file)).toBe(true);
  });
});

describe('a path a hook names in another letter case', () => {
  it('fails a change to the file a hook names as Guard.sh, on a disk that opens it as guard.sh', () => {
    const fails = hookRuns(
      'bash .claude/hooks/Guard.sh',
      { '.claude/hooks/guard.sh': 'echo ok\n' },
      { '.claude/hooks/guard.sh': 'id\n' },
    );
    expect(failsOn(fails, '.claude/hooks/guard.sh')).toBe(true);
  });

  // Written straight into git's objects: a disk that folds case cannot hold both folders.
  it('fails a new file in a folder that differs from the one a hook names only in case', () => {
    const dir = scratchRepo(dirs);
    const base = commitFiles(dir, {
      '.claude/settings.json': hookSettings({ PostToolUse: 'bash tools/run.sh' }),
      'tools/run.sh': 'echo ok\n',
    });
    const oid = git(dir, 'hash-object', '-w', 'tools/run.sh').trim();
    git(dir, 'update-index', '--add', '--cacheinfo', `100644,${oid},Tools/run.sh`);
    git(dir, 'commit', '-q', '-m', 'case');
    expect(failsOn(failing(agentChanges(dir, base).hits), 'Tools/run.sh')).toBe(true);
  });
});

describe('what the file a hook runs imports, sources or calls', () => {
  it.each([
    [
      'node .claude/hooks/guard.js',
      {
        '.claude/hooks/guard.js': "require('../../lib/util');\n",
        'lib/util.js': 'module.exports = 1;\n',
      },
      { 'lib/util.js': "require('child_process').execSync('id');\n" },
      'lib/util.js',
    ],
    [
      'node .claude/hooks/guard.mjs',
      {
        '.claude/hooks/guard.mjs': "import { x } from './lib/x.mjs';\n",
        '.claude/hooks/lib/x.mjs': 'export const x = 1;\n',
      },
      { '.claude/hooks/lib/x.mjs': 'export const x = 2;\n' },
      '.claude/hooks/lib/x.mjs',
    ],
    [
      'node .claude/hooks/a.js',
      {
        '.claude/hooks/a.js': "require('./b');\n",
        '.claude/hooks/b.js': "require('./c');\n",
        '.claude/hooks/c.js': '1\n',
      },
      { '.claude/hooks/c.js': '2\n' },
      '.claude/hooks/c.js',
    ],
    [
      'node app.js',
      { 'app.js': "require('lib');\n" },
      { 'node_modules/lib/index.js': '2\n' },
      'node_modules/lib/index.js',
    ],
    [
      'python3 .claude/hooks/guard.py',
      { '.claude/hooks/guard.py': 'import json\nprint(1)\n' },
      { '.claude/hooks/json.py': 'import os\n' },
      '.claude/hooks/json.py',
    ],
    [
      'python3 .claude/hooks/guard.py',
      {
        '.claude/hooks/guard.py': 'from helpers.io import read\n',
        '.claude/hooks/helpers/io.py': '1\n',
      },
      { '.claude/hooks/helpers/io.py': '2\n' },
      '.claude/hooks/helpers/io.py',
    ],
    [
      'bash .claude/hooks/a.sh',
      { '.claude/hooks/a.sh': 'source ./lib.sh\n', '.claude/hooks/lib.sh': '1\n' },
      { '.claude/hooks/lib.sh': '2\n' },
      '.claude/hooks/lib.sh',
    ],
    [
      'bash .claude/hooks/a.sh',
      { '.claude/hooks/a.sh': 'scripts/check.sh\n', 'scripts/check.sh': '1\n' },
      { 'scripts/check.sh': '2\n' },
      'scripts/check.sh',
    ],
    [
      'bash .claude/hooks/a.sh',
      {
        '.claude/hooks/a.sh': '. "$(dirname "$0")/lib/common.sh"\n',
        '.claude/hooks/lib/common.sh': '1\n',
      },
      { '.claude/hooks/lib/common.sh': '2\n' },
      '.claude/hooks/lib/common.sh',
    ],
    [
      'prettier --check .',
      { '.prettierrc.json': '{"plugins":["./p.js"]}', 'p.js': '1\n' },
      { 'p.js': '2\n' },
      'p.js',
    ],
    [
      'prettier --check .',
      { 'x.js': '1\n' },
      { '.prettierrc.json': '{"plugins":["./p.js"]}', 'p.js': '2\n' },
      '.prettierrc.json',
    ],
  ])('`%s`', (command, files, edits, file) => {
    expect(failsOn(hookRuns(command, files, edits), file)).toBe(true);
  });

  it('leaves a change alone that the file a hook runs does not reach', () => {
    expect(
      hookRuns(
        'python3 .claude/hooks/guard.py',
        { '.claude/hooks/guard.py': 'import json\n', 'src/json.py': '1\n', 'src/app.js': '1\n' },
        { 'src/json.py': '2\n', 'src/app.js': '2\n' },
      ),
    ).toEqual([]);
    expect(
      hookRuns(
        'node .claude/hooks/guard.js',
        { '.claude/hooks/guard.js': "const fs = require('fs');\n", 'src/app.js': '1\n' },
        { 'src/app.js': '2\n' },
      ),
    ).toEqual([]);
  });

  it('widens when an import goes deeper than the follow reads', () => {
    const chain: Record<string, string> = {};
    for (let i = 0; i < 12; i += 1) chain[`.claude/hooks/m${i}.js`] = `require('./m${i + 1}');\n`;
    chain['.claude/hooks/m12.js'] = '1\n';
    const fails = hookRuns(
      'node .claude/hooks/m0.js',
      { ...chain, 'src/other.sh': '1\n' },
      {
        'src/other.sh': '2\n',
      },
    );
    expect(failsOn(fails, 'src/other.sh')).toBe(true);
  });
});

describe('a change that hits many entries already there', () => {
  it('keeps the number of findings bounded, and still fails', () => {
    const hooks: Record<string, string> = {};
    for (let i = 0; i < 40; i += 1) hooks[`Ev${i}`] = 'bash ./*';
    const files: Record<string, string> = {};
    for (let i = 0; i < 300; i += 1) files[`src/d${i % 10}/f${i}.sh`] = `echo ${i}\n`;
    const hits = change({ '.claude/settings.json': hookSettings(hooks) }, files);
    const fails = hits.filter((h) => isFailing(h, 'new'));
    expect(fails.length).toBeGreaterThan(0);
    expect(hits.length).toBeLessThan(40 * 25);
    expect(hits.some((h) => /more/.test(h.value))).toBe(true);
  });
});

describe('what a shell script a hook runs only mentions', () => {
  it('does not take a bare word for a file anywhere in the tree', () => {
    expect(
      hookRuns(
        'bash .claude/hooks/a.sh',
        { '.claude/hooks/a.sh': 'jq -r .version package.json\n', 'pkg/package.json': '{}\n' },
        { 'pkg/package.json': '{"name":"x"}\n' },
      ),
    ).toEqual([]);
  });

  it('follows a path behind a prefix it cannot read, by its ends', () => {
    const fails = hookRuns(
      'bash .claude/hooks/a.sh',
      {
        '.claude/hooks/a.sh': 'bash "$ROOT/scripts/check.sh"\n',
        'scripts/check.sh': 'source lib.sh\n',
        'scripts/lib.sh': '1\n',
      },
      { 'scripts/lib.sh': '2\n' },
    );
    expect(failsOn(fails, 'scripts/lib.sh')).toBe(true);
  });
});
