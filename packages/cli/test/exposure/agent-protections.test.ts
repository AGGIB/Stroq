import { rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isFailing, type TaggedHit } from '../../src/exposure/agent-change.js';
import { agentChanges } from '../../src/exposure/agent-git.js';
import { SETTING_CHANGE } from '../../src/exposure/protective-keys.js';
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

  // A model's name cannot send anything elsewhere: the top-level `model` with a plain name is left
  // out. A provider, a nested `model`, a table or an address in it still fail.
  it('passes a top-level model name changed, and nothing else named for a model', () => {
    expect(changed('.claude/settings.json', json({ model: 'a' }), json({ model: 'b' }))).toEqual(
      [],
    );
    expect(changed('.codex/config.toml', 'model = "a"\n', 'model = "b"\n')).toEqual([]);
    const failing: readonly (readonly [path: string, before: string, after: string])[] = [
      ['.codex/config.toml', 'model = "a"\n', 'model = "https://e.invalid/m"\n'],
      ['.codex/config.toml', 'model_provider = "a"\n', 'model_provider = "b"\n'],
      ['.gemini/settings.json', json({ model: { name: 'a' } }), json({ model: { name: 'b' } })],
      ['.claude/settings.json', json({ x: { model: 'a' } }), json({ x: { model: 'b' } })],
      ['.claude/settings.json', json({ Model: 'a' }), json({ Model: 'b' })],
    ];
    for (const [path, before, after] of failing)
      expect(changed(path, before, after).length, `${path} ${after}`).toBeGreaterThan(0);
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

  // The net walks a bounded number of values: a head past it is not read whole, whatever its
  // readers made of it, so what it took away is not known.
  it('fails a head too big for the net to walk', () => {
    const pad = Array.from({ length: 20_001 }, () => 0);
    const found = changed(
      '.claude/settings.json',
      json({ permissions: { ask: ['Bash(git push:*)'] }, futureSandbox: 1 }),
      json({ pad }),
    );
    expect(found).toContain('changed unreadable-config .claude/settings.json protections');
    expect(found).toContain(
      'changed agent-permission-bypass .claude/settings.json permissions.ask',
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

/**
 * A list whose growth only adds protection (`permissions.deny`, `permissions.ask`, Gemini's
 * `tools.exclude` and `excludeTools`, a server's `excludeTools`) may grow without the net failing:
 * every base element still there, all of them plain strings, nothing else under the key changed.
 * A removal, a dropped element, an element that is not a string, or any other change still fails.
 */
describe('a protective list a change only adds to', () => {
  const net = (path: string, before: object, after: object): string[] => {
    const dir = scratchRepo(dirs);
    const base = commitFiles(dir, { [path]: json(before), 'README.md': 'x\n' });
    commitFiles(dir, { [path]: json(after) });
    const words: ReadonlySet<string> = new Set(Object.values(SETTING_CHANGE));
    return agentChanges(dir, base)
      .hits.filter((h) => isFailing(h, 'new') && words.has(h.value))
      .map((h) => h.name);
  };
  const CLAUDE = '.claude/settings.json';

  it('passes a deny rule added, to a list or as a new one', () => {
    const allow = ['Bash(ls:*)'];
    expect(
      changed(
        CLAUDE,
        json({ permissions: { deny: ['Read(.env)'], allow } }),
        json({ permissions: { deny: ['Read(.env)', 'Bash(curl:*)'], allow } }),
      ),
    ).toEqual([]);
    expect(changed(CLAUDE, json({}), json({ permissions: { deny: ['Bash(curl:*)'] } }))).toEqual(
      [],
    );
  });

  it.each([
    ['a deny rule removed', { deny: ['a', 'b'] }, { deny: ['a'] }],
    ['a deny rule swapped', { deny: ['a'] }, { deny: ['b'] }],
    ['an element that is not a string', { deny: ['a'] }, { deny: ['a', { x: 1 }] }],
    ['another key under permissions', { deny: ['a'] }, { deny: ['a', 'b'], defaultMode: 'plan' }],
    ['the list made something else', { deny: ['a'] }, { deny: 'a' }],
  ])('fails %s', (_, before, after) => {
    expect(net(CLAUDE, { permissions: before }, { permissions: after })).toContain('permissions');
  });

  it('lets the other protective lists grow without the net failing', () => {
    const G = '.gemini/settings.json';
    expect(
      net(CLAUDE, { permissions: { ask: ['a'] } }, { permissions: { ask: ['a', 'b'] } }),
    ).toEqual([]);
    expect(net(G, { tools: { exclude: ['a'] } }, { tools: { exclude: ['b', 'a'] } })).toEqual([]);
    expect(net(G, { excludeTools: ['a'] }, { excludeTools: ['a', 'b'] })).toEqual([]);
    const server = (tools: string[]) => ({
      mcpServers: { s: { command: 'x', excludeTools: tools } },
    });
    expect(net(G, server(['a']), server(['a', 'b']))).toEqual([]);
    expect(net(G, server(['a', 'b']), server(['a']))).toEqual(['mcpServers.s.excludeTools']);
  });
});

/**
 * The readers of these lists fail no change that only adds to one either: every element the base
 * had still there, all plain strings. The whole check then passes; a removal or a swap fails.
 */
describe('a protective list its reader sees only grow', () => {
  const CLAUDE = '.claude/settings.json';
  const G = '.gemini/settings.json';

  it.each([
    [
      CLAUDE,
      { permissions: { ask: ['Bash(git push:*)'] } },
      { permissions: { ask: ['Bash(git push:*)', 'Bash(rm:*)'] } },
    ],
    [CLAUDE, {}, { permissions: { ask: ['Bash(rm:*)'] } }],
    [
      CLAUDE,
      { permissions: { deny: ['Read(.env)'] } },
      { permissions: { deny: ['Read(.env)', 'Bash(curl:*)'] } },
    ],
    [
      G,
      { tools: { exclude: ['run_shell_command'] } },
      { tools: { exclude: ['run_shell_command', 'web_fetch'] } },
    ],
    [G, { excludeTools: ['a'] }, { excludeTools: ['b', 'a'] }],
  ])('passes the whole check: %s from %j to %j', (path, before, after) => {
    expect(changed(path, json(before), json(after))).toEqual([]);
  });

  it.each([
    [CLAUDE, { permissions: { ask: ['a', 'b'] } }, { permissions: { ask: ['a'] } }],
    [CLAUDE, { permissions: { ask: ['a'] } }, { permissions: { ask: ['b'] } }],
    [CLAUDE, { permissions: { ask: ['a'] } }, { permissions: { ask: ['a', 1] } }],
    [CLAUDE, { permissions: { deny: ['a', 'b'] } }, { permissions: { deny: ['a'] } }],
    [G, { tools: { exclude: ['a', 'b'] } }, { tools: { exclude: ['a'] } }],
    [G, { excludeTools: ['a'] }, { excludeTools: 'a' }],
  ])('fails %s from %j to %j', (path, before, after) => {
    expect(changed(path, json(before), json(after)).length).toBeGreaterThan(0);
  });
});
