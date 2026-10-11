import { symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readTargetText } from '../../src/harden/atomic.js';
import { applyPlan } from '../../src/harden/index.js';
import { planJsonEdits, replayJsonPlan } from '../../src/harden/json-edit.js';
import { linkTarget } from '../../src/harden/plan-support.js';
import { replayTextBlockPlan } from '../../src/harden/textblock.js';
import { HardenError } from '../../src/harden/types.js';
import { addDeny, engine, jsonText } from './engine-setup.js';
import { removeTempDirs, tempDir } from './helpers.js';

afterEach(removeTempDirs);

/**
 * Which paths are "a link" to the owner. A link BELOW the root is something a repository can have
 * chosen, and the owner is told. A link above it is how the machine is laid out (a home directory
 * that is a link, `/tmp` on a Mac), and saying so on every run would only teach people to skip
 * the notice. The repository chooses the names of its links, so the words that name them are made
 * safe to print.
 */
const onWindows = process.platform === 'win32';
const linkLines = (notices: readonly string[]): string[] =>
  notices.filter((text) => text.startsWith('this path is a link:'));

describe.skipIf(onWindows)('a link above the root', () => {
  /** A project reached through a link, as a linked home or /tmp makes every project. */
  function reachedThroughALink() {
    const e = engine();
    const alias = join(tempDir('alias'), 'proj');
    symlinkSync(e.project, alias);
    writeFileSync(e.file('settings.json'), jsonText({ model: 'm' }));
    const file = join(alias, 'settings.json');
    const plan = planJsonEdits(file, [addDeny('a')], { read: readTargetText, root: alias });
    return { e, plan };
  }

  it('is not a link to the owner: no notice, and the diff is labelled with the real file', () => {
    const { e, plan } = reachedThroughALink();

    expect(plan.real).toBe(e.file('settings.json'));
    expect(linkLines(plan.notices)).toEqual([]);
    expect(plan.diff.split('\n')[0]).toBe(`--- a/${e.file('settings.json').replace(/^\/+/, '')}`);
  });

  it('is applied without anybody having to say the owner was told', async () => {
    const { e, plan } = reachedThroughALink();

    await expect(applyPlan(plan, e.env)).resolves.toMatchObject({ changed: true });
  });

  it('still counts a link below that root', async () => {
    const e = engine();
    const alias = join(tempDir('alias'), 'proj');
    symlinkSync(e.project, alias);
    writeFileSync(e.file('package.json'), jsonText({}));
    symlinkSync(e.file('package.json'), e.file('settings.json'));
    const file = join(alias, 'settings.json');

    const plan = planJsonEdits(file, [addDeny('a')], { read: readTargetText, root: alias });

    expect(linkLines(plan.notices)).toHaveLength(1);
    await expect(applyPlan(plan, e.env)).rejects.toMatchObject({ code: 'link-not-acknowledged' });
  });
});

describe.skipIf(onWindows)('linkTarget', () => {
  it('is null for a path that no link carries anywhere', () => {
    const e = engine();
    writeFileSync(e.file('settings.json'), '{}\n');

    expect(linkTarget(e.file('settings.json'), e.file('settings.json'), e.project)).toBeNull();
  });

  it('names the file a link leads to', () => {
    const e = engine();
    writeFileSync(e.file('package.json'), '{}\n');
    symlinkSync(e.file('package.json'), e.file('settings.json'));

    expect(linkTarget(e.file('settings.json'), e.file('package.json'), e.project)).toBe(
      e.file('package.json'),
    );
  });

  it('counts every link in the path when no root is named', () => {
    const e = engine();
    writeFileSync(e.file('package.json'), jsonText({}));
    symlinkSync(e.file('package.json'), e.file('settings.json'));

    const plan = planJsonEdits(e.file('settings.json'), [addDeny('a')], { read: readTargetText });

    expect(linkLines(plan.notices)).toHaveLength(1);
    expect(plan.real).toBe(e.file('package.json'));
  });

  it('does not take a file for its own root: a link named as the root is still a link', () => {
    const e = engine();
    writeFileSync(e.file('package.json'), '{}\n');
    symlinkSync(e.file('package.json'), e.file('settings.json'));

    expect(
      linkTarget(e.file('settings.json'), e.file('package.json'), e.file('settings.json')),
    ).toBe(e.file('package.json'));
  });
});

