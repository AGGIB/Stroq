import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { CLAUDE_READ_DENY_RULES } from '../../src/harden/recipes/credential-paths.js';
import { FAKE_SECRET } from '../harden/manifest-fixtures.js';
import { removeTempDirs } from '../harden/helpers.js';
import { GOLDEN_SETTINGS, bytesOf, recordsFor, settingsText } from '../helpers/harden-fixtures.js';
import { askingTerminal, hardenWorld, treeHash } from '../helpers/harden-world.js';

afterEach(removeTempDirs);

const onWindows = process.platform === 'win32';
const USER_SETTINGS = ['.claude', 'settings.json'] as const;

describe('stroq harden apply: asking a person', () => {
  it('makes the change when the person answers yes, and says how to take it back', async () => {
    const world = hardenWorld();
    const file = world.inHome(...USER_SETTINGS);

    const run = await world.runAsking(['apply'], ['y']);

    expect(run.code).toBe(0);
    expect(bytesOf(file)).toBe(GOLDEN_SETTINGS);
    expect(run.prompts).toHaveLength(1);
    expect(run.prompts[0]).toContain('Apply this change?');
    expect(run.prompts[0]).toContain('y/N');
    // The plan is shown first: the owner answers about what they have seen.
    expect(run.out).toContain('Adds these rules to permissions.deny:');
    expect(run.out).toContain(`+++ b${file}`);
    expect(run.out).toContain(`Applied to ${file}: 12 added.`);
    expect(run.out).toContain('The file did not exist; undo removes it.');
    expect(run.out).toContain(
      'To take it back: stroq harden undo --agent claude-code --scope user',
    );
    expect(run.err).toBe('');
  });

  it('says in the result what it does and does not do', async () => {
    const world = hardenWorld();

    const run = await world.runAsking(['apply'], ['yes']);

    expect(run.out).toContain(
      'Claude Code will now refuse its Read tool and the simple shell readers',
    );
    expect(run.out).toContain('best-effort filter, not a guarantee');
  });

  it('does nothing when the person answers no', async () => {
    const world = hardenWorld();
    const before = [treeHash(world.home), treeHash(world.stroqHome)];

    const run = await world.runAsking(['apply'], ['n']);

    expect(run.code).toBe(1);
    expect(run.err).toContain('not applied; nothing was written');
    expect([treeHash(world.home), treeHash(world.stroqHome)]).toEqual(before);
  });

  it('does nothing when the input ends before an answer', async () => {
    const world = hardenWorld();

    const run = await world.runAsking(['apply'], [null]);

    expect(run.code).toBe(1);
    expect(existsSync(world.inHome('.claude'))).toBe(false);
    expect(existsSync(world.stroqHome + '/harden')).toBe(false);
  });

  it('does nothing when the answer is not a yes, asked three times', async () => {
    const world = hardenWorld();

    const run = await world.runAsking(['apply'], ['maybe', 'perhaps', 'later']);

    expect(run.code).toBe(1);
    expect(run.prompts).toHaveLength(3);
    expect(existsSync(world.inHome('.claude'))).toBe(false);
  });

  it('does not ask when --yes is given, even at a terminal', async () => {
    const world = hardenWorld();
    const fake = askingTerminal(() => 'n');

    const run = await world.run(['apply', '--yes'], { terminal: fake.term });

    expect(run.code).toBe(0);
    expect(fake.prompts).toEqual([]);
    expect(bytesOf(world.inHome(...USER_SETTINGS))).toBe(GOLDEN_SETTINGS);
  });
});

describe('stroq harden apply: where no person can answer', () => {
  it('needs --yes, and writes nothing without it', async () => {
    const world = hardenWorld();
    const before = [treeHash(world.home), treeHash(world.stroqHome)];

    const run = await world.runPiped(['apply']);

    expect(run.code).toBe(1);
    expect(run.err).toContain('needs a person to answer on a terminal, or --yes');
    expect([treeHash(world.home), treeHash(world.stroqHome)]).toEqual(before);
  });

  it('makes the change with --yes', async () => {
    const world = hardenWorld();

    const run = await world.runPiped(['apply', '--yes']);

    expect(run.code).toBe(0);
    expect(bytesOf(world.inHome(...USER_SETTINGS))).toBe(GOLDEN_SETTINGS);
  });

  it('treats a terminal that is not interactive (CI, TERM=dumb) as no terminal', async () => {
    const world = hardenWorld();
    const fake = askingTerminal(() => 'y', { interactive: false });

    const run = await world.run(['apply'], { terminal: fake.term });

    expect(run.code).toBe(1);
    expect(fake.prompts).toEqual([]);
    expect(existsSync(world.inHome('.claude'))).toBe(false);
  });

  it('has no option that goes on without --yes: a lookalike option is a usage error', async () => {
    const world = hardenWorld();
    await expect(world.run(['apply', '--no-input'])).rejects.toThrow(/Unknown option/i);
    await expect(world.run(['apply', '--force'])).rejects.toThrow(/Unknown option/i);
    expect(existsSync(world.inHome('.claude'))).toBe(false);
  });
});

