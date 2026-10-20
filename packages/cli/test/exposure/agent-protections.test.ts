import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { isFailing, type TaggedHit } from '../../src/exposure/agent-change.js';
import { agentChanges } from '../../src/exposure/agent-git.js';
import { commitFiles, git, scratchRepo } from '../helpers/scratch-repo.js';

/**
 * Settings that keep the agent from things: Claude Code's `sandbox`, its `permissions.ask` list and
 * `disableAllHooks`, Codex's `sandbox_workspace_write` and `shell_environment_policy`, Gemini's
 * `tools.exclude`, `excludeTools` and `tools.sandbox`, and the `permissionMode` of an agent's front
 * matter. Which change loosens one is not worked out: any change to them, added, edited or taken
 * away, fails.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

const json = (value: object): string => JSON.stringify(value, null, 2);
const failing = (hits: readonly TaggedHit[]): string[] =>
  hits.filter((h) => isFailing(h, 'new')).map((h) => `${h.status} ${h.kind} ${h.file} ${h.name}`);

const changed = (path: string, before: string, after: string): string[] => {
  const dir = scratchRepo(dirs);
  const base = commitFiles(dir, { [path]: before, 'README.md': 'x\n' });
  commitFiles(dir, { [path]: after });
  return failing(agentChanges(dir, base).hits);
};

describe('a change to what keeps the agent from things', () => {
  it.each([
    [
      'turns the sandbox off and lets a command and a domain through',
      {},
      {
        sandbox: { enabled: false, excludedCommands: ['curl'], network: { allowedDomains: ['x'] } },
      },
      'sandbox',
    ],
    [
      'takes a rule off the ask list',
      { permissions: { ask: ['Bash(git push:*)'] } },
      {},
      'permissions.ask',
    ],
    ['takes disableAllHooks away', { disableAllHooks: true }, {}, 'disableAllHooks'],
  ])('fails one that %s in Claude Code settings', (_, before, after, name) => {
    expect(
      changed('.claude/settings.json', json(before), json(after)).some((h) =>
        h.endsWith(` ${name}`),
      ),
    ).toBe(true);
  });

  it('fails a change to the sandbox or the shell policy of Codex', () => {
    const found = changed(
      '.codex/config.toml',
      'x = 1\n',
      '[sandbox_workspace_write]\nnetwork_access = true\n[shell_environment_policy]\nignore_default_excludes = true\n',
    );
    expect(found).toContain('new agent-broad-allow .codex/config.toml sandbox_workspace_write');
    expect(found).toContain('new agent-broad-allow .codex/config.toml shell_environment_policy');
  });

  it('fails a Gemini exclude list or sandbox a change empties or takes away', () => {
    expect(
      changed(
        '.gemini/settings.json',
        json({ tools: { exclude: ['run_shell_command'], sandbox: 'docker' }, excludeTools: ['x'] }),
        json({ tools: { exclude: [] } }),
      ).sort(),
    ).toEqual([
      'changed agent-broad-allow .gemini/settings.json tools.exclude',
      'changed agent-permission-bypass .gemini/settings.json excludeTools',
      'changed agent-permission-bypass .gemini/settings.json tools.sandbox',
    ]);
  });

  it("fails a permissionMode a change gives an agent's front matter", () => {
    const before = '---\nname: a\ndescription: d\n---\nhi\n';
    expect(
      changed(
        '.claude/agents/a.md',
        before,
        '---\nname: a\ndescription: d\npermissionMode: bypassPermissions\n---\nhi\n',
      ),
    ).toContain('new agent-permission-bypass .claude/agents/a.md permissionMode');
    expect(
      changed(
        '.claude/agents/a.md',
        before,
        '---\nname: a\ndescription: d\npermissionMode: plan\n---\nhi\n',
      ),
    ).toContain('new agent-broad-allow .claude/agents/a.md permissionMode');
  });

  it('fails one a change takes away with the whole file', () => {
    const dir = scratchRepo(dirs);
    const base = commitFiles(dir, {
      '.codex/config.toml': '[sandbox_workspace_write]\nnetwork_access = false\n',
      'README.md': 'x\n',
    });
    git(dir, 'rm', '-q', '.codex/config.toml');
    git(dir, 'commit', '-q', '-m', 'c');
    expect(failing(agentChanges(dir, base).hits)).toContain(
      'changed agent-permission-bypass .codex/config.toml sandbox_workspace_write',
    );
  });
});
