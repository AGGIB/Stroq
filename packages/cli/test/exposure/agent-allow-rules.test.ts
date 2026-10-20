import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { isFailing, tagChanges, type TaggedHit } from '../../src/exposure/agent-change.js';
import { agentChanges } from '../../src/exposure/agent-git.js';
import { describe as sentenceOf, plainQuote } from '../../src/exposure/agent-report.js';
import { scanFile } from '../../src/exposure/agent-surface.js';
import { SETTING_CHANGE } from '../../src/exposure/protective-keys.js';
import { commitFiles, git, scratchRepo } from '../helpers/scratch-repo.js';

/**
 * An allow or auto-approve rule widens what the agent may do without asking. Which rules are
 * harmless is not worked out: a list of programs that "run nothing" is never finished, and the
 * author of a change writes both the rule and the program. So every rule is reported. One a change
 * adds or edits fails; one already there is listed. A change that takes away a deny rule, or takes
 * a server off `disabledMcpjsonServers`, widens it the other way, and fails too.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

const json = (value: object): string => JSON.stringify(value, null, 2);
/**
 * The failing findings of the readers. Any change under `permissions` also fails as a protective
 * setting changed (see `protectiveKeys`), which these tests about the rules leave out.
 */
const failing = (hits: readonly TaggedHit[]): string[] =>
  hits
    .filter((h) => isFailing(h, 'new') && !PROTECTIVE.has(h.value))
    .map((h) => `${h.status} ${h.kind} ${h.name} ${h.value}`);
const PROTECTIVE: ReadonlySet<string> = new Set(Object.values(SETTING_CHANGE));

const claudeAllows = (rules: readonly unknown[]): string[] =>
  scanFile('.claude/settings.json', JSON.stringify({ permissions: { allow: rules } }))
    .filter((h) => h.kind === 'agent-broad-allow')
    .map((h) => h.value);

const RULES = [
  'Bash',
  'Bash(*)',
  'Bash(bash:*)',
  'Bash(npm test)',
  'Bash(git status:*)',
  'Bash(ls:*)',
  'Bash(cat:*)',
  'Bash(echo done)',
  'Read',
  'Grep',
  'Edit(*)',
  'Read(src/**)',
  'Write(~/.zshrc)',
  'WebFetch(domain:example.com)',
  'mcp__docs__search',
  '*',
];

describe('a Claude Code allow rule', () => {
  it.each(RULES)('reports %j, whatever it lets run', (rule) => {
    expect(claudeAllows([rule])).toEqual([rule]);
  });

  it('reports an entry that is not a string, and a list that is not a list', () => {
    expect(claudeAllows([{ tool: 'Bash' }, 7])).toEqual(['{"tool":"Bash"}', '7']);
    const one = scanFile('.claude/settings.json', json({ permissions: { allow: 'Bash' } }));
    expect(one.map((h) => `${h.kind} ${h.value}`)).toEqual(['agent-broad-allow Bash']);
  });

  it('reports every folder the agent is given, and every mode', () => {
    const hits = scanFile(
      '.claude/settings.json',
      json({
        permissions: {
          additionalDirectories: ['~', '../other', 'packages/app'],
          defaultMode: 'acceptEdits',
        },
      }),
    );
    expect(hits.map((h) => `${h.kind} ${h.name} ${h.value}`)).toEqual([
      'agent-broad-allow permissions.additionalDirectories ~',
      'agent-broad-allow permissions.additionalDirectories ../other',
      'agent-broad-allow permissions.additionalDirectories packages/app',
      'agent-permission-bypass permissions.defaultMode acceptEdits',
    ]);
    for (const mode of ['default', 'plan', 'dontAsk'])
      expect(
        scanFile('.claude/settings.json', json({ permissions: { defaultMode: mode } })).map(
          (h) => `${h.kind} ${h.value}`,
        ),
      ).toEqual([`agent-broad-allow ${mode}`]);
  });

  it('lists a rule already there in plain stroq inspect, and fails none of them', () => {
    const hits = scanFile('.claude/settings.json', json({ permissions: { allow: RULES } }));
    const plain = tagChanges(hits, null);
    expect(plain.map((h) => h.severity)).toEqual(RULES.map(() => 'warning'));
    expect(plain.filter((h) => isFailing(h, 'any'))).toEqual([]);
  });

  it('says what the rule lets the agent do', () => {
    const say = (rule: string): string => {
      const [h] = tagChanges(
        scanFile('.claude/settings.json', json({ permissions: { allow: [rule] } })),
        [],
      );
      return sentenceOf(h as TaggedHit, plainQuote);
    };
    expect(say('Bash(npm test)')).toBe(
      'new: permissions.allow lets the agent run shell commands without asking, and this change widens what the agent may do without asking: Bash(npm test)',
    );
    expect(say('Read(src/**)')).toBe(
      'new: permissions.allow lets the agent read or change files without asking, and this change widens what the agent may do without asking: Read(src/**)',
    );
    expect(say('WebFetch(domain:example.com)')).toBe(
      'new: permissions.allow lets the agent reach the network without asking, and this change widens what the agent may do without asking: WebFetch(domain:example.com)',
    );
    expect(say('mcp__docs__search')).toBe(
      'new: permissions.allow lets the agent use a tool without asking, and this change widens what the agent may do without asking: mcp__docs__search',
    );
    const [present] = tagChanges(
      scanFile('.claude/settings.json', json({ permissions: { defaultMode: 'plan' } })),
      null,
    );
    expect(sentenceOf(present as TaggedHit, plainQuote)).toBe(
      'permissions.defaultMode sets when the agent asks before it acts: plan',
    );
  });
});

