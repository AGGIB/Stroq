import { rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isFailing, type TaggedHit } from '../../src/exposure/agent-change.js';
import { agentChanges } from '../../src/exposure/agent-git.js';
import { commitFiles, git, scratchRepo, writeFiles } from '../helpers/scratch-repo.js';

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
      // Each once by its reader, and once more as a key whose name says it keeps the agent out.
      'changed agent-permission-bypass .gemini/settings.json excludeTools',
      'changed agent-permission-bypass .gemini/settings.json excludeTools',
      'changed agent-permission-bypass .gemini/settings.json tools.exclude',
      'changed agent-permission-bypass .gemini/settings.json tools.sandbox',
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

/** Which settings keep the agent from things is said by the reader of each, by its key path. */
describe('a protection taken away', () => {
  it.each([
    ['.codex/config.toml', 'approval_policy = "on-request"\n', 'approval_policy'],
    ['.codex/config.toml', 'sandbox_mode = "read-only"\n', 'sandbox_mode'],
    ['.codex/config.toml', '[profiles.p]\nsandbox_mode = "read-only"\n', 'profiles.p.sandbox_mode'],
    [
      '.codex/config.toml',
      '[profiles."a.b"]\napproval_policy = "on-request"\n',
      'profiles.a.b.approval_policy',
    ],
    [
      '.claude/settings.json',
      json({ permissions: { defaultMode: 'default' } }),
      'permissions.defaultMode',
    ],
    [
      '.gemini/settings.json',
      json({ general: { defaultApprovalMode: 'default' } }),
      'general.defaultApprovalMode',
    ],
    ['.claude/settings.json', json({ permissions: { ask: ['Bash'] } }), 'permissions.ask'],
  ])('fails %s losing what it held (%#)', (path, before, name) => {
    const after = path.endsWith('.toml') ? 'x = 1\n' : '{}';
    expect(changed(path, before, after)).toContain(
      `changed agent-permission-bypass ${path} ${name}`,
    );
  });
});

/**
 * Any key of a Claude Code, Codex or Gemini settings file whose path holds sandbox, permission,
 * approval, policy, exclude, trust, allow, deny or mode, in any letter case, that a change adds,
 * edits or takes away fails, though no reader knows it: an honest change to one fails too.
 */
describe('a protective setting no reader knows', () => {
  it.each([
    ['.claude/settings.json', json({ futureSandboxThing: { on: true } }), json({})],
    ['.claude/settings.json', json({ a: { DenyList: ['x'] } }), json({ a: { DenyList: [] } })],
    ['.gemini/settings.json', json({ security: { folderTrust: { x: 1 } } }), json({})],
    ['.codex/config.toml', '[x]\ntrust_level = "a"\n', '[x]\ntrust_level = "b"\n'],
    ['.qwen/settings.json', json({}), json({ ui: { approvalHint: 1 } })],
  ])('fails a change to one in %s', (path, before, after) => {
    expect(changed(path, before, after).some((h) => h.includes('agent-permission-bypass'))).toBe(
      true,
    );
  });

  it('passes a change to a key that holds none of the words', () => {
    expect(changed('.claude/settings.json', json({ x: 1 }), json({ x: 2 }))).toEqual([]);
  });
});

/** What a protection was in the base must be read, or the change fails. */
describe('a base that is not read', () => {
  it.each([
    ['does not parse', '{ "sandbox": '],
    ['is not text', '{"sandbox":"\u0000"}\u0000'],
  ])('fails a settings file whose base %s', (_, before) => {
    expect(changed('.claude/settings.json', before, '{}')).toContain(
      'changed unreadable-config .claude/settings.json protections',
    );
  });

  it('fails a deleted settings file whose base is too big to read', () => {
    const dir = scratchRepo(dirs);
    const big = json({ sandbox: { enabled: true }, pad: 'x'.repeat(1024 * 1024) });
    const base = commitFiles(dir, { '.gemini/settings.json': big, 'README.md': 'x\n' });
    git(dir, 'rm', '-q', '.gemini/settings.json');
    git(dir, 'commit', '-q', '-m', 'c');
    expect(failing(agentChanges(dir, base).hits)).toContain(
      'changed unreadable-config .gemini/settings.json protections',
    );
  });

  it.skipIf(process.platform === 'win32')('fails a deleted settings link', () => {
    const dir = scratchRepo(dirs);
    writeFiles(dir, { 'cfg.toml': 'sandbox_mode = "read-only"\n' });
    writeFiles(dir, { '.codex/keep': 'x\n' });
    symlinkSync('../cfg.toml', join(dir, '.codex/config.toml'));
    const base = commitFiles(dir);
    git(dir, 'rm', '-q', '.codex/config.toml');
    git(dir, 'commit', '-q', '-m', 'c');
    expect(failing(agentChanges(dir, base).hits)).toContain(
      'changed unreadable-config .codex/config.toml protections',
    );
  });

  it('fails past the most deleted settings files one check reads', () => {
    const dir = scratchRepo(dirs);
    const files: Record<string, string> = { 'README.md': 'x\n' };
    for (let i = 0; i < 70; i += 1)
      files[`p${String(i).padStart(2, '0')}/.codex/config.toml`] = 'x = 1\n';
    const base = commitFiles(dir, files);
    git(dir, 'rm', '-q', '-r', ...Object.keys(files).filter((f) => f !== 'README.md'));
    git(dir, 'commit', '-q', '-m', 'c');
    expect(failing(agentChanges(dir, base).hits)).toContain(
      'changed unreadable-config p64/.codex/config.toml protections',
    );
  });
});
