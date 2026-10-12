import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyTarget } from '../../src/commands/harden-apply.js';
import { contextOf } from '../../src/commands/harden-deps.js';
import { makePrinter } from '../../src/commands/harden-printer.js';
import { nodeFs } from '../../src/harden/atomic.js';
import { CLAUDE_READ_DENY_RULES } from '../../src/harden/recipes/credential-paths.js';
import type { RecipeTarget } from '../../src/harden/recipes/index.js';
import type { Fs } from '../../src/harden/types.js';
import { FAKE_SECRET } from '../harden/manifest-fixtures.js';
import { removeTempDirs } from '../harden/helpers.js';
import { GOLDEN_SETTINGS, bytesOf, recordsFor, settingsText } from '../helpers/harden-fixtures.js';
import { askingTerminal, captured, hardenWorld, treeHash } from '../helpers/harden-world.js';

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

describe('stroq harden apply: what it refuses', () => {
  it('refuses a file with comments without asking, and leaves it alone', async () => {
    const world = hardenWorld();
    mkdirSync(world.inHome('.claude'));
    writeFileSync(world.inHome(...USER_SETTINGS), '{\n  // mine\n}\n');
    const before = treeHash(world.home);

    const run = await world.runAsking(['apply'], ['y']);

    expect(run.code).toBe(1);
    expect(run.prompts).toEqual([]);
    expect(run.out).toContain('To make the change by hand');
    expect(treeHash(world.home)).toBe(before);
  });

  it.skipIf(onWindows)('refuses a read-only file in plain words, and leaves it alone', async () => {
    const world = hardenWorld();
    mkdirSync(world.inHome('.claude'));
    const file = world.inHome(...USER_SETTINGS);
    writeFileSync(file, '{}\n');
    chmodSync(file, 0o444);
    const before = treeHash(world.home);

    const run = await world.runPiped(['apply', '--yes']);

    expect(run.code).toBe(1);
    expect(run.err).toContain('it is read-only');
    expect(run.err).not.toMatch(/\n\s+at /);
    expect(treeHash(world.home)).toBe(before);
    // The record and the copy the engine made before it found out are taken back.
    expect(recordsFor(world.stroqHome, file)).toEqual([]);
    expect(readdirSync(join(world.stroqHome, 'backups'))).toEqual([]);
  });

  it('refuses when the file changed while the person was deciding, and keeps their change', async () => {
    const world = hardenWorld();
    const file = world.inHome(...USER_SETTINGS);
    mkdirSync(world.inHome('.claude'));
    writeFileSync(file, '{}\n');
    const fake = askingTerminal(() => {
      writeFileSync(file, '{"model": "changed while asking"}\n');
      return 'y';
    });

    const run = await world.run(['apply'], { terminal: fake.term });

    expect(run.code).toBe(1);
    expect(run.err).toContain('the file has changed since the plan was made');
    expect(bytesOf(file)).toBe('{"model": "changed while asking"}\n');
    expect(recordsFor(world.stroqHome, file)).toEqual([]);
  });

  it('takes the change back by itself if the file does not hold it afterwards', async () => {
    const intruder = '{"permissions":{"deny":["Bash(x)"]}}\n';
    // Something else rewrites the settings file the moment Stroq has put its version in place.
    const rewriting: Fs = {
      ...nodeFs,
      rename: async (from, to) => {
        await nodeFs.rename(from, to);
        if (to.endsWith('settings.json')) writeFileSync(to, intruder);
      },
    };
    const world = hardenWorld({ fs: rewriting });
    const file = world.inHome(...USER_SETTINGS);

    const run = await world.runPiped(['apply', '--yes']);

    expect(run.code).toBe(1);
    expect(run.err).toContain('does not hold the change');
    expect(run.err).toContain('took its record back');
    expect(bytesOf(file)).toBe(intruder);
    expect(recordsFor(world.stroqHome, file)).toEqual([]);
  });
});

