import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyPlan, undoFile } from '../../src/harden/index.js';
import { replayJsonPlan } from '../../src/harden/json-edit.js';
import { readManifest } from '../../src/harden/manifest.js';
import { addDeny, engine, IGNORE_ID, IGNORE_LINES, jsonText } from './engine-setup.js';
import { removeTempDirs } from './helpers.js';

afterEach(removeTempDirs);

/**
 * A link that stays inside the project is followed, and that is right (a dotfile linked in from
 * a dotfiles directory is how many people keep their settings), but it must not be silent: a
 * repository chooses its links, and one that points `.cursorignore` at `.env`, `package.json` or
 * `.git/config` makes the change land in a file the owner never named. The owner is told, in the
 * plan, which file the change really lands in, and the apply asks for the owner's word.
 */
const SECRET = 'stroq_attack_fixture_value_0123456789';
const onWindows = process.platform === 'win32';
const label = (path: string): string => path.replace(/^\/+/, '');

/** Plans, applies and undoes in a project where `link` points at `target`. */
function linked(target: string, link: string, content: string) {
  const e = engine();
  const targetPath = e.file(target);
  mkdirSync(join(targetPath, '..'), { recursive: true });
  writeFileSync(targetPath, content);
  mkdirSync(join(e.file(link), '..'), { recursive: true });
  symlinkSync(targetPath, e.file(link));
  return { e, targetPath, linkPath: e.file(link) };
}

