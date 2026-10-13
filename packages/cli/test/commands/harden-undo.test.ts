import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CLAUDE_READ_DENY_RULES } from '../../src/harden/recipes/credential-paths.js';
import { removeTempDirs, tempDir } from '../harden/helpers.js';
import { bytesOf, recordsFor, settingsText } from '../helpers/harden-fixtures.js';
import {
  askingTerminal,
  hardenWorld,
  treeHash,
  type HardenWorld,
} from '../helpers/harden-world.js';

afterEach(removeTempDirs);

const onWindows = process.platform === 'win32';
const SETTINGS = ['.claude', 'settings.json'] as const;

/** A settings file with settings of the owner's and one of the rules the recipe adds already in it. */
const OWNERS = settingsText({
  model: 'opus',
  permissions: { allow: ['Bash(ls)'], deny: ['Bash(rm:*)', 'Read(~/.npmrc)'] },
});

function withOwnersFile(): { world: HardenWorld; file: string } {
  const world = hardenWorld();
  mkdirSync(world.inHome('.claude'));
  const file = world.inHome(...SETTINGS);
  writeFileSync(file, OWNERS);
  return { world, file };
}

/** The owner edits the settings file the way an editor would. */
function ownerEdits(
  file: string,
  change: (doc: Record<string, unknown>) => Record<string, unknown>,
) {
  const doc = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  writeFileSync(file, settingsText(change(doc)));
}