describe('stroq harden apply: what it records and what it keeps', () => {
  it('records the change in the Stroq home, and keeps a copy of a file that was there', async () => {
    const world = hardenWorld();
    const file = world.inHome(...USER_SETTINGS);
    mkdirSync(world.inHome('.claude'));
    const original = settingsText({ model: 'opus', permissions: { deny: ['Read(~/.npmrc)'] } });
    writeFileSync(file, original);

    const run = await world.runPiped(['apply', '--yes']);

    expect(run.code).toBe(0);
    const [entry, ...rest] = recordsFor(world.stroqHome, file);
    expect(rest).toEqual([]);
    expect(entry).toMatchObject({ recipe: 'claude-read-deny', created: false, real: file });
    expect(entry?.edits).toHaveLength(CLAUDE_READ_DENY_RULES.length);
    expect(entry?.edits.filter((e) => e.kind === 'json-array-add' && e.preexisting)).toHaveLength(
      1,
    );
    expect(entry?.backup).not.toBeNull();
    expect(run.out).toContain(
      'A byte copy of the file as it was is kept; undo puts it back exactly.',
    );
    expect(run.out).toContain('11 added, 1 already there and left as it is.');
    const doc = JSON.parse(bytesOf(file)) as { model: string };
    expect(doc.model).toBe('opus');
  });

  it('says so when no copy is kept because the file holds credential-shaped text', async () => {
    const world = hardenWorld();
    const file = world.inHome(...USER_SETTINGS);
    mkdirSync(world.inHome('.claude'));
    writeFileSync(file, settingsText({ env: { API_TOKEN: FAKE_SECRET } }));

    const run = await world.runPiped(['apply', '--yes']);

    expect(run.code).toBe(0);
    expect(run.out).toContain(
      'No copy of the file is kept, because it holds credential-shaped text',
    );
    expect(recordsFor(world.stroqHome, file)[0]?.backup).toBeNull();
    // The value is in neither stream, nor in the diff shown before the question.
    expect(run.out + run.err).not.toContain(FAKE_SECRET);
  });

  it('keeps the mode of the file it replaces, and makes a new settings file private', async () => {
    const world = hardenWorld();
    const file = world.inHome(...USER_SETTINGS);

    await world.runPiped(['apply', '--yes']);

    expect(statSync(file).mode & 0o777).toBe(onWindows ? statSync(file).mode & 0o777 : 0o600);
  });

  it('creates the folder of a file that is not there', async () => {
    const world = hardenWorld();

    const run = await world.runPiped(['apply', '--yes', '--scope', 'project']);

    expect(run.code).toBe(0);
    expect(bytesOf(world.inProject('.claude', 'settings.local.json'))).toBe(GOLDEN_SETTINGS);
  });

  it('is a no-op the second time: nothing written, nothing recorded, exit 0', async () => {
    const world = hardenWorld();
    const file = world.inHome(...USER_SETTINGS);
    await world.runPiped(['apply', '--yes']);
    const before = [treeHash(world.home), treeHash(world.stroqHome)];

    const run = await world.runAsking(['apply'], ['y']);

    expect(run.code).toBe(0);
    expect(run.prompts).toEqual([]);
    expect(run.out).toContain('Nothing to change: every rule is already in place.');
    expect([treeHash(world.home), treeHash(world.stroqHome)]).toEqual(before);
    expect(recordsFor(world.stroqHome, file)).toHaveLength(1);
  });

  it('writes a block into .cursorignore for Cursor and says that it could not be checked', async () => {
    const world = hardenWorld();
    writeFileSync(world.inProject('.cursorignore'), 'dist/\n');

    const run = await world.runPiped(['apply', '--yes', '--agent', 'cursor']);

    expect(run.code).toBe(0);
    expect(bytesOf(world.inProject('.cursorignore'))).toBe(
      'dist/\n\n# >>> stroq harden: cursor-ignore >>>\n.env\n.env.*\n# <<< stroq harden: cursor-ignore <<<\n',
    );
    expect(run.out).toContain(
      'Not verified: Stroq has not been able to test this against Cursor, so it cannot say that Cursor keeps these files out of what it sends to a model.',
    );
    expect(run.out).toContain('To take it back: stroq harden undo --agent cursor --scope project');
  });
});