describe('a change to the allow rules', () => {
  it('fails a new rule, however narrow', () => {
    const dir = scratchRepo(dirs);
    const base = commitFiles(dir, { 'README.md': 'x\n' });
    commitFiles(dir, {
      '.claude/settings.json': json({
        permissions: { allow: ['Bash(ls:*)'], defaultMode: 'plan', additionalDirectories: ['a'] },
      }),
    });
    expect(failing(agentChanges(dir, base).hits)).toEqual([
      'new agent-broad-allow permissions.allow Bash(ls:*)',
      'new agent-broad-allow permissions.defaultMode plan',
      'new agent-broad-allow permissions.additionalDirectories a',
    ]);
  });

  it('fails a changed rule, and lists the ones it leaves alone', () => {
    const dir = scratchRepo(dirs);
    const base = commitFiles(dir, {
      '.claude/settings.json': json({ permissions: { allow: ['Bash(npm test)', 'Read'] } }),
    });
    commitFiles(dir, {
      '.claude/settings.json': json({ permissions: { allow: ['Bash(npm test:*)', 'Read'] } }),
    });
    const hits = agentChanges(dir, base).hits;
    expect(failing(hits)).toEqual(['changed agent-broad-allow permissions.allow Bash(npm test:*)']);
    expect(hits.filter((h) => h.status === 'present').map((h) => h.value)).toEqual(['Read']);
  });

  it('fails a deny rule or a disabled server that a change takes away', () => {
    const dir = scratchRepo(dirs);
    const base = commitFiles(dir, {
      '.claude/settings.json': json({
        permissions: { deny: ['Bash(curl:*)', 'Read(.env)'] },
        disabledMcpjsonServers: ['shell', 'docs'],
      }),
    });
    commitFiles(dir, {
      '.claude/settings.json': json({
        permissions: { deny: ['Read(.env)'] },
        disabledMcpjsonServers: ['docs'],
      }),
    });
    const hits = agentChanges(dir, base).hits;
    expect(failing(hits)).toEqual([
      'changed agent-permission-bypass permissions.deny Bash(curl:*)',
      'changed agent-permission-bypass disabledMcpjsonServers shell',
    ]);
    const deny = hits.find((h) => h.name === 'permissions.deny');
    expect(sentenceOf(deny as TaggedHit, plainQuote)).toBe(
      'changed: takes away the deny rule Bash(curl:*), so the agent is no longer refused it',
    );
  });

  it('fails a deny rule taken away with the whole file', () => {
    const dir = scratchRepo(dirs);
    const base = commitFiles(dir, {
      'packages/app/.claude/settings.json': json({ permissions: { deny: ['WebFetch'] } }),
      'README.md': 'x\n',
    });
    git(dir, 'rm', '-q', 'packages/app/.claude/settings.json');
    git(dir, 'commit', '-q', '-m', 'c');
    expect(failing(agentChanges(dir, base).hits)).toEqual([
      'changed agent-permission-bypass permissions.deny WebFetch',
    ]);
  });

  /**
   * Claude Code reads its settings as strict JSON, and a list it does not read as a list of strings
   * refuses nothing. So the head is read as strictly as that: a comment, a value that is not such a
   * list, or a rule spelled with a blank more, keeps none of what the base refused.
   */
  it.each([
    [
      'a head with a comment',
      '{\n  // keep\n  "permissions": {"deny": ["Bash(curl:*)"]},\n  "disabledMcpjsonServers": ["shell"]\n}',
    ],
    [
      'a head with a trailing comma',
      '{"permissions": {"deny": ["Bash(curl:*)"]}, "disabledMcpjsonServers": ["shell"],}',
    ],
    [
      'a rule with a blank more',
      json({ permissions: { deny: ['Bash(curl:*) '] }, disabledMcpjsonServers: [' shell'] }),
    ],
    [
      'lists that are not lists',
      json({ permissions: { deny: 'Bash(curl:*)' }, disabledMcpjsonServers: 'shell' }),
    ],
    [
      'lists with an entry that is not a string',
      json({ permissions: { deny: ['Bash(curl:*)', 1] }, disabledMcpjsonServers: ['shell', null] }),
    ],
  ])('fails what the base refused when it is %s', (_, head) => {
    const dir = scratchRepo(dirs);
    const base = commitFiles(dir, {
      '.claude/settings.json': json({
        permissions: { deny: ['Bash(curl:*)'] },
        disabledMcpjsonServers: ['shell'],
      }),
    });
    commitFiles(dir, { '.claude/settings.json': head });
    expect(
      failing(agentChanges(dir, base).hits).filter((h) => h.includes('agent-permission-bypass')),
    ).toEqual([
      'changed agent-permission-bypass permissions.deny Bash(curl:*)',
      'changed agent-permission-bypass disabledMcpjsonServers shell',
    ]);
  });

  // Adding one refuses more, so its own reading passes; the change to `permissions` still fails,
  // as any change to a protective setting does, since which way it goes is not worked out.
  it('passes a change that adds a deny rule or disables a server, but for permissions', () => {
    const dir = scratchRepo(dirs);
    const base = commitFiles(dir, { '.claude/settings.json': json({}) });
    commitFiles(dir, {
      '.claude/settings.json': json({
        permissions: { deny: ['Bash(curl:*)'] },
        disabledMcpjsonServers: ['shell'],
      }),
    });
    const hits = agentChanges(dir, base).hits;
    expect(failing(hits)).toEqual([]);
    expect(hits.filter((h) => isFailing(h, 'new')).map((h) => `${h.name} ${h.value}`)).toEqual([
      `permissions ${SETTING_CHANGE.added}`,
    ]);
  });
});

