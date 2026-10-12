import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { removeTempDirs } from '../harden/helpers.js';
import { bytesOf, settingsText } from '../helpers/harden-fixtures.js';
import { hardenWorld, treeHash, type HardenWorld } from '../helpers/harden-world.js';

afterEach(removeTempDirs);

const onWindows = process.platform === 'win32';
const SETTINGS = ['.claude', 'settings.json'] as const;

// eslint-disable-next-line no-control-regex
const RAW_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

interface StatusItem {
  readonly text: string;
  readonly state: string;
}
interface StatusFile {
  readonly file: string;
  readonly recipes: string[];
  readonly changes: number;
  readonly appliedAt: string;
  readonly created: boolean;
  readonly state: string;
  readonly items: StatusItem[];
  readonly editedSince: boolean;
  readonly backup: string;
  readonly pathNow: string;
  readonly notices: string[];
}

async function statusJson(world: HardenWorld): Promise<StatusFile[]> {
  const run = await world.run(['status', '--json']);
  expect(run.code).toBe(0);
  return (JSON.parse(run.out) as { files: StatusFile[] }).files;
}

/** A world where Claude Code's user settings had settings and a rule of their own, and the recipe was applied. */
async function appliedOverOwners(): Promise<{ world: HardenWorld; file: string }> {
  const world = hardenWorld();
  mkdirSync(world.inHome('.claude'));
  const file = world.inHome(...SETTINGS);
  writeFileSync(
    file,
    settingsText({ model: 'opus', permissions: { deny: ['Bash(rm:*)', 'Read(~/.npmrc)'] } }),
  );
  await world.runPiped(['apply', '--yes']);
  return { world, file };
}

