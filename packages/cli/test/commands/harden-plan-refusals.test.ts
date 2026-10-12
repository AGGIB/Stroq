import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { removeTempDirs, tempDir } from '../harden/helpers.js';
import { diffLabel } from '../helpers/harden-fixtures.js';
import { hardenWorld, treeHash } from '../helpers/harden-world.js';

afterEach(removeTempDirs);

const onWindows = process.platform === 'win32';

/** Any control character or direction override: what a terminal would obey. A tab and a newline are layout. */
// eslint-disable-next-line no-control-regex
const RAW_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

const settings = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

describe('stroq harden (plan): files and paths it refuses, and names that cannot be trusted', () => {
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
        expect(run.out).toContain(`+++ b/${diffLabel(world.inHome('dotfiles', 'claude.json'))}`);
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