describe('a long list of allow rules', () => {
  it('lists the first 200, and fails for the rest', () => {
    const rules = Array.from({ length: 250 }, (_, i) => `Bash(ls ./s${i})`);
    const hits = scanFile('.claude/settings.json', json({ permissions: { allow: rules } }));
    expect(hits.filter((h) => h.kind === 'agent-broad-allow')).toHaveLength(200);
    expect(hits.filter((h) => h.kind === 'unreadable-config').map((h) => h.name)).toEqual([
      'too many allow rules',
    ]);
    const shell = rules.map((r) => r.replace('Bash(', 'run_shell_command('));
    const gemini = scanFile('.gemini/settings.json', json({ tools: { allowed: shell } }));
    expect(gemini.filter((h) => h.kind === 'unreadable-config').map((h) => h.name)).toEqual([
      'too many allow rules',
    ]);
  });
});

describe('the allow rules and modes of the other hosts', () => {
  it('reports every Gemini or Qwen rule, and every approval mode', () => {
    const hits = scanFile(
      '.gemini/settings.json',
      json({
        general: { defaultApprovalMode: 'auto_edit' },
        tools: { allowed: ['run_shell_command(git status)', 'read_file'] },
        allowedTools: ['run_shell_command(ls)'],
      }),
    );
    expect(hits.map((h) => `${h.kind} ${h.name} ${h.value}`)).toEqual([
      'agent-broad-allow general.defaultApprovalMode auto_edit',
      'agent-broad-allow tools.allowed run_shell_command(git status)',
      'agent-broad-allow tools.allowed read_file',
      'agent-broad-allow allowedTools run_shell_command(ls)',
    ]);
    const yolo = scanFile(
      '.gemini/settings.json',
      json({ general: { defaultApprovalMode: 'yolo' } }),
    );
    expect(yolo.map((h) => h.kind)).toEqual(['agent-permission-bypass']);
  });

  it("reports every tool a skill's or a command's front matter allows", () => {
    const hits = scanFile(
      '.claude/skills/x/SKILL.md',
      '---\nname: x\nallowed-tools: Read, Grep, Bash(git status:*)\n---\nDo it.\n',
    );
    expect(hits.filter((h) => h.kind === 'agent-broad-allow').map((h) => h.value)).toEqual([
      'Read',
      'Grep',
      'Bash(git status:*)',
    ]);
  });

  it('reports every Codex approval policy and sandbox mode', () => {
    const hits = scanFile(
      '.codex/config.toml',
      'approval_policy = "on-request"\nsandbox_mode = "workspace-write"\n[profiles.x]\napproval_policy = "never"\n',
    );
    expect(hits.map((h) => `${h.kind} ${h.name} ${h.value}`)).toEqual([
      'agent-broad-allow approval_policy on-request',
      'agent-broad-allow sandbox_mode workspace-write',
      'agent-permission-bypass profiles.x.approval_policy never',
    ]);
  });

  it("reports VS Code's auto-approve settings, approving or not", () => {
    const hits = scanFile(
      '.vscode/settings.json',
      json({
        'chat.tools.autoApprove': true,
        'chat.tools.terminal.autoApprove': { rm: false },
      }),
    );
    expect(hits.map((h) => `${h.kind} ${h.name}`)).toEqual([
      'agent-permission-bypass chat.tools.autoApprove',
      'agent-broad-allow chat.tools.terminal.autoApprove',
    ]);
  });
});
