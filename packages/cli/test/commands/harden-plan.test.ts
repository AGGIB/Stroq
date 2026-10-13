import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CLAUDE_READ_DENY_RULES } from '../../src/harden/recipes/credential-paths.js';
import { removeTempDirs } from '../harden/helpers.js';
import { diffLabel } from '../helpers/harden-fixtures.js';
import { hardenWorld, treeHash } from '../helpers/harden-world.js';

afterEach(removeTempDirs);

const settings = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

describe('stroq harden (plan)', () => {
  it('shows the rules and the diff for a home with no settings file, and says nothing was written', async () => {
    const world = hardenWorld();

    const run = await world.run([]);

    const file = world.inHome('.claude', 'settings.json');
    expect(run.code).toBe(0);
    expect(run.err).toBe('');
    expect(run.out).toContain('stroq harden: claude-read-deny (claude-code, user scope)');
    expect(run.out).toContain(`File: ${file}`);
    expect(run.out).toContain('does not exist yet; applying would create it');
    for (const rule of CLAUDE_READ_DENY_RULES) expect(run.out).toContain(`  + ${rule}\n`);
    expect(run.out).toContain(`+++ b/${diffLabel(file)}`);
    expect(run.out).toContain('+      "Read(./.env)",');
    expect(run.out).toContain('Nothing was written.');
    expect(run.out).toContain('stroq harden apply --agent claude-code --scope user');
  });

  it('prints the whole plan, as a golden, for a project with no settings file', async () => {
    const world = hardenWorld();

    const run = await world.run(['plan', '--scope', 'project']);

    const file = world.inProject('.claude', 'settings.local.json');
    expect(run.out).toBe(
      [
        'stroq harden: claude-read-deny (claude-code, project scope)',
        'Ask Claude Code to refuse to read credential files.',
        '',
        `File: ${file}`,
        '  The file does not exist yet; applying would create it.',
        '',
        'Adds these rules to permissions.deny:',
        ...CLAUDE_READ_DENY_RULES.map((rule) => `  + ${rule}`),
        '',
        'The change:',
        '--- /dev/null',
        `+++ b/${diffLabel(file)}`,
        // The six lines around the rules: `{`, `permissions`, `deny`, and the three closers.
        `@@ -0,0 +1,${CLAUDE_READ_DENY_RULES.length + 6} @@`,
        '+{',
        '+  "permissions": {',
        '+    "deny": [',
        ...CLAUDE_READ_DENY_RULES.map(
          (rule, i) =>
            `+      ${JSON.stringify(rule)}${i === CLAUDE_READ_DENY_RULES.length - 1 ? '' : ','}`,
        ),
        '+    ]',
        '+  }',
        '+}',
        '',
        'What this does, and what it does not:',
        '  - Claude Code will then refuse to read these files with its Read tool, and with the simple shell readers it recognises, such as cat.',
        '  - This is a filter inside Claude Code, a best effort and not a guarantee: a program that reads the file itself, such as python -c, is not covered.',
        '  - Only an operating system sandbox covers that; stroq run --sandbox starts an agent inside one.',
        '  - The two project rules name the .env files at the top of the folder Claude Code is started in; Stroq has not checked whether Claude Code also applies them to a .env in a subfolder.',
        '  - The rule for .env.* also covers .env.example, because a deny rule cannot say "all but".',
        '  - Rules the file already has are kept as they are, and undo never removes one of them.',
        '',
        'Nothing was written. To apply it: stroq harden apply --agent claude-code --scope project',
        '',
      ].join('\n'),
    );
  });

  it('writes nothing at all: not the file, not its folder, not the Stroq home', async () => {
    const world = hardenWorld();
    writeFileSync(world.inProject('.env'), 'UNRELATED=1\n');
    const before = [treeHash(world.home), treeHash(world.project), treeHash(world.stroqHome)];

    for (const args of [[], ['plan'], ['--scope', 'project'], ['--agent', 'cursor'], ['--json']]) {
      expect((await world.run(args)).code).toBe(0);
    }

    expect([treeHash(world.home), treeHash(world.project), treeHash(world.stroqHome)]).toEqual(
      before,
    );
    expect(existsSync(world.inHome('.claude'))).toBe(false);
  });

  it('keeps the other settings, and marks a rule the file already has as the owner`s', async () => {
    const world = hardenWorld();
    mkdirSync(world.inHome('.claude'));
    writeFileSync(
      world.inHome('.claude', 'settings.json'),
      settings({ model: 'opus', permissions: { deny: ['Bash(rm:*)', 'Read(~/.npmrc)'] } }),
    );

    const run = await world.run([]);

    expect(run.code).toBe(0);
    expect(run.out).toContain('  = Read(~/.npmrc)   (already there, and left as it is)');
    expect(run.out).toContain('  + Read(~/.netrc)');
    expect(run.out).not.toContain('  + Read(~/.npmrc)');
    expect(run.out).not.toContain('The file does not exist yet');
    // Their last rule gains a comma, and ours follow it; nothing of theirs is taken out.
    expect(run.out).toContain('+      "Read(~/.npmrc)",\n+      "Read(./.env)",');
    expect(run.out).not.toMatch(/^-.*Bash\(rm/m);
  });

  it('says there is nothing to change when every rule is already there', async () => {
    const world = hardenWorld();
    mkdirSync(world.inHome('.claude'));
    writeFileSync(
      world.inHome('.claude', 'settings.json'),
      settings({ permissions: { deny: [...CLAUDE_READ_DENY_RULES] } }),
    );

    const run = await world.run([]);

    expect(run.code).toBe(0);
    expect(run.out).toBe(
      [
        'stroq harden: claude-read-deny (claude-code, user scope)',
        'Ask Claude Code to refuse to read credential files.',
        '',
        `File: ${world.inHome('.claude', 'settings.json')}`,
        '',
        'These rules are already in permissions.deny:',
        ...CLAUDE_READ_DENY_RULES.map((rule) => `  = ${rule}`),
        '',
        'Nothing to change: every rule is already in place.',
        '',
      ].join('\n'),
    );
  });

  it('plans the project`s local settings at project scope', async () => {
    const world = hardenWorld();

    const run = await world.run(['--scope', 'project']);

    expect(run.out).toContain(`File: ${world.inProject('.claude', 'settings.local.json')}`);
    expect(run.out).toContain('(claude-code, project scope)');
  });

  it('plans a block in .cursorignore for Cursor, and says it could not be checked', async () => {
    const world = hardenWorld();
    writeFileSync(world.inProject('.cursorignore'), 'dist/\n');

    const run = await world.run(['--agent', 'cursor']);

    expect(run.code).toBe(0);
    expect(run.out).toContain('stroq harden: cursor-ignore (cursor, project scope)');
    expect(run.out).toContain(`File: ${world.inProject('.cursorignore')}`);
    expect(run.out).toContain('Adds this block to the file, between two marker lines:');
    expect(run.out).toContain('  + .env\n  + .env.*\n');
    expect(run.out).toContain('+# >>> stroq harden: cursor-ignore >>>');
    expect(run.out).toContain(
      'Not verified: Stroq has not been able to test this against Cursor, so it cannot say that Cursor keeps these files out of what it sends to a model.',
    );
    expect(readFileSync(world.inProject('.cursorignore'), 'utf8')).toBe('dist/\n');
  });

  describe('when Claude Code is told to keep its configuration somewhere else', () => {
    const SAID =
      'CLAUDE_CONFIG_DIR is set here, so Claude Code may read its user settings from that folder and not from ~/.claude; Stroq edits ~/.claude/settings.json.';

    it('says so at the user scope, where the settings file is the one it would miss', async () => {
      const world = hardenWorld();

      const run = await world.run([], { claudeConfigDir: '/somewhere/else' });

      expect(run.code).toBe(0);
      expect(run.out).toContain(`  - ${SAID}`);
    });

    it('says nothing about it at the project scope, or when it is not set', async () => {
      const world = hardenWorld();

      const project = await world.run(['--scope', 'project'], {
        claudeConfigDir: '/somewhere/else',
      });
      const plain = await world.run([]);

      expect(project.out).not.toContain('CLAUDE_CONFIG_DIR');
      expect(plain.out).not.toContain('CLAUDE_CONFIG_DIR');
    });
  });

  describe('--json', () => {
    it('prints one object with the plan, and no raw file text', async () => {
      const world = hardenWorld();
      mkdirSync(world.inHome('.claude'));
      writeFileSync(
        world.inHome('.claude', 'settings.json'),
        settings({ model: 'opus', permissions: { deny: ['Read(~/.npmrc)'] } }),
      );

      const run = await world.run(['--json']);

      expect(run.code).toBe(0);
      expect(run.out.endsWith('\n')).toBe(true);
      const plan = JSON.parse(run.out) as Record<string, unknown>;
      expect(Object.keys(plan)).toEqual([
        'command',
        'action',
        'recipe',
        'agent',
        'scope',
        'summary',
        'file',
        'real',
        'exists',
        'changed',
        'refused',
        'items',
        'diff',
        'diffWithheld',
        'backup',
        'notices',
        'limits',
        'unverified',
        'needs',
        'outcome',
      ]);
      expect(plan).toMatchObject({
        command: 'harden',
        action: 'plan',
        recipe: 'claude-read-deny',
        agent: 'claude-code',
        scope: 'user',
        file: world.inHome('.claude', 'settings.json'),
        exists: true,
        changed: true,
        refused: null,
        diffWithheld: false,
        backup: 'copy',
        unverified: null,
        needs: {
          acknowledgeLink: false,
          acknowledgeCredentialLoss: false,
          acknowledgeReformat: false,
        },
        outcome: { status: 'planned' },
      });
      const items = plan['items'] as { text: string; status: string }[];
      expect(items).toHaveLength(CLAUDE_READ_DENY_RULES.length);
      expect(items.find((item) => item.text === 'Read(~/.npmrc)')?.status).toBe('present');
      expect(items.find((item) => item.text === 'Read(./.env)')?.status).toBe('add');
      expect(plan['diff']).toContain('+      "Read(./.env)",');
      expect(Object.keys(plan)).not.toContain('before');
      expect(Object.keys(plan)).not.toContain('after');
    });

    it('carries the refusal, and the snippet for a file with comments', async () => {
      const world = hardenWorld();
      mkdirSync(world.inHome('.claude'));
      writeFileSync(world.inHome('.claude', 'settings.json'), '{ /* c */ }\n');

      const run = await world.run(['--json']);

      expect(run.code).toBe(1);
      const plan = JSON.parse(run.out) as {
        refused: { reason: string; detail: string; snippet: string | null };
        outcome: { status: string };
      };
      expect(plan.refused.reason).toBe('jsonc');
      expect(plan.refused.snippet).toContain('"Read(./.env)"');
      expect(plan.outcome.status).toBe('refused');
    });
  });
});
