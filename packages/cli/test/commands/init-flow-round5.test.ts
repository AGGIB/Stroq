import { describe, expect, it } from 'vitest';
import { noteBlocks, type FlowAgent } from '../../src/commands/init-flow.js';
import { flow, installedOutput, squash } from '../helpers/flow-deps.js';

/**
 * What the fifth review found in the first-run screen, each as it was reported: an instruction of the
 * installer that the screen did not show, a "Done. Stroq is guarding" that the notes above it said was
 * not so, an undo that did not undo, and a copy that was not made and was not said.
 */

const OPENCLAW: FlowAgent = {
  id: 'openclaw',
  label: 'OpenClaw',
  found: true,
  where: '~/.stroq/openclaw-plugin',
  extra: 'runs `openclaw plugins install --link` and `openclaw plugins enable stroq`',
  userWide: true,
  undo: 'openclaw plugins disable stroq',
};
const CLAUDE: FlowAgent = {
  id: 'claude-code',
  label: 'Claude Code',
  found: true,
  where: '.claude/settings.json',
};
const CURSOR: FlowAgent = {
  id: 'cursor',
  label: 'Cursor',
  found: true,
  where: '~/.cursor/hooks.json',
};
const CODEX: FlowAgent = {
  id: 'codex',
  label: 'Codex CLI',
  found: true,
  where: '.codex/hooks.json',
};

const NOT_ON_PATH =
  'Stroq plugin installed in /h/.stroq/openclaw-plugin\n' +
  'OpenClaw is not on PATH; run these two commands where it is:\n' +
  '  openclaw plugins install --link /h/.stroq/openclaw-plugin\n' +
  '  openclaw plugins enable stroq\n' +
  'OpenClaw loads plugins when the Gateway starts: restart it before this takes effect.\n' +
  'Run "stroq doctor" to verify.\n' +
  'To remove them: stroq uninstall --agent openclaw\n';

const CODEX_NOTE =
  'Stroq hooks installed in /p/.codex/hooks.json\n' +
  '  PreToolUse  → Bash\n' +
  "Codex runs a new or changed hook only after you approve it: start codex and approve Stroq's hooks\n" +
  'when it lists them for review. Until then Stroq does nothing in Codex, and "stroq doctor" says NOT APPROVED;\n' +
  'upgrading Stroq changes the hook, and Codex asks again.\n' +
  'Run "stroq doctor" to verify.\n';

describe('noteBlocks', () => {
  it('is one paragraph for a note that an installer broke over lines', () => {
    const blocks = noteBlocks(CODEX_NOTE);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.kind).toBe('text');
    expect(blocks[0]?.text).toBe(
      'Codex runs a new or changed hook only after you approve it: start codex and approve Stroq\'s hooks when it lists them for review. Until then Stroq does nothing in Codex, and "stroq doctor" says NOT APPROVED; upgrading Stroq changes the hook, and Codex asks again.',
    );
  });

  it('keeps a sentence of its own for each line that ends one', () => {
    const blocks = noteBlocks('First sentence.\nSecond one.\nThird?\n');

    expect(blocks.map((block) => block.text)).toEqual(['First sentence.', 'Second one.', 'Third?']);
  });

  it('keeps the lines to type that follow a note ending in a colon, as the lines they are', () => {
    const blocks = noteBlocks(NOT_ON_PATH);

    expect(blocks).toEqual([
      { kind: 'text', text: 'OpenClaw is not on PATH; run these two commands where it is:' },
      { kind: 'command', text: 'openclaw plugins install --link /h/.stroq/openclaw-plugin' },
      { kind: 'command', text: 'openclaw plugins enable stroq' },
      {
        kind: 'text',
        text: 'OpenClaw loads plugins when the Gateway starts: restart it before this takes effect.',
      },
    ]);
  });

  it('drops the indented lines that are the config the installer wrote', () => {
    const blocks = noteBlocks(installedOutput('/p/.claude/settings.json', 'A note.'));

    expect(blocks).toEqual([{ kind: 'text', text: 'A note.' }]);
  });

  it('is nothing for no notes, and for blank lines', () => {
    expect(noteBlocks('')).toEqual([]);
    expect(noteBlocks('\n   \n\t\n')).toEqual([]);
  });

  it('ends a paragraph that is left open at the end of the output', () => {
    expect(noteBlocks('A note with no full stop')).toEqual([
      { kind: 'text', text: 'A note with no full stop' },
    ]);
  });
});