describe('stroq harden undo: giving the file back', () => {
  it('puts back every byte of a file with other settings and a rule of its own', async () => {
    const { world, file } = withOwnersFile();
    await world.runPiped(['apply', '--yes']);
    expect(bytesOf(file)).not.toBe(OWNERS);

    const run = await world.runPiped(['undo', '--yes']);

    expect(run.code).toBe(0);
    expect(bytesOf(file)).toBe(OWNERS);
    expect(run.out).toContain('The file is as it was before Stroq changed it, byte for byte.');
    expect(recordsFor(world.stroqHome, file)).toEqual([]);
  });

  it('removes a file Stroq made, and says so', async () => {
    const world = hardenWorld();
    const file = world.inHome(...SETTINGS);
    await world.runPiped(['apply', '--yes']);
    expect(existsSync(file)).toBe(true);

    const run = await world.runPiped(['undo', '--yes']);

    expect(run.code).toBe(0);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(world.inHome('.claude'))).toBe(false);
    expect(run.out).toContain('The file Stroq made is removed.');
    expect(recordsFor(world.stroqHome, file)).toEqual([]);
  });

  it('removes the empty folder apply made, and leaves it when another file is in it', async () => {
    const world = hardenWorld();
    const file = world.inProject('.claude', 'settings.local.json');
    await world.runPiped(['apply', '--yes', '--scope', 'project']);
    expect(existsSync(file)).toBe(true);
    expect(existsSync(world.inProject('.claude'))).toBe(true);

    writeFileSync(world.inProject('.claude', 'other.json'), '{}\n');

    const run = await world.runPiped(['undo', '--yes', '--scope', 'project']);
    expect(run.code).toBe(0);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(world.inProject('.claude'))).toBe(true);
    expect(existsSync(world.inProject('.claude', 'other.json'))).toBe(true);
  });

  it('keeps what the owner did since, and takes out only what Stroq added', async () => {
    const { world, file } = withOwnersFile();
    await world.runPiped(['apply', '--yes']);
    ownerEdits(file, (doc) => ({ ...doc, theme: 'dark', model: 'sonnet' }));

    const run = await world.runPiped(['undo', '--yes']);

    expect(run.code).toBe(0);
    const doc = JSON.parse(bytesOf(file)) as {
      model: string;
      theme: string;
      permissions: { allow: string[]; deny: string[] };
    };
    expect(doc.model).toBe('sonnet');
    expect(doc.theme).toBe('dark');
    // Theirs stay, in their order, the rule they had of ours included; ours are gone.
    expect(doc.permissions.deny).toEqual(['Bash(rm:*)', 'Read(~/.npmrc)']);
    expect(doc.permissions.allow).toEqual(['Bash(ls)']);
    expect(run.out).toContain('took out what it added and left everything else');
    expect(recordsFor(world.stroqHome, file)).toEqual([]);
  });

  it('leaves a rule the owner added to the same list, and one of ours the owner took out', async () => {
    const { world, file } = withOwnersFile();
    await world.runPiped(['apply', '--yes']);
    ownerEdits(file, (doc) => {
      const permissions = doc['permissions'] as { deny: string[] };
      const deny = permissions.deny.filter((rule) => rule !== 'Read(~/.ssh/**)');
      return { ...doc, permissions: { ...permissions, deny: [...deny, 'Bash(curl:*)'] } };
    });

    const run = await world.runPiped(['undo', '--yes']);

    expect(run.code).toBe(0);
    const doc = JSON.parse(bytesOf(file)) as { permissions: { deny: string[] } };
    expect(doc.permissions.deny).toEqual(['Bash(rm:*)', 'Read(~/.npmrc)', 'Bash(curl:*)']);
  });

  it('shows what it did, and not the text of the file', async () => {
    const { world } = withOwnersFile();
    await world.runPiped(['apply', '--yes']);

    const run = await world.runPiped(['undo', '--yes']);

    expect(run.out).toContain('The change undo made:');
    expect(run.out).toContain('-      "Read(./.env)",');
    expect(run.out).not.toContain('Bash(ls)');
  });

  it('clears the record of a file the owner has deleted, and says that is all there was to do', async () => {
    const { world, file } = withOwnersFile();
    await world.runPiped(['apply', '--yes']);
    rmSync(file);

    const run = await world.runAsking(['undo'], ['y']);

    expect(run.code).toBe(0);
    expect(run.out).toContain('The file is not there now, so undo has nothing to take out of it');
    expect(run.out).toContain(
      "Nothing of Stroq's was left in the file, so only its record is cleared.",
    );
    expect(existsSync(file)).toBe(false);
    expect(recordsFor(world.stroqHome, file)).toEqual([]);
  });

  it('says there is nothing to undo when nothing was recorded, and writes nothing', async () => {
    const world = hardenWorld();
    const before = [treeHash(world.home), treeHash(world.stroqHome)];

    const run = await world.runAsking(['undo'], ['y']);

    expect(run.code).toBe(0);
    expect(run.prompts).toEqual([]);
    expect(run.out).toContain('Nothing to undo: Stroq has no record of a change to');
    expect([treeHash(world.home), treeHash(world.stroqHome)]).toEqual(before);
  });

  it('says so the second time', async () => {
    const { world } = withOwnersFile();
    await world.runPiped(['apply', '--yes']);
    await world.runPiped(['undo', '--yes']);

    const run = await world.runPiped(['undo', '--yes']);

    expect(run.code).toBe(0);
    expect(run.out).toContain('Nothing to undo');
  });

  it('works on the project file at project scope and leaves the user file alone', async () => {
    const world = hardenWorld();
    await world.runPiped(['apply', '--yes', '--scope', 'project']);
    await world.runPiped(['apply', '--yes']);

    const run = await world.runPiped(['undo', '--yes', '--scope', 'project']);

    expect(run.code).toBe(0);
    expect(existsSync(world.inProject('.claude', 'settings.local.json'))).toBe(false);
    expect(existsSync(world.inHome(...SETTINGS))).toBe(true);
    expect(recordsFor(world.stroqHome, world.inHome(...SETTINGS))).toHaveLength(1);
  });

  it('takes the block out of .cursorignore and keeps the lines the owner wrote', async () => {
    const world = hardenWorld();
    const file = world.inProject('.cursorignore');
    writeFileSync(file, 'dist/\n');
    await world.runPiped(['apply', '--yes', '--agent', 'cursor']);
    writeFileSync(file, `${bytesOf(file)}coverage/\n`);

    const run = await world.runPiped(['undo', '--yes', '--agent', 'cursor']);

    expect(run.code).toBe(0);
    // The blank line Stroq put in front of its block goes with it; the owner's lines are as they were.
    expect(bytesOf(file)).toBe('dist/\ncoverage/\n');
  });

  it('leaves a block the owner edited, and says so', async () => {
    const world = hardenWorld();
    const file = world.inProject('.cursorignore');
    await world.runPiped(['apply', '--yes', '--agent', 'cursor']);
    writeFileSync(file, bytesOf(file).replace('.env.*', '.env.local'));

    const run = await world.runPiped(['undo', '--yes', '--agent', 'cursor']);

    expect(run.code).toBe(0);
    expect(bytesOf(file)).toContain('.env.local');
    expect(run.out).toContain('the block was edited since Stroq wrote it, so it was left as it is');
  });
});

