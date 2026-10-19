import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitError, agentChanges } from '../../src/exposure/agent-git.js';
import { isFailing, tagChanges, type TaggedHit } from '../../src/exposure/agent-change.js';
import { hit } from '../../src/exposure/agent-kinds.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'stroq-agent-changes-'));
  dirs.push(dir);
  git(dir, 'init', '-q', '-b', 'main', '.');
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: join(cwd, '.none'),
    },
  });
}

function write(dir: string, files: Record<string, string>): void {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
}

function commit(dir: string, files: Record<string, string>, message = 'c'): string {
  write(dir, files);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '--allow-empty', '-m', message);
  return git(dir, 'rev-parse', 'HEAD').trim();
}

const settings = (hooks: Record<string, string>): string =>
  JSON.stringify(
    {
      hooks: Object.fromEntries(
        Object.entries(hooks).map(([event, command]) => [
          event,
          [{ hooks: [{ type: 'command', command }] }],
        ]),
      ),
    },
    null,
    2,
  );

const summary = (hits: readonly TaggedHit[]): string[] =>
  hits.map((h) => `${h.status} ${h.kind} ${h.file} ${h.name}`);

describe('tagChanges', () => {
  const a = hit('agent-hook', '.claude/settings.json', 3, 'Stop', './a.sh');
  const b = hit('agent-hook', '.claude/settings.json', 3, 'Stop', './b.sh');
  const c = hit('agent-hook', '.claude/settings.json', 9, 'SessionStart', './c.sh');

  it('calls a value that was there present, a slot with a new value changed, the rest new', () => {
    expect(tagChanges([a, c], [a]).map((h) => h.status)).toEqual(['present', 'new']);
    expect(tagChanges([b], [a]).map((h) => h.status)).toEqual(['changed']);
  });

  it('calls everything present when there is no base to compare with', () => {
    expect(tagChanges([a, c], null).map((h) => h.status)).toEqual(['present', 'present']);
  });
});

describe('isFailing', () => {
  const error = { ...hit('agent-hook', 'f', 1, 'Stop', 'x'), status: 'new' } as const;
  const old = { ...error, status: 'present' } as const;
  const warning = { ...hit('mcp-server', 'f', 1, 's', 'npx s'), status: 'new' } as const;

  it('fails errors only, new or changed ones with new, all with any, none with none', () => {
    expect(isFailing(error, 'new')).toBe(true);
    expect(isFailing(old, 'new')).toBe(false);
    expect(isFailing(old, 'any')).toBe(true);
    expect(isFailing(error, 'none')).toBe(false);
    expect(isFailing(warning, 'any')).toBe(false);
  });
});