describe('an OpenClaw that was not there to be told', () => {
  const notOnPath = (): ReturnType<typeof flow> =>
    flow({
      terminal: { answers: ['y'] },
      deps: {
        agents: [OPENCLAW],
        chosen: ['openclaw'],
        install: async () => ({ code: 0, out: NOT_ON_PATH }),
      },
    });

  it('shows the two commands, each on one line that is not cut', async () => {
    const f = notOnPath();

    await f.run();

    const lines = f.fake.out().split('\n');
    expect(lines).toContain('        openclaw plugins install --link /h/.stroq/openclaw-plugin');
    expect(lines).toContain('        openclaw plugins enable stroq');
  });

  it('does not say that Stroq is guarding it, and says what to do first', async () => {
    const f = notOnPath();

    await f.run();

    const shown = squash(f.fake.out());
    expect(shown).toContain(
      'Done, but read the warning above. Stroq is not guarding OpenClaw yet: do what its note above says first.',
    );
    expect(shown).not.toContain('Stroq is guarding OpenClaw');
  });

  it('is installed for the whole user, and is taken out by the command of the Gateway', async () => {
    const f = notOnPath();

    await f.run();

    const shown = squash(f.fake.out());
    expect(shown).toContain("adds Stroq's hooks to ~/.stroq/openclaw-plugin (for the whole user)");
    expect(f.fake.prompts.join('')).toContain('Guard OpenClaw for the whole user?');
    expect(shown).toContain('undo openclaw plugins disable stroq');
    expect(shown).toContain('openclaw plugins disable stroq switch the plugin off again');
    expect(shown).not.toContain('stroq uninstall --agent openclaw');
  });

  it('names the Gateway command beside `stroq uninstall` where agents are installed together', async () => {
    const f = flow({
      terminal: { answers: ['y'] },
      deps: {
        agents: [CLAUDE, OPENCLAW],
        chosen: ['claude-code', 'openclaw'],
        install: async (id) => ({
          code: 0,
          out: id === 'openclaw' ? NOT_ON_PATH : installedOutput('/p/.claude/settings.json'),
        }),
      },
    });

    await f.run();

    const shown = squash(f.fake.out());
    expect(shown).toContain('undo stroq uninstall, openclaw plugins disable stroq');
    expect(shown).toContain('stroq uninstall --agent <name> take the hooks of one agent out again');
    expect(shown).toContain('openclaw plugins disable stroq switch OpenClaw off again');
    expect(shown).toContain(
      'Done, but read the warning above. Stroq is guarding Claude Code; OpenClaw not yet: do what its note above says first.',
    );
  });

  it('names the Gateway command where something failed', async () => {
    const f = flow({
      terminal: { answers: ['y'] },
      deps: {
        agents: [CLAUDE, OPENCLAW],
        chosen: ['claude-code', 'openclaw'],
        install: async (id) =>
          id === 'openclaw'
            ? { code: 1, out: 'boom\n' }
            : { code: 0, out: installedOutput('/p/.claude/settings.json') },
      },
    });

    expect(await f.run()).toBe(1);

    expect(squash(f.fake.out())).toContain(
      '`stroq uninstall --agent <name>` (OpenClaw: `openclaw plugins disable stroq`) takes the hooks out again.',
    );
  });
});