describe('stroq harden undo: before it does anything', () => {
  it('shows what Stroq recorded, and that the file is exactly as it was left', async () => {
    const { world } = withOwnersFile();
    await world.runPiped(['apply', '--yes']);

    const run = await world.runAsking(['undo'], ['n']);

    expect(run.out).toContain('stroq harden: undo claude-read-deny (claude-code, user scope)');
    expect(run.out).toContain('Stroq recorded 1 change to it.');
    expect(run.out).toContain(
      `Added ${CLAUDE_READ_DENY_RULES.length - 1} rules to permissions.deny`,
    );
    expect(run.out).toContain('  - Read(./.env)');
    expect(run.out).toContain('1 rule was already there and is not touched: Read(~/.npmrc)');
    expect(run.out).toContain(
      'The file is exactly as Stroq left it, so undo puts back the copy taken before the change.',
    );
  });

  it('says that the file has changed since, so only what Stroq added is taken out', async () => {
    const { world, file } = withOwnersFile();
    await world.runPiped(['apply', '--yes']);
    ownerEdits(file, (doc) => ({ ...doc, theme: 'dark' }));

    const run = await world.runAsking(['undo'], ['n']);

    expect(run.out).toContain(
      'The file has changed since, so undo takes out only what Stroq added.',
    );
  });

  it('asks, and does nothing when the answer is no or the input ends', async () => {
    const { world, file } = withOwnersFile();
    await world.runPiped(['apply', '--yes']);
    const applied = bytesOf(file);

    const no = await world.runAsking(['undo'], ['n']);
    const eof = await world.runAsking(['undo'], [null]);

    expect(no.code).toBe(1);
    expect(no.prompts[0]).toContain('Undo this?');
    expect(no.err).toContain('not undone; nothing was changed');
    expect(eof.code).toBe(1);
    expect(bytesOf(file)).toBe(applied);
    expect(recordsFor(world.stroqHome, file)).toHaveLength(1);
  });

  it('undoes when the answer is yes', async () => {
    const { world, file } = withOwnersFile();
    await world.runPiped(['apply', '--yes']);

    const run = await world.runAsking(['undo'], ['y']);

    expect(run.code).toBe(0);
    expect(bytesOf(file)).toBe(OWNERS);
  });

  it('needs --yes where no person can answer, and changes nothing without it', async () => {
    const { world, file } = withOwnersFile();
    await world.runPiped(['apply', '--yes']);
    const applied = bytesOf(file);

    const run = await world.runPiped(['undo']);

    expect(run.code).toBe(1);
    expect(run.err).toContain('undo needs a person to answer on a terminal, or --yes');
    expect(bytesOf(file)).toBe(applied);
  });

  it('does not ask at a terminal when --yes is given', async () => {
    const { world, file } = withOwnersFile();
    await world.runPiped(['apply', '--yes']);
    const fake = askingTerminal(() => 'n');

    const run = await world.run(['undo', '--yes'], { terminal: fake.term });

    expect(run.code).toBe(0);
    expect(fake.prompts).toEqual([]);
    expect(bytesOf(file)).toBe(OWNERS);
  });
});

describe('stroq harden undo: what it will not do', () => {
  it('refuses a file the owner has since filled with comments, and keeps the record', async () => {
    const { world, file } = withOwnersFile();
    await world.runPiped(['apply', '--yes']);
    const commented = `// edited by hand\n${bytesOf(file)}`;
    writeFileSync(file, commented);

    const run = await world.runPiped(['undo', '--yes']);

    expect(run.code).toBe(1);
    expect(run.err).toContain('could not undo');
    expect(run.err).toContain('comments');
    expect(bytesOf(file)).toBe(commented);
    expect(recordsFor(world.stroqHome, file)).toHaveLength(1);
  });

  it.skipIf(onWindows)(
    'refuses a path that now leads to another file, in plain words',
    async () => {
      const { world, file } = withOwnersFile();
      await world.runPiped(['apply', '--yes']);
      const elsewhere = join(world.home, 'elsewhere.json');
      writeFileSync(elsewhere, '{}\n');
      rmSync(file);
      symlinkSync(elsewhere, file);

      const run = await world.runPiped(['undo', '--yes']);

      expect(run.code).toBe(1);
      expect(run.err).toContain('the path now leads to');
      expect(bytesOf(elsewhere)).toBe('{}\n');
      expect(run.err).not.toMatch(/\n\s+at /);
    },
  );

  it('refuses a manifest that is not what Stroq writes, without printing it', async () => {
    const { world, file } = withOwnersFile();
    await world.runPiped(['apply', '--yes']);
    const stranger = tempDir('stranger');
    writeFileSync(
      join(world.stroqHome, 'harden', 'manifest.json'),
      JSON.stringify({ version: 1, files: `PLANTED-TEXT ${stranger}` }),
    );

    const run = await world.runPiped(['undo', '--yes']);

    expect(run.code).toBe(1);
    expect(run.err).toContain('the manifest is not what Stroq writes');
    expect(run.err + run.out).not.toContain('PLANTED-TEXT');
    expect(bytesOf(file)).not.toBe(OWNERS);
  });
});