describe('stroq harden status', () => {
  it('says nothing was applied, and how to see what would be', async () => {
    const world = hardenWorld();

    const run = await world.run(['status']);

    expect(run.code).toBe(0);
    expect(run.out).toContain('Nothing applied: stroq harden has not changed any file.');
    expect(run.out).toContain('To see what it would do: stroq harden');
    expect(await statusJson(world)).toEqual([]);
  });

  it('writes nothing', async () => {
    const { world } = await appliedOverOwners();
    const before = [treeHash(world.home), treeHash(world.stroqHome)];

    await world.run(['status']);
    await world.run(['status', '--json']);

    expect([treeHash(world.home), treeHash(world.stroqHome)]).toEqual(before);
  });

  it('reports a file whose changes are all in place, with the owner`s rule as the owner`s', async () => {
    const { world, file } = await appliedOverOwners();

    const run = await world.run(['status']);

    expect(run.code).toBe(0);
    expect(run.out).toContain(`${file}\n`);
    expect(run.out).toContain('Applied by claude-read-deny, 1 change, the last on');
    expect(run.out).toContain('State: everything Stroq added is in place (11 of 11).');
    expect(run.out).toContain('Copy: a byte copy of the file as it was is kept.');
    expect(run.out).toContain('The file has not been edited since.');
    const [report] = await statusJson(world);
    expect(report).toMatchObject({
      file,
      recipes: ['claude-read-deny'],
      changes: 1,
      created: false,
      state: 'in-place',
      editedSince: false,
      backup: 'kept',
      pathNow: 'same',
      notices: [],
    });
    expect(report?.items.find((item) => item.text === 'Read(~/.npmrc)')?.state).toBe('yours');
    expect(report?.items.filter((item) => item.state === 'present')).toHaveLength(11);
  });

  it('reports a rule the owner took out, by name, and that the file was edited since', async () => {
    const { world, file } = await appliedOverOwners();
    const doc = JSON.parse(bytesOf(file)) as { permissions: { deny: string[] } };
    doc.permissions.deny = doc.permissions.deny.filter(
      (rule) => rule !== 'Read(~/.ssh/**)' && rule !== 'Read(~/.aws/**)',
    );
    writeFileSync(file, settingsText(doc));

    const run = await world.run(['status']);

    expect(run.out).toContain('State: only part of what Stroq added is in place (9 of 11).');
    expect(run.out).toContain('Missing: Read(~/.ssh/**), Read(~/.aws/**)');
    expect(run.out).toContain('The file has been edited since Stroq last changed it.');
    const [report] = await statusJson(world);
    expect(report).toMatchObject({ state: 'partial', editedSince: true });
    expect(
      report?.items.filter((item) => item.state === 'missing').map((item) => item.text),
    ).toEqual(['Read(~/.ssh/**)', 'Read(~/.aws/**)']);
  });

  it('reports that none of it is left', async () => {
    const { world, file } = await appliedOverOwners();
    writeFileSync(file, settingsText({ model: 'opus' }));

    const [report] = await statusJson(world);

    expect(report).toMatchObject({ state: 'gone', editedSince: true });
    expect((await world.run(['status'])).out).toContain(
      'State: none of what Stroq added is in the file now.',
    );
  });

  it('reports a file that is not there any more', async () => {
    const { world, file } = await appliedOverOwners();
    rmSync(file);

    const run = await world.run(['status']);

    expect(run.out).toContain('State: the file is not there now.');
    expect((await statusJson(world))[0]).toMatchObject({ state: 'missing' });
  });

  it('reports a file it can no longer read, and why, without quoting it', async () => {
    const { world, file } = await appliedOverOwners();
    writeFileSync(file, '{\n  // PLANTED-NOTE\n}\n');

    const run = await world.run(['status']);

    expect(run.out).toContain('State: Stroq cannot check the file: it is not plain JSON now');
    expect(run.out).not.toContain('PLANTED-NOTE');
    expect((await statusJson(world))[0]).toMatchObject({ state: 'unreadable' });
  });

  it('says when the copy is gone', async () => {
    const { world } = await appliedOverOwners();
    rmSync(join(world.stroqHome, 'backups'), { recursive: true });

    const run = await world.run(['status']);

    expect(run.out).toContain(
      'Copy: the byte copy that was kept is gone, so undo can only take out what Stroq added.',
    );
    expect((await statusJson(world))[0]).toMatchObject({ backup: 'gone' });
  });

  it('says when no copy was kept, and why, for a file Stroq made', async () => {
    const world = hardenWorld();
    await world.runPiped(['apply', '--yes']);

    const run = await world.run(['status']);

    expect(run.out).toContain('Copy: none was kept, because Stroq made the file; undo removes it.');
    expect((await statusJson(world))[0]).toMatchObject({
      created: true,
      backup: 'none',
      state: 'in-place',
    });
  });

  it.skipIf(onWindows)('says when the path now leads to another file', async () => {
    const { world, file } = await appliedOverOwners();
    const elsewhere = world.inHome('elsewhere.json');
    writeFileSync(elsewhere, '{}\n');
    rmSync(file);
    symlinkSync(elsewhere, file);

    const run = await world.run(['status']);

    expect(run.out).toContain('The path now leads to another file than the one Stroq edited.');
    expect((await statusJson(world))[0]).toMatchObject({ pathNow: 'moved' });
  });

  it('reports a block in .cursorignore, and one the owner edited', async () => {
    const world = hardenWorld();
    const file = world.inProject('.cursorignore');
    await world.runPiped(['apply', '--yes', '--agent', 'cursor']);
    expect((await statusJson(world))[0]).toMatchObject({
      recipes: ['cursor-ignore'],
      state: 'in-place',
    });

    writeFileSync(file, bytesOf(file).replace('.env.*', '.env.local'));
    const [edited] = await statusJson(world);

    expect(edited).toMatchObject({ state: 'partial' });
    expect(edited?.items.map((item) => item.state)).toEqual(['edited', 'edited']);
  });

  it('reports every file it changed, in path order', async () => {
    const world = hardenWorld();
    await world.runPiped(['apply', '--yes']);
    await world.runPiped(['apply', '--yes', '--scope', 'project']);

    const files = await statusJson(world);

    expect(files.map((report) => report.file)).toEqual(
      [world.inHome(...SETTINGS), world.inProject('.claude', 'settings.local.json')].sort(),
    );
  });

  it('prints one object in --json, with the files and an outcome', async () => {
    const { world } = await appliedOverOwners();

    const run = await world.run(['status', '--json']);

    const object = JSON.parse(run.out) as Record<string, unknown>;
    expect(Object.keys(object)).toEqual(['command', 'action', 'files', 'outcome']);
    expect(object).toMatchObject({
      command: 'harden',
      action: 'status',
      outcome: { status: 'status' },
    });
  });

  it('refuses a manifest it cannot trust, in plain words', async () => {
    const world = hardenWorld();
    await world.runPiped(['apply', '--yes']);
    writeFileSync(join(world.stroqHome, 'harden', 'manifest.json'), 'not json PLANTED-TEXT');

    const run = await world.run(['status']);

    expect(run.code).toBe(1);
    expect(run.err).toContain('the manifest is not valid JSON');
    expect(run.err + run.out).not.toContain('PLANTED-TEXT');
  });

  it.skipIf(onWindows)('prints no raw control character from a path', async () => {
    const world = hardenWorld();
    const folder = join(world.project, 'p\u001b[2Jq\nFORGED');
    mkdirSync(folder);
    await world.run(['apply', '--yes', '--scope', 'project'], { cwd: folder });

    const run = await world.run(['status']);

    expect(run.code).toBe(0);
    expect(run.out).toContain('p\\u001b[2Jq\\nFORGED');
    expect(run.out + run.err).not.toMatch(RAW_CONTROL);
    expect(run.out).not.toContain('\nFORGED');
  });
});