describe('the headline, where the notes above it say Stroq does not guard yet', () => {
  it('is a warning where the installer said Stroq does nothing until a person acts (Codex)', async () => {
    const f = flow({
      terminal: { answers: ['y'] },
      deps: {
        agents: [CODEX],
        chosen: ['codex'],
        install: async () => ({ code: 0, out: CODEX_NOTE }),
      },
    });

    await f.run();

    expect(squash(f.fake.out())).toContain(
      'Done, but read the warning above. Stroq is not guarding Codex CLI yet: do what its note above says first.',
    );
  });

  it('is a warning for a note that begins with Warning:', async () => {
    const f = flow({
      terminal: { answers: ['y'] },
      deps: {
        agents: [CLAUDE],
        chosen: ['claude-code'],
        install: async () => ({
          code: 0,
          out: installedOutput(
            '/p/.claude/settings.json',
            'Warning: cannot parse /p/.devin/hooks.json; whether the hooks run is unknown.',
          ),
        }),
      },
    });

    await f.run();

    expect(squash(f.fake.out())).toContain('Done, but read the warning above. Stroq is guarding');
  });

  it('is not a warning for a note that says to restart, and says which agent waits for it', async () => {
    const f = flow({
      terminal: { answers: ['y'] },
      deps: {
        agents: [CLAUDE, CURSOR],
        chosen: ['claude-code', 'cursor'],
        install: async (id) => ({
          code: 0,
          out:
            id === 'cursor'
              ? installedOutput(
                  '/h/.cursor/hooks.json',
                  'Restart Cursor, then run "stroq doctor" to verify.',
                )
              : installedOutput('/p/.claude/settings.json'),
        }),
      },
    });

    await f.run();

    const shown = squash(f.fake.out());
    expect(shown).toContain(
      'Done. Stroq is guarding Claude Code; Cursor not yet: do what its note above says first.',
    );
    expect(shown).not.toContain('read the warning above');
  });

  it('says which agents wait, where more than one does', async () => {
    const f = flow({
      terminal: { answers: ['y'] },
      deps: {
        agents: [CURSOR, CODEX],
        chosen: ['cursor', 'codex'],
        install: async (id) => ({
          code: 0,
          out:
            id === 'cursor'
              ? installedOutput('/h/.cursor/hooks.json', 'Restart Cursor.')
              : CODEX_NOTE,
        }),
      },
    });

    await f.run();

    expect(squash(f.fake.out())).toContain(
      'Done, but read the warning above. Stroq is not guarding Cursor and Codex CLI yet: do what their notes above say first.',
    );
  });

  it('is not changed by a restart that is only to be done if the hooks do not fire', async () => {
    const f = flow({
      terminal: { answers: ['y'] },
      deps: {
        agents: [CLAUDE],
        chosen: ['claude-code'],
        install: async () => ({
          code: 0,
          out: installedOutput(
            '/p/.claude/settings.json',
            'Restart Windsurf (or reload the window) if the hooks do not fire: the docs do not say when it is read.',
          ),
        }),
      },
    });

    await f.run();

    expect(squash(f.fake.out())).toContain('Done. Stroq is guarding Claude Code');
  });

  it('names three agents with commas, as a person would', async () => {
    const quiet = flow({
      terminal: { answers: ['y'] },
      deps: { agents: [CLAUDE, CURSOR, CODEX], chosen: ['claude-code', 'cursor', 'codex'] },
    });

    await quiet.run();

    expect(squash(quiet.fake.out())).toContain(
      'Done. Stroq is guarding Claude Code, Cursor and Codex CLI.',
    );

    const waiting = flow({
      terminal: { answers: ['y'] },
      deps: {
        agents: [CLAUDE, CURSOR, CODEX],
        chosen: ['claude-code', 'cursor', 'codex'],
        install: async (id) => ({
          code: 0,
          out: id === 'claude-code' ? installedOutput('/p/.claude/settings.json') : CODEX_NOTE,
        }),
      },
    });

    await waiting.run();

    expect(squash(waiting.fake.out())).toContain(
      'Stroq is guarding Claude Code; Cursor and Codex CLI not yet: do what their notes above say first.',
    );
  });

  it('is what it always was where there is nothing to do', async () => {
    const f = flow({ terminal: { answers: ['y'] } });

    await f.run();

    expect(squash(f.fake.out())).toContain('Done. Stroq is guarding Claude Code and Cursor.');
  });
});

describe('the notes of an installer, as the screen shows them', () => {
  it('is a paragraph of the width of the screen, and not a ragged run of short lines', async () => {
    const f = flow({
      terminal: { answers: ['y'], columns: 80 },
      deps: {
        agents: [CODEX],
        chosen: ['codex'],
        install: async () => ({ code: 0, out: CODEX_NOTE }),
      },
    });

    await f.run();

    const note = f.fake
      .out()
      .split('\n')
      .filter((line) => line.startsWith('      ') && !line.startsWith('        '));
    // Every line but the last of the paragraph is nearly the width of the screen.
    for (const line of note.slice(0, -1)) expect(line.length).toBeGreaterThan(60);
    expect(note.length).toBeGreaterThanOrEqual(3);
  });
});
