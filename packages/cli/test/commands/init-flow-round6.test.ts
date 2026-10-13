import { describe, expect, it } from 'vitest';
import { installedFile, noteBlocks, type FlowAgent } from '../../src/commands/init-flow.js';
import { withSafePaths } from '../../src/commands/init-interactive.js';
import { flow, installedOutput, squash } from '../helpers/flow-deps.js';

/**
 * What the sixth review found in the first-run screen: what OpenClaw's own CLI printed went through the
 * rules for Stroq's notes (glued to them, or taken for a line to copy), a failed command was not a
 * warning, the first line said the agent's hooks see pages that they do not, a command was broken over
 * two lines, and a flood of output was drawn whole.
 */

const OPENCLAW: FlowAgent = {
  id: 'openclaw',
  label: 'OpenClaw',
  found: true,
  where: '~/.stroq/openclaw-plugin',
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
const COPILOT: FlowAgent = {
  id: 'copilot',
  label: 'Copilot CLI',
  found: true,
  where: '.github/hooks/stroq.json',
};

const NOTE = 'OpenClaw loads plugins when the Gateway starts: restart it before this takes effect.';
const installer = (...parts: readonly string[]): string =>
  ['Stroq plugin installed in /h/.stroq/openclaw-plugin', ...parts, NOTE, ''].join('\n');

describe('noteBlocks, the commands an installer ran', () => {
  it('keeps a command and what it printed as one block, apart from the notes', () => {
    const blocks = noteBlocks(
      installer(
        '$ openclaw plugins install --link /h/.stroq/openclaw-plugin',
        '    Linked plugin stroq.',
        '    Restart the Gateway.',
        '$ openclaw plugins enable stroq',
        '    Enabled plugin stroq.',
      ),
    );

    expect(blocks).toEqual([
      {
        kind: 'run',
        text: 'openclaw plugins install --link /h/.stroq/openclaw-plugin',
        lines: ['Linked plugin stroq.', 'Restart the Gateway.'],
      },
      { kind: 'run', text: 'openclaw plugins enable stroq', lines: ['Enabled plugin stroq.'] },
      { kind: 'text', text: NOTE },
    ]);
  });

  it('does not glue a command that printed nothing to the note after it', () => {
    const blocks = noteBlocks(installer('$ openclaw plugins enable stroq'));

    expect(blocks).toEqual([
      { kind: 'run', text: 'openclaw plugins enable stroq', lines: [] },
      { kind: 'text', text: NOTE },
    ]);
  });

  it('keeps a warning of the installer for itself, after the output of the command it is about', () => {
    const blocks = noteBlocks(
      installer(
        '$ openclaw plugins install --link /d',
        '    Error: plugin stroq is already linked.',
        'Warning: "openclaw plugins install --link /d" did not succeed; run it yourself',
        '$ openclaw plugins enable stroq',
        '    Enabled plugin stroq.',
      ),
    );

    expect(blocks.map((block) => block.kind)).toEqual(['run', 'text', 'run', 'text']);
    expect(blocks[1]).toEqual({
      kind: 'text',
      text: 'Warning: "openclaw plugins install --link /d" did not succeed; run it yourself',
    });
  });

  it('does not take the words of a command for a line to copy, whatever they end in', () => {
    const blocks = noteBlocks(
      installer('$ openclaw plugins enable stroq', '    Warning: look here:', '    rm -rf /tmp/x'),
    );

    expect(blocks[0]).toEqual({
      kind: 'run',
      text: 'openclaw plugins enable stroq',
      lines: ['Warning: look here:', 'rm -rf /tmp/x'],
    });
    expect(blocks.some((block) => block.kind === 'command')).toBe(false);
  });
});

describe('the screen of an OpenClaw whose commands were run', () => {
  const run = async (out: string, extra: Partial<Parameters<typeof flow>[0]> = {}) => {
    const f = flow({
      terminal: { answers: ['y'], ...(extra.terminal ?? {}) },
      deps: {
        agents: [OPENCLAW],
        chosen: ['openclaw'],
        install: async () => ({ code: 0, out }),
        ...(extra.deps ?? {}),
      },
    });
    await f.run();
    return f.fake.out();
  };

  it('shows each command, and what it printed under it, and not as a note', async () => {
    const out = await run(
      installer('$ openclaw plugins enable stroq', '    Enabled plugin stroq.'),
    );

    const lines = out.split('\n');
    expect(lines).toContain('      $ openclaw plugins enable stroq');
    expect(lines).toContain('        Enabled plugin stroq.');
    expect(squash(out)).not.toContain('stroq Enabled plugin stroq OpenClaw loads');
  });

  it('is a warning where a command did not succeed, and says what to do', async () => {
    const out = await run(
      installer(
        '$ openclaw plugins install --link /d',
        '    Error: boom',
        'Warning: "openclaw plugins install --link /d" did not succeed; run it yourself',
      ),
    );

    expect(squash(out)).toContain(
      'Done, but read the warning above. Stroq is not guarding OpenClaw yet',
    );
  });

  it('is a warning where a command was stopped, after the time it was given', async () => {
    const out = await run(
      installer(
        '$ openclaw plugins enable stroq',
        '    (stopped after 120 s)',
        'Warning: "openclaw plugins enable stroq" did not succeed; run it yourself',
      ),
    );

    expect(out).toContain('(stopped after 120 s)');
    expect(squash(out)).toContain('read the warning above');
  });

  it('draws no more than eight lines of what a command printed, and says how many it left out', async () => {
    const many = Array.from({ length: 3_000 }, (_, i) => `    line ${i}`);

    const out = await run(installer('$ openclaw plugins enable stroq', ...many));

    expect(out).toContain('line 7');
    expect(out).not.toContain('line 8\n');
    expect(out).toContain('(… 2992 more lines)');
    expect(out.split('\n').length).toBeLessThan(120);
  });

  it('cuts a line of it that is longer than the screen, and keeps it one line', async () => {
    const out = await run(installer('$ openclaw plugins enable stroq', `    ${'x'.repeat(500)}`), {
      terminal: { columns: 60 },
    });

    const printed = out.split('\n').filter((line) => line.includes('xxxxx'));
    expect(printed).toHaveLength(1);
    expect((printed[0] as string).length).toBeLessThan(70);
    expect(printed[0]).toContain('…');
  });

  it('draws no more than fourteen notes, and says where the rest is', async () => {
    const notes = Array.from({ length: 200 }, (_, i) => `Note number ${i}.`);

    const out = await run(['Stroq plugin installed in /h/p', ...notes, ''].join('\n'));

    expect(out).toContain('Note number 13.');
    expect(out).not.toContain('Note number 14.');
    expect(squash(out)).toContain(
      'stroq init --agent openclaw --no-input` shows everything it said',
    );
  });
});

describe('a long note', () => {
  it('is read for what it says in time that does not grow with its length', async () => {
    const note = `${'restart '.repeat(300_000)}if`;
    const f = flow({
      terminal: { answers: ['y'] },
      deps: {
        agents: [CLAUDE],
        chosen: ['claude-code'],
        install: async () => ({ code: 0, out: installedOutput('/p/.claude/settings.json', note) }),
      },
    });
    const started = performance.now();

    await f.run();

    expect(performance.now() - started).toBeLessThan(2_000);
    // What is past the part that is read is cut: the paragraph is not drawn whole.
    expect(f.fake.out().length).toBeLessThan(20_000);
  });
});

describe('the first line of the screen', () => {
  it('claims what every agent gives hooks for, and not pages that some do not', async () => {
    const f = flow({ terminal: { answers: ['y'] } });

    await f.run();

    const shown = squash(f.fake.out());
    expect(shown).toContain(
      'Stroq judges what your agent is about to do (the commands it runs, the files it reads or edits, and the fetches and tool calls its hooks can see), on this machine, before it happens.',
    );
    expect(shown).not.toContain('each page it fetches');
  });
});

describe('a file that Stroq replaced, which it did not write', () => {
  it('is a warning, said where it is read', async () => {
    const f = flow({
      terminal: { answers: ['y'] },
      deps: {
        agents: [COPILOT],
        chosen: ['copilot'],
        install: async () => ({
          code: 0,
          out: installedOutput(
            '/p/.github/hooks/stroq.json',
            'replacing /p/.github/hooks/stroq.json, which Stroq did not write',
          ),
        }),
      },
    });

    await f.run();

    expect(squash(f.fake.out())).toContain('Done, but read the warning above.');
  });
});

describe('a command, wrapped to the width of the screen', () => {
  it('stands whole in the line of the undo, which a break would make two commands of', async () => {
    const f = flow({
      terminal: { answers: ['y'], columns: 60 },
      deps: {
        agents: [CLAUDE, CURSOR, OPENCLAW],
        chosen: ['claude-code', 'cursor', 'openclaw'],
      },
    });

    await f.run();

    const lines = f.fake.out().split('\n');
    expect(lines.some((line) => line.includes('openclaw plugins disable stroq'))).toBe(true);
    expect(lines.some((line) => line.endsWith('openclaw plugins'))).toBe(false);
    expect(lines.some((line) => line.endsWith('stroq uninstall --agent'))).toBe(false);
  });

  it('is put under the label, one to a line, where the room beside it is too little', async () => {
    const f = flow({
      terminal: { answers: ['y'], columns: 40 },
      deps: {
        agents: [CLAUDE, CURSOR, OPENCLAW],
        chosen: ['claude-code', 'cursor', 'openclaw'],
      },
    });

    await f.run();

    const lines = f.fake.out().split('\n');
    expect(lines).toContain('      stroq uninstall --agent cursor');
    expect(lines).toContain('      openclaw plugins disable stroq');
    expect(lines.some((line) => /^ {4}undo\s+\(the hooks only/.test(line))).toBe(true);
  });

  it('keeps a command in backticks whole inside a note', async () => {
    const f = flow({
      terminal: { answers: ['y'], columns: 40 },
      deps: {
        agents: [CLAUDE],
        chosen: ['claude-code'],
        install: async () => ({
          code: 0,
          out: installedOutput(
            '/p/.claude/settings.json',
            'Install it with `npm install -g @stroq/cli` and run `stroq init` again, please.',
          ),
        }),
      },
    });

    await f.run();

    const lines = f.fake.out().split('\n');
    expect(lines.some((line) => line.includes('`npm install -g @stroq/cli`'))).toBe(true);
    expect(lines.some((line) => line.includes('`stroq init`'))).toBe(true);
  });
});

describe('a path with a line break of any kind in it', () => {
  it.each([
    ['carriage return', '\r'],
    ['line separator', ' '],
    ['paragraph separator', ' '],
    ['tab', '\t'],
    ['line break', '\n'],
  ])('is written as the characters it is, with a %s', (_name, ch) => {
    const folder = `/work/p-x${ch}Done. all fine`;

    const safe = withSafePaths(`Stroq hooks installed in ${folder}/.devin/hooks.json\n`, [folder]);

    expect(safe.trimEnd()).not.toContain(ch);
    expect(installedFile(safe)).toBe(
      `/work/p-x${{ '\r': '\\r', ' ': '\\u2028', ' ': '\\u2029', '\t': '\\t', '\n': '\\n' }[ch]}Done. all fine/.devin/hooks.json`,
    );
  });

  it('is read to its end by the line that says where the hooks were written, whatever is in it', () => {
    expect(installedFile('Stroq hooks installed in /a\rb/c.json\n')).toBe('/a\rb/c.json');
    expect(installedFile('Stroq hooks installed in /a b\n')).toBe('/a b');
  });

  it('is made safe longest first, so that a path that holds another is not cut by it', () => {
    const inner = '/h/a\nb';
    const outer = `${inner}/c\nd`;

    const safe = withSafePaths(`${outer} ${inner}`, [inner, outer]);

    expect(safe).toBe('/h/a\\nb/c\\nd /h/a\\nb');
  });
});