describe.skipIf(onWindows)('a link inside the project', () => {
  describe('the plan', () => {
    it('labels an acknowledged diff with the file the change lands in, and not with the link', () => {
      const { e, targetPath } = linked('package.json', 'settings.json', jsonText({ name: 'x' }));

      const plan = e.planJson('settings.json', [addDeny('a')], { acknowledgeLink: true });

      const [header] = plan.diff.split('\n');
      expect(header).toBe(`--- a/${label(targetPath)}`);
      expect(plan.diff).not.toContain('settings.json');
    });

    it('says which file the change lands in, naming the link and its target', () => {
      const { e, targetPath, linkPath } = linked('package.json', 'settings.json', jsonText({}));

      const plan = e.planJson('settings.json', [addDeny('a')]);

      const notice = plan.notices.find((text) => text.includes(targetPath));
      expect(notice).toBeDefined();
      expect(notice).toContain(linkPath);
      expect(notice).toContain('link');
      expect(notice).toContain('the change lands there');
    });

    it('says the same for the planner of a block of lines', () => {
      const { e, targetPath, linkPath } = linked('.env', '.cursorignore', `API_TOKEN=${SECRET}\n`);

      const plan = e.planBlock('.cursorignore');

      expect(
        plan.notices.some((text) => text.includes(linkPath) && text.includes(targetPath)),
      ).toBe(true);
      expect(plan.real).toBe(targetPath);
      expect(plan.file).toBe(linkPath);
    });

    it('is not refused: a link that stays in the project is followed', () => {
      const { e } = linked('package.json', 'settings.json', jsonText({}));

      const plan = e.planJson('settings.json', [addDeny('a')]);

      expect(plan.refused).toBeUndefined();
      expect(plan.changed).toBe(true);
    });

    it.each([
      ['a link to .env', '.env', '.cursorignore', `# local\nAPI_TOKEN=${SECRET}\nPORT=3000\n`],
      ['a link to package.json', 'package.json', '.cursorignore', jsonText({ name: 'x' })],
      ['a link to .git/config', '.git/config', '.cursorignore', '[core]\n\tbare = false\n'],
    ])(
      'shows the owner %s as a link, with the file it lands in',
      (_what, target, link, content) => {
        const { e, targetPath } = linked(target, link, content);

        const plan = e.planBlock(link, IGNORE_LINES, { acknowledgeLink: true });

        expect(plan.diff.split('\n')[0]).toBe(`--- a/${label(targetPath)}`);
        expect(plan.notices.join('\n')).toContain(targetPath);
      },
    );

    it('does not put the credential in the file it lands in on show', () => {
      const { e } = linked('.env', '.cursorignore', `# local\nAPI_TOKEN=${SECRET}\nPORT=3000\n`);

      const plan = e.planBlock('.cursorignore');

      expect(plan.diff).not.toContain(SECRET);
      expect(plan.backup).toBe('none-credential-text');
    });

    it('says nothing of a link about a file that is not one', () => {
      const e = engine();
      writeFileSync(e.file('settings.json'), jsonText({}));

      const plan = e.planJson('settings.json', [addDeny('a')]);

      expect(plan.notices.filter((text) => text.includes('link'))).toEqual([]);
      expect(plan.diff.split('\n')[0]).toBe(`--- a/${label(plan.real)}`);
    });

    it('says it of a link in a directory above the file too', () => {
      const e = engine();
      mkdirSync(e.file('shared/cursor'), { recursive: true });
      writeFileSync(e.file('shared/cursor/mcp.json'), jsonText({}));
      symlinkSync(e.file('shared/cursor'), e.file('.cursor'));

      const plan = e.planJson('.cursor/mcp.json', [addDeny('a')]);

      expect(plan.real).toBe(e.file('shared/cursor/mcp.json'));
      expect(plan.notices.join('\n')).toContain(e.file('shared/cursor/mcp.json'));
    });

    it('says it of a file that is not there yet, in a directory that is a link', () => {
      const e = engine();
      mkdirSync(e.file('shared/cursor'), { recursive: true });
      symlinkSync(e.file('shared/cursor'), e.file('.cursor'));

      const plan = e.planJson('.cursor/mcp.json', [addDeny('a')], { acknowledgeLink: true });

      expect(plan.existed).toBe(false);
      expect(plan.notices.join('\n')).toContain(e.file('shared/cursor/mcp.json'));
      expect(plan.diff.split('\n')[0]).toBe('--- /dev/null');
      expect(plan.diff).toContain(`+++ b/${label(e.file('shared/cursor/mcp.json'))}`);
    });

    it('keeps a plan that a planner made consistent: applying it is not refused as inconsistent', async () => {
      const { e } = linked('package.json', 'settings.json', jsonText({ name: 'x' }));
      const plan = e.planJson('settings.json', [addDeny('a')]);

      await expect(applyPlan(plan, e.env, { acknowledgeLink: true })).resolves.toMatchObject({
        changed: true,
      });
    });
  });

  describe('applying it', () => {
    it('is refused until the caller says the owner has seen that it is a link', async () => {
      const { e, targetPath } = linked('package.json', 'settings.json', jsonText({ name: 'x' }));
      const before = readFileSync(targetPath, 'utf8');
      const plan = e.planJson('settings.json', [addDeny('a')]);

      await expect(applyPlan(plan, e.env)).rejects.toMatchObject({
        code: 'link-not-acknowledged',
      });

      expect(readFileSync(targetPath, 'utf8')).toBe(before);
      expect(readManifest(e.env).files).toEqual({});
      expect(
        existsSync(join(e.home, 'backups')) ? readdirSync(join(e.home, 'backups')) : [],
      ).toEqual([]);
    });

    it('names the link and the file in the refusal', async () => {
      const { e, targetPath, linkPath } = linked('package.json', 'settings.json', jsonText({}));
      const plan = e.planJson('settings.json', [addDeny('a')]);

      const error = await applyPlan(plan, e.env).catch((err: unknown) => err);

      expect((error as Error).message).toContain(linkPath);
      expect((error as Error).message).toContain(targetPath);
    });

    it('goes ahead once it is told, edits the file the link leads to and leaves the link a link', async () => {
      const { e, targetPath, linkPath } = linked('package.json', 'settings.json', jsonText({}));
      const plan = e.planJson('settings.json', [addDeny('a')]);

      const result = await applyPlan(plan, e.env, { acknowledgeLink: true });

      expect(result.real).toBe(targetPath);
      expect(JSON.parse(readFileSync(targetPath, 'utf8'))).toMatchObject({
        permissions: { deny: ['a'] },
      });
      expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
      expect(readManifest(e.env).files[targetPath]).toHaveLength(1);
    });

    it.each([
      ['.env', '.env', `API_TOKEN=${SECRET}\n`],
      ['package.json', 'package.json', jsonText({ name: 'x' })],
      ['.git/config', '.git/config', '[core]\n\tbare = false\n'],
    ])('asks before it appends a block to a link to %s', async (_what, target, content) => {
      const { e, targetPath } = linked(target, '.cursorignore', content);
      const plan = e.planBlock('.cursorignore');

      await expect(applyPlan(plan, e.env)).rejects.toMatchObject({ code: 'link-not-acknowledged' });

      expect(readFileSync(targetPath, 'utf8')).toBe(content);
      expect(readFileSync(targetPath, 'utf8')).not.toContain(IGNORE_ID);
    });

    it('applies the block to the file the link leads to once it is told', async () => {
      const { e, targetPath } = linked('.env', '.cursorignore', 'PORT=3000\n');
      const plan = e.planBlock('.cursorignore');

      await applyPlan(plan, e.env, { acknowledgeLink: true });

      const text = readFileSync(targetPath, 'utf8');
      expect(text).toContain(IGNORE_LINES.join('\n'));
      expect(text.startsWith('PORT=3000\n')).toBe(true);
    });

    it('asks for a link in a directory above the file, and for a file made there', async () => {
      const e = engine();
      mkdirSync(e.file('shared/cursor'), { recursive: true });
      symlinkSync(e.file('shared/cursor'), e.file('.cursor'));
      const plan = e.planJson('.cursor/mcp.json', [addDeny('a')]);

      await expect(applyPlan(plan, e.env)).rejects.toMatchObject({ code: 'link-not-acknowledged' });
      expect(existsSync(e.file('shared/cursor/mcp.json'))).toBe(false);

      await applyPlan(plan, e.env, { acknowledgeLink: true });
      expect(existsSync(e.file('shared/cursor/mcp.json'))).toBe(true);
    });

    it('does not ask for a file that is not a link', async () => {
      const e = engine();
      writeFileSync(e.file('settings.json'), jsonText({}));
      const plan = e.planJson('settings.json', [addDeny('a')]);

      await expect(applyPlan(plan, e.env)).resolves.toMatchObject({ changed: true });
    });

    it('does not ask for a plan that changes nothing', async () => {
      const { e } = linked(
        'package.json',
        'settings.json',
        jsonText({ permissions: { deny: ['a'] } }),
      );
      const plan = e.planJson('settings.json', [addDeny('a')]);

      await expect(applyPlan(plan, e.env)).resolves.toMatchObject({ changed: false });
    });

    it('cannot be got round by a plan that says it is not a link', async () => {
      const { e, targetPath, linkPath } = linked('package.json', 'settings.json', jsonText({}));
      writeFileSync(e.file('copy.json'), jsonText({}));
      // A plan is plain data. This one is a plan of a plain copy, made to read as a plan of the
      // link: its file and its real path are the link's, and it is consistent with itself.
      const forged = replayJsonPlan({
        ...e.planJson('copy.json', [addDeny('a')]),
        file: linkPath,
        real: linkPath,
      });

      await expect(applyPlan(forged, e.env)).rejects.toMatchObject({ code: 'stale-plan' });

      expect(readFileSync(targetPath, 'utf8')).toBe(jsonText({}));
    });

    it('is not needed to undo: the owner has already agreed to what was done to that file', async () => {
      const { e, targetPath } = linked('package.json', 'settings.json', jsonText({ name: 'x' }));
      const before = readFileSync(targetPath, 'utf8');
      const plan = e.planJson('settings.json', [addDeny('a')]);
      await applyPlan(plan, e.env, { acknowledgeLink: true });

      const result = await undoFile(e.env, targetPath, { root: e.project });

      expect(result.status).toBe('restored');
      expect(readFileSync(targetPath, 'utf8')).toBe(before);
    });
  });
});