describe('stroq harden apply: what has to be acknowledged', () => {
  function linkedSettings(world: ReturnType<typeof hardenWorld>): string {
    mkdirSync(world.inHome('dotfiles'));
    mkdirSync(world.inHome('.claude'));
    const real = world.inHome('dotfiles', 'claude.json');
    writeFileSync(real, settingsText({ model: 'opus' }));
    symlinkSync(real, world.inHome(...USER_SETTINGS));
    return real;
  }

  it.skipIf(onWindows)(
    'needs --acknowledge-link for a path that is a link, and exits 3 without it',
    async () => {
      const world = hardenWorld();
      const real = linkedSettings(world);
      const before = [treeHash(world.home), treeHash(world.stroqHome)];

      const run = await world.runPiped(['apply', '--yes']);

      expect(run.code).toBe(3);
      expect(run.err).toContain('--acknowledge-link');
      expect(run.err).toContain('the path is a link');
      expect([treeHash(world.home), treeHash(world.stroqHome)]).toEqual(before);
      expect(JSON.parse(bytesOf(real))).toEqual({ model: 'opus' });
    },
  );

  it.skipIf(onWindows)(
    'makes the change in the file the link leads to, with --acknowledge-link',
    async () => {
      const world = hardenWorld();
      const real = linkedSettings(world);

      const run = await world.runPiped(['apply', '--yes', '--acknowledge-link']);

      expect(run.code).toBe(0);
      expect(lstatSync(world.inHome(...USER_SETTINGS)).isSymbolicLink()).toBe(true);
      const doc = JSON.parse(bytesOf(real)) as { model: string; permissions: { deny: string[] } };
      expect(doc.model).toBe('opus');
      expect(doc.permissions.deny).toEqual([...CLAUDE_READ_DENY_RULES]);
      expect(recordsFor(world.stroqHome, real)).toHaveLength(1);
    },
  );

  it('needs --acknowledge-reformat for a file it would have to lay out again', async () => {
    const world = hardenWorld();
    mkdirSync(world.inHome('.claude'));
    const file = world.inHome(...USER_SETTINGS);
    writeFileSync(file, '{"model":"opus"}\n');

    const refused = await world.runPiped(['apply', '--yes']);
    expect(refused.code).toBe(3);
    expect(refused.err).toContain('--acknowledge-reformat');
    expect(bytesOf(file)).toBe('{"model":"opus"}\n');

    const run = await world.runPiped(['apply', '--yes', '--acknowledge-reformat']);
    expect(run.code).toBe(0);
    expect(bytesOf(file)).toContain('\n  "model": "opus",\n');
  });

  describe('replacing a value that looks like a credential', () => {
    const replaceToken = (file: string, root: string): RecipeTarget => ({
      recipe: 'test-replace',
      agent: 'claude-code',
      scope: 'project',
      summary: 'Replace the token.',
      file,
      root,
      items: ['env.API_TOKEN'],
      words: { adds: 'Sets:', alreadyDone: 'Nothing to change.', done: 'Done.' },
      change: {
        kind: 'json',
        edits: [{ kind: 'json-set', path: ['env', 'API_TOKEN'], value: 'new-value' }],
        snippet: '',
      },
      newFileMode: 0o600,
      limits: [],
      unverified: null,
    });

    function setup() {
      const world = hardenWorld();
      const file = world.inProject('settings.json');
      writeFileSync(file, settingsText({ env: { API_TOKEN: FAKE_SECRET } }));
      const ctx = contextOf(world.deps);
      const flags = (extra: object = {}) => ({
        json: false,
        yes: true,
        acknowledgeLink: false,
        acknowledgeCredentialLoss: false,
        acknowledgeReformat: false,
        ...extra,
      });
      const target = replaceToken(file, world.project);
      return {
        world,
        file,
        run: (extra?: object) =>
          captured(() => applyTarget(ctx, target, flags(extra), makePrinter(false, 'apply'))),
      };
    }

    it('needs --acknowledge-credential-loss, exits 3 without it, and never prints the value', async () => {
      const { file, run } = setup();

      const result = await run();

      expect(result.code).toBe(3);
      expect(result.err).toContain('--acknowledge-credential-loss');
      expect(result.err).toContain('cannot put it back');
      expect(result.out + result.err).not.toContain(FAKE_SECRET);
      expect(JSON.parse(bytesOf(file))).toEqual({ env: { API_TOKEN: FAKE_SECRET } });
    });

    it('goes ahead with it, and the value is in neither stream', async () => {
      const { file, run } = setup();

      const result = await run({ acknowledgeCredentialLoss: true });

      expect(result.code).toBe(0);
      expect(result.out + result.err).not.toContain(FAKE_SECRET);
      expect(JSON.parse(bytesOf(file))).toEqual({ env: { API_TOKEN: 'new-value' } });
    });
  });
});

describe('stroq harden apply --json', () => {
  it('needs --yes, because it asks nothing and prints one object', async () => {
    const world = hardenWorld();

    const run = await world.runAsking(['apply', '--json'], ['y']);

    expect(run.code).toBe(2);
    expect(run.err).toContain('--json does not ask');
    expect(run.out).toBe('');
    expect(existsSync(world.inHome('.claude'))).toBe(false);
  });

  it('prints the plan and what was done as one object', async () => {
    const world = hardenWorld();

    const run = await world.runPiped(['apply', '--json', '--yes']);

    expect(run.code).toBe(0);
    const result = JSON.parse(run.out) as Record<string, unknown> & {
      outcome: { status: string; backup: string; undo: string };
    };
    expect(result).toMatchObject({ command: 'harden', action: 'apply', changed: true });
    expect(result.outcome).toMatchObject({
      status: 'applied',
      backup: 'none-new-file',
      undo: 'stroq harden undo --agent claude-code --scope user',
    });
    expect(bytesOf(world.inHome(...USER_SETTINGS))).toBe(GOLDEN_SETTINGS);
  });

  it('prints the failure in the same shape', async () => {
    const world = hardenWorld();
    mkdirSync(world.inHome('.claude'));
    writeFileSync(world.inHome(...USER_SETTINGS), '{"a": 1,}\n');

    const run = await world.runPiped(['apply', '--json', '--yes']);

    expect(run.code).toBe(1);
    const result = JSON.parse(run.out) as {
      outcome: { status: string };
      refused: { reason: string };
    };
    expect(result.outcome.status).toBe('refused');
    expect(result.refused.reason).toBe('jsonc');
  });
});
