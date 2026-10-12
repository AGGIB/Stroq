import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CLAUDE_READ_DENY_RULES } from '../../src/harden/recipes/credential-paths.js';
import { removeTempDirs, tempDir } from '../harden/helpers.js';
import { hardenWorld, treeHash } from '../helpers/harden-world.js';

afterEach(removeTempDirs);

const onWindows = process.platform === 'win32';

/** Any control character or direction override: what a terminal would obey. A tab and a newline are layout. */
// eslint-disable-next-line no-control-regex
const RAW_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

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
    expect(run.out).toContain(`+++ b${file}`);
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
        `+++ b${file}`,
        '@@ -0,0 +1,18 @@',
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
    expect(run.out).toContain('Nothing to change: every rule is already in place.');
    expect(run.out).not.toContain('The change:');
    expect(run.out).not.toContain('To apply it');
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

  describe('a settings file with comments', () => {
    it('writes nothing, says why, and prints the exact lines to add by hand', async () => {
      const world = hardenWorld();
      mkdirSync(world.inHome('.claude'));
      const original = '{\n  // my notes\n  "model": "opus"\n}\n';
      writeFileSync(world.inHome('.claude', 'settings.json'), original);
      const before = treeHash(world.home);

      const run = await world.run([]);

      expect(run.code).toBe(1);
      expect(treeHash(world.home)).toBe(before);
      expect(run.out).toContain('Refused: the file has comments or a trailing comma');
      expect(run.out).toContain('To make the change by hand, add this inside the top-level braces');
      expect(run.out).toContain(
        ['    "permissions": {', '      "deny": [', '        "Read(./.env)",'].join('\n'),
      );
      expect(run.out).toContain('        "Read(~/.gnupg/**)"\n      ]\n    }\n');
      // Nothing of the file is shown: not the comment, not a setting.
      expect(run.out).not.toContain('my notes');
      expect(run.out).not.toContain('opus');
      expect(run.err).toContain('nothing was written');
    });

    it('does the same for a trailing comma', async () => {
      const world = hardenWorld();
      mkdirSync(world.inHome('.claude'));
      writeFileSync(world.inHome('.claude', 'settings.json'), '{"model": "opus",}\n');

      const run = await world.run([]);

      expect(run.code).toBe(1);
      expect(run.out).toContain('To make the change by hand');
    });
  });

  describe('a settings file that cannot be edited for another reason', () => {
    it.each([
      ['not JSON at all', 'this is not json', /not valid JSON/],
      ['an array at the top', '[]\n', /not an object/],
      [
        'a permissions that is not an object',
        '{"permissions": 3}\n',
        /permissions is not an object/,
      ],
      [
        'a deny that is not a list',
        '{"permissions": {"deny": "x"}}\n',
        /permissions.deny is not an array/,
      ],
    ])('refuses %s, and prints nothing of it', async (_name, text, reason) => {
      const world = hardenWorld();
      mkdirSync(world.inHome('.claude'));
      writeFileSync(world.inHome('.claude', 'settings.json'), text);
      const before = treeHash(world.home);

      const run = await world.run([]);

      expect(run.code).toBe(1);
      expect(run.out).toMatch(reason);
      expect(run.out).not.toContain('this is not json');
      expect(run.out).not.toContain('To make the change by hand');
      expect(treeHash(world.home)).toBe(before);
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

  describe('a path that is a link', () => {
    it.skipIf(onWindows)(
      'withholds the diff and exits 3 until the link is acknowledged',
      async () => {
        const world = hardenWorld();
        mkdirSync(world.inHome('dotfiles'));
        mkdirSync(world.inHome('.claude'));
        writeFileSync(
          world.inHome('dotfiles', 'claude.json'),
          settings({ model: 'SECRETISH-MODEL-NAME' }),
        );
        symlinkSync(
          world.inHome('dotfiles', 'claude.json'),
          world.inHome('.claude', 'settings.json'),
        );
        const before = treeHash(world.home);

        const run = await world.run([]);

        expect(run.code).toBe(3);
        expect(treeHash(world.home)).toBe(before);
        expect(run.out).toContain('this path is a link');
        expect(run.out).toContain(world.inHome('dotfiles', 'claude.json'));
        expect(run.out).toContain('The change: not shown, because the path is a link.');
        expect(run.out).toContain(
          'stroq harden plan --agent claude-code --scope user --acknowledge-link',
        );
        expect(run.out).not.toContain('SECRETISH-MODEL-NAME');
        expect(run.out).not.toContain('+      "Read(./.env)",');
        expect(run.err).toContain('--acknowledge-link');
      },
    );

    it.skipIf(onWindows)(
      'shows the diff, of the file the link leads to, with --acknowledge-link',
      async () => {
        const world = hardenWorld();
        mkdirSync(world.inHome('dotfiles'));
        mkdirSync(world.inHome('.claude'));
        writeFileSync(world.inHome('dotfiles', 'claude.json'), settings({ model: 'opus' }));
        symlinkSync(
          world.inHome('dotfiles', 'claude.json'),
          world.inHome('.claude', 'settings.json'),
        );

        const run = await world.run(['--acknowledge-link']);

        expect(run.code).toBe(0);
        expect(run.out).toContain(`+++ b${world.inHome('dotfiles', 'claude.json')}`);
        expect(run.out).toContain('+      "Read(./.env)",');
        expect(run.out).toContain('this path is a link');
      },
    );

    it.skipIf(onWindows)(
      'refuses a link that leaves the folder, and never reads what it leads to',
      async () => {
        const world = hardenWorld();
        const outside = tempDir('outside');
        writeFileSync(join(outside, 'target.json'), settings({ apiKey: 'OUTSIDE-FILE-CONTENT' }));
        mkdirSync(world.inProject('.claude'));
        symlinkSync(
          join(outside, 'target.json'),
          world.inProject('.claude', 'settings.local.json'),
        );

        const run = await world.run(['--scope', 'project']);

        expect(run.code).toBe(1);
        expect(run.out).toMatch(/outside/);
        expect(run.out).not.toContain('OUTSIDE-FILE-CONTENT');
        expect(run.err).not.toContain('OUTSIDE-FILE-CONTENT');
      },
    );
  });

  describe('what a hostile file or folder name can do to a terminal', () => {
    it('prints no raw control character taken from a path or from a file', async () => {
      const world = hardenWorld();
      // Raw U+202E and U+0085 are valid inside a JSON string, so the file is plain JSON, and the lines
      // around the change are shown as context.
      const hostile = 'x\u202egnp.\u0085y';
      mkdirSync(world.inHome('.claude'));
      writeFileSync(
        world.inHome('.claude', 'settings.json'),
        `{\n  "model": "${hostile}",\n  "permissions": {\n    "deny": []\n  }\n}\n`,
      );

      const run = await world.run([]);

      expect(run.code).toBe(0);
      expect(run.out).toContain('"model": "x\\u202egnp.\\u0085y"');
      expect(run.out + run.err).not.toMatch(RAW_CONTROL);
    });

    it.skipIf(onWindows)(
      'prints no raw control character from the name of the project folder',
      async () => {
        const world = hardenWorld();
        const name = 'proj\u001b[2Jx\nINJECTED\u202e';
        const folder = join(world.project, name);
        mkdirSync(folder);

        const run = await world.run(['--scope', 'project'], { cwd: folder });

        expect(run.code).toBe(0);
        expect(run.out).toContain('proj\\u001b[2Jx\\nINJECTED\\u202e');
        expect(run.out + run.err).not.toMatch(RAW_CONTROL);
        // The line break in the name is written out, so the name is one line and not a forged second.
        expect(run.out).not.toContain('\nINJECTED');
      },
    );
  });

  it.skipIf(onWindows)('reports a file it cannot read as a refusal, with no stack', async () => {
    const world = hardenWorld();
    mkdirSync(world.inHome('.claude'));
    mkdirSync(world.inHome('.claude', 'settings.json'));

    const run = await world.run([]);

    expect(run.code).toBe(1);
    expect(run.err).toMatch(/not a regular file/);
    expect(run.err).not.toMatch(/\n\s+at /);
  });

  it.skipIf(onWindows)(
    'still plans a file that is read-only, which only apply refuses',
    async () => {
      const world = hardenWorld();
      mkdirSync(world.inHome('.claude'));
      writeFileSync(world.inHome('.claude', 'settings.json'), '{}\n');
      chmodSync(world.inHome('.claude', 'settings.json'), 0o444);

      const run = await world.run([]);

      expect(run.code).toBe(0);
      expect(run.out).toContain('+      "Read(./.env)",');
    },
  );
});