describe.skipIf(onWindows)('the words about a link, when a repository named it', () => {
  const NAME = 'a\u001b]52;c;Zm9v\u0007b.json';
  const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

  function namedLink() {
    const e = engine();
    writeFileSync(e.file('package.json'), jsonText({}));
    symlinkSync(e.file('package.json'), e.file(NAME));
    return { e, plan: e.planJson(NAME, [addDeny('a')]) };
  }

  it('shows a control character in the name as a visible escape in the notice', () => {
    const { plan } = namedLink();

    const [notice] = linkLines(plan.notices);

    expect(notice).toBeDefined();
    expect(notice).not.toMatch(CONTROL);
    expect(notice).toContain('\\u001b]52;c;Zm9v\\u0007b.json');
  });

  it('does the same in the refusal to apply', async () => {
    const { e, plan } = namedLink();

    const error = await applyPlan(plan, e.env).catch((err: unknown) => err);

    expect(error).toMatchObject({ code: 'link-not-acknowledged' });
    expect((error as Error).message).not.toMatch(CONTROL);
    expect((error as Error).message).toContain('\\u001b]52;c;Zm9v\\u0007b.json');
  });

  it('does the same in the refusal of a link that leaves the root', () => {
    const e = engine();
    const outside = tempDir('outside');
    writeFileSync(join(outside, 'target.json'), '{}\n');
    symlinkSync(join(outside, 'target.json'), e.file(NAME));

    const plan = e.planJson(NAME, [addDeny('a')]);

    expect(plan.refused).toBe('path-escapes-root');
    expect(plan.refusedDetail).not.toMatch(CONTROL);
    expect(plan.refusedDetail).toContain('\\u001b');
  });
});

/**
 * A replay is the planner run again on a plan's own text, to see whether the plan is what a planner
 * makes. It touches nothing, and says nothing to the owner: what a link is depends on the file
 * system, which the planner looked at and the replay does not.
 */
describe.skipIf(onWindows)('the replay of a plan', () => {
  it('does not look at the file system for a link, in a plan of a JSON file', () => {
    const e = engine();
    writeFileSync(e.file('package.json'), jsonText({}));
    symlinkSync(e.file('package.json'), e.file('settings.json'));
    const plan = e.planJson('settings.json', [addDeny('a')]);
    expect(linkLines(plan.notices)).toHaveLength(1);

    expect(linkLines(replayJsonPlan(plan).notices)).toEqual([]);
  });

  it('does not look at the file system for a link, in a plan of a block of lines', () => {
    const e = engine();
    writeFileSync(e.file('.env'), 'PORT=3000\n');
    symlinkSync(e.file('.env'), e.file('.cursorignore'));
    const plan = e.planBlock('.cursorignore');
    expect(linkLines(plan.notices)).toHaveLength(1);

    expect(linkLines(replayTextBlockPlan(plan)?.notices ?? ['not replayed'])).toEqual([]);
  });

  it('still makes the same text, diff and edits as the planner did', () => {
    const e = engine();
    writeFileSync(e.file('package.json'), jsonText({ name: 'x' }));
    symlinkSync(e.file('package.json'), e.file('settings.json'));
    const plan = e.planJson('settings.json', [addDeny('a')]);

    const replay = replayJsonPlan(plan);

    expect(replay.after).toBe(plan.after);
    expect(replay.diff).toBe(plan.diff);
    expect(replay.edits).toEqual(plan.edits);
  });
});

describe.skipIf(onWindows)('a plan that was refused for its path', () => {
  it('has said where the path leads in its refusal, and has no notice about a link besides', () => {
    const e = engine();
    const outside = tempDir('outside');
    writeFileSync(join(outside, 'target.json'), '{}\n');
    symlinkSync(join(outside, 'target.json'), e.file('settings.json'));

    const plan = e.planJson('settings.json', [addDeny('a')]);

    expect(plan.refused).toBe('path-escapes-root');
    expect(plan.notices).toEqual([]);
  });
});

describe('a HardenError', () => {
  it('makes a control character in its message visible, whoever put it there', () => {
    const error = new HardenError('invalid-edit', 'bad \u001b[2J name\u0007');

    expect(error.message).toBe('bad \\u001b[2J name\\u0007');
  });

  it('leaves a message that has none exactly as it is', () => {
    const error = new HardenError('invalid-edit', 'an edit needs a path (tab:\t) — é');

    expect(error.message).toBe('an edit needs a path (tab:\t) — é');
  });
});