describe('agentChanges against a base commit', () => {
  it('tags a keyv-style change new, and leaves what was already there present', () => {
    const dir = repo();
    const base = commit(dir, {
      '.claude/settings.json': settings({ PreToolUse: 'npx stroq hook claude-code' }),
      'CLAUDE.md': 'Use pnpm.\n',
      'README.md': 'x\n',
    });
    commit(dir, {
      '.claude/settings.json': settings({
        PreToolUse: 'npx stroq hook claude-code',
        SessionStart: 'node .vscode/setup.mjs',
      }),
      '.vscode/tasks.json':
        '// warm\n{"tasks":[{"label":"w","command":"node .claude/setup.mjs","runOptions":{"runOn":"folderOpen"}}]}',
      'CLAUDE.md': 'Use pnpm. Always.\n',
    });
    const changes = agentChanges(dir, base);
    expect(changes.base).toBe(base);
    expect(summary(changes.hits)).toEqual([
      'present agent-hook .claude/settings.json PreToolUse',
      'new agent-hook .claude/settings.json SessionStart',
      'new editor-autorun-task .vscode/tasks.json w',
      'changed instruction-file CLAUDE.md content',
    ]);
  });

  it('calls a hook whose command changed changed, and a reformatted file unchanged', () => {
    const dir = repo();
    const base = commit(dir, {
      '.claude/settings.json': settings({ Stop: './a.sh', Notification: './n.sh' }),
    });
    const reformatted = JSON.stringify(
      JSON.parse(settings({ Notification: './n.sh', Stop: './b.sh' })),
    );
    commit(dir, { '.claude/settings.json': reformatted });
    expect(summary(agentChanges(dir, base).hits)).toEqual([
      'present agent-hook .claude/settings.json Notification',
      'changed agent-hook .claude/settings.json Stop',
    ]);
  });

  it('reads HEAD and never the working tree', () => {
    const dir = repo();
    const base = commit(dir, { 'README.md': 'x\n' });
    commit(dir, { 'docs.md': 'y\n' });
    write(dir, { '.claude/settings.json': settings({ Stop: './not-committed.sh' }) });
    expect(agentChanges(dir, base).hits).toEqual([]);
  });

  it('finds a bare repository a change commits as plain files', () => {
    const dir = repo();
    const base = commit(dir, {
      'old/HEAD': 'ref: refs/heads/main\n',
      'old/objects/info/x': '',
      'old/refs/heads/main': '0\n',
    });
    commit(dir, {
      'vendor/lib/HEAD': 'ref: refs/heads/main\n',
      'vendor/lib/objects/info/x': '',
      'vendor/lib/refs/heads/main': '0\n',
    });
    expect(summary(agentChanges(dir, base).hits)).toEqual([
      'present nested-bare-repo old bare repository',
      'new nested-bare-repo vendor/lib bare repository',
    ]);
  });

  it('stops reading at a total budget and reports what it did not read', () => {
    const dir = repo();
    const base = commit(dir, { 'README.md': 'x\n' });
    // Each file different: one blob shared by many paths is read, and counted, once.
    const files = Object.fromEntries(
      Array.from({ length: 80 }, (_, i) => [
        `.github/hooks/h${String(i).padStart(2, '0')}.json`,
        `{"a":"${i}${'x'.repeat(900_000)}"}`,
      ]),
    );
    commit(dir, files);
    const hits = agentChanges(dir, base).hits;
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.kind === 'unreadable-config' && h.severity === 'error')).toBe(true);
    expect(hits.map((h) => h.file)).toContain('.github/hooks/h79.json');
  });

  it('reports a file too large to read', () => {
    const dir = repo();
    const base = commit(dir, { 'README.md': 'x\n' });
    commit(dir, { '.mcp.json': `{"a":"${'x'.repeat(1_200_000)}"}` });
    expect(summary(agentChanges(dir, base).hits)).toEqual(['new unreadable-config .mcp.json size']);
  });

  it.skipIf(process.platform === 'win32')(
    'follows a link inside the tree, so changing what it points at is a change',
    () => {
      const dir = repo();
      mkdirSync(join(dir, '.claude'));
      write(dir, { 'shared/claude.json': settings({ Stop: './a.sh' }) });
      symlinkSync('../shared/claude.json', join(dir, '.claude', 'settings.json'));
      const base = commit(dir, {});
      commit(dir, { 'shared/claude.json': settings({ Stop: './a.sh', SessionStart: './s.sh' }) });
      expect(summary(agentChanges(dir, base).hits)).toEqual([
        'present agent-hook .claude/settings.json Stop',
        'new agent-hook .claude/settings.json SessionStart',
      ]);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'reports a link that leads out of the repository and does not read it',
    () => {
      const dir = repo();
      const base = commit(dir, { 'README.md': 'x\n' });
      mkdirSync(join(dir, '.claude'));
      symlinkSync('/etc/hosts', join(dir, '.claude', 'settings.json'));
      commit(dir, {});
      expect(summary(agentChanges(dir, base).hits)).toEqual([
        'new config-link-outside .claude/settings.json link',
      ]);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'runs nothing the repository configures, such as an fsmonitor',
    () => {
      const dir = repo();
      const marker = join(dir, '..', `${dir.split('/').pop() ?? 'x'}-fired`);
      dirs.push(marker);
      const script = join(dir, 'monitor.sh');
      writeFileSync(script, `#!/bin/sh\necho fired >> '${marker}'\nexit 1\n`);
      chmodSync(script, 0o755);
      const base = commit(dir, { 'README.md': 'x\n' });
      commit(dir, { '.mcp.json': '{"mcpServers":{}}' });
      git(dir, 'config', 'core.fsmonitor', script);
      agentChanges(dir, base);
      expect(existsSync(marker)).toBe(false);
    },
  );

  it('fails with a git error for a revision that is not there, or a folder that is not a repository', () => {
    const dir = repo();
    commit(dir, { 'README.md': 'x\n' });
    expect(() => agentChanges(dir, 'no-such-branch')).toThrow(GitError);
    const plain = mkdtempSync(join(tmpdir(), 'stroq-agent-plain-'));
    dirs.push(plain);
    expect(() => agentChanges(plain, 'HEAD')).toThrow(GitError);
  });
});
