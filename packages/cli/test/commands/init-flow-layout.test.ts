import { describe, expect, it } from 'vitest';
import type { SelfCheck } from '../../src/commands/init-selfcheck.js';
import { visibleLength } from '../../src/ui/style.js';
import { fakeTimers, type FakeTerminalOptions } from '../helpers/fake-terminal.js';
import { PASSING, flow, installedOutput, type FlowOptions } from '../helpers/flow-deps.js';

const ESC = '\u001b';
const WIDTHS = [40, 60, 80, 100] as const;
const CURSOR_NOTE = 'Restart Cursor, then run "stroq doctor" to verify.';
const NON_ASCII = /[^\x00-\x7f]/;

const WRONG: SelfCheck = {
  ok: false,
  allowed: { verdict: 'ask', detail: 'said ask', ms: 3 },
  denied: PASSING.denied,
};

const { timers } = fakeTimers();
const install = async (id: string) => ({
  code: 0,
  out: installedOutput(`/home/someone/proj/.${id}/hooks.json`, CURSOR_NOTE),
});

/** A successful install, answered at the question. */
const asked = (terminal: FakeTerminalOptions): FlowOptions => ({
  terminal: { ...terminal, answers: ['y'] },
  deps: { timers, install },
});

/** A successful install that was not asked about. */
const forced = (terminal: FakeTerminalOptions): FlowOptions => ({
  terminal,
  deps: { yes: true, timers, install },
});

type Scenario = readonly [name: string, options: FlowOptions];

/** The other screens the flow can end on. */
const others = (terminal: FakeTerminalOptions): readonly Scenario[] => [
  ['a declined install', { terminal: { ...terminal, answers: ['n'] }, deps: { timers } }],
  ['no agent chosen', { terminal, deps: { yes: true, timers, chosen: [] } }],
  [
    'an installer that fails',
    { terminal, deps: { yes: true, timers, install: async () => ({ code: 1, out: 'boom\n' }) } },
  ],
  [
    'a self-check that says no',
    { terminal, deps: { yes: true, timers, install, check: async () => WRONG } },
  ],
  [
    'a self-check that cannot run',
    { terminal, deps: { yes: true, timers, install, check: async () => null } },
  ],
];

const everything = (terminal: FakeTerminalOptions): readonly Scenario[] => [
  ['a successful install, asked', asked(terminal)],
  ['a successful install, with --yes', forced(terminal)],
  ...others(terminal),
];

/** Everything a flow printed, and every prompt it asked, one entry for each line. */
async function printedBy(options: FlowOptions): Promise<string[]> {
  const f = flow(options);
  await f.run();
  return [...f.fake.out().split('\n'), ...f.fake.prompts];
}

const overlong = (lines: readonly string[], columns: number): string[] =>
  [...new Set(lines)]
    .filter((line) => visibleLength(line) > columns)
    .map((line) => `${visibleLength(line)} columns, over ${columns}: ${line.trim()}`);

// The lines that are written with `say` or handed to a step are not wrapped, and some are longer
// than the terminals they are for: the line of a passing self-check is 88 columns, and the Done line
// of an agent that cannot be checked is 112. At 40 columns the tagline, the question and the
// spinner's frame ("Checking that Claude Code reaches Stroq") are over as well.
describe('runInitFlow, the width of what it prints', () => {
  describe.each(WIDTHS)('at %i columns', (columns) => {
    it.each([false, true])(
      'keeps every line of a successful install within the width, with colour %s',
      async (color) => {
        const terminal = { columns, color, color256: color } as const;

        const lines = [
          ...(await printedBy(asked(terminal))),
          ...(await printedBy(forced(terminal))),
        ];

        expect(overlong(lines, columns)).toEqual([]);
      },
    );
  });

  it.each([80, 100])(
    'keeps every line of the other screens within %i columns, the widths they are read at',
    async (columns) => {
      const lines: string[] = [];
      for (const [, options] of others({ columns })) lines.push(...(await printedBy(options)));

      expect(overlong(lines, columns)).toEqual([]);
    },
  );
});

describe('runInitFlow, the frame a spinner draws', () => {
  const CLEAR_LINE = `\r${ESC}[2K`;

  it.each(WIDTHS)(
    'fits within %i columns, or each turn of it would wrap and leave a line',
    async (columns) => {
      const f = flow({
        terminal: { interactive: true, columns },
        deps: { yes: true, timers: fakeTimers().timers },
      });

      await f.run();

      // A frame is what is written to be drawn over, and is not ended with a newline.
      const frames = f.fake.writes
        .filter((write) => write.startsWith(CLEAR_LINE) && !write.includes('\n'))
        .map((write) => write.slice(CLEAR_LINE.length));
      expect(frames.length).toBeGreaterThan(0);
      expect(overlong(frames, columns)).toEqual([]);
    },
  );
});

describe('runInitFlow, without colour', () => {
  it.each(everything({ interactive: false, color: false }))(
    'writes no escape sequence at all on %s, on a terminal that does not animate',
    async (_name, options) => {
      const f = flow(options);

      await f.run();

      expect(f.fake.out()).not.toContain(ESC);
      expect(f.fake.out()).not.toContain('\r');
      expect(f.fake.prompts.join('')).not.toContain(ESC);
    },
  );
});

describe('runInitFlow, with colour on a terminal that does not animate', () => {
  it.each(everything({ interactive: false, color: true, color256: true }))(
    'colours %s, and moves no cursor',
    async (_name, options) => {
      const f = flow(options);

      await f.run();

      expect(f.fake.out()).toContain(`${ESC}[`);
      expect(f.fake.out()).not.toContain('\r');
      expect(f.fake.out()).not.toContain(`${ESC}[2K`);
      expect(f.fake.out()).not.toContain(`${ESC}[?25`);
    },
  );
});

describe('runInitFlow, where glyphs cannot be drawn', () => {
  describe.each([false, true])('on a terminal that animates: %s', (interactive) => {
    it.each(everything({ interactive, unicode: false }))(
      'draws none of ✔ ✘ – ⠋ on %s',
      async (_name, options) => {
        const f = flow(options);

        await f.run();

        const shown = `${f.fake.out()}${f.fake.prompts.join('')}`;
        for (const glyph of ['✔', '✘', '–', '⠋']) expect(shown).not.toContain(glyph);
        expect(shown).not.toMatch(NON_ASCII);
      },
    );
  });

  it('draws ASCII marks in their place: + for done, x for failed, - for nothing', async () => {
    const done = flow({
      terminal: { unicode: false },
      deps: { yes: true, check: async () => null },
    });
    const failed = flow({
      terminal: { unicode: false },
      deps: { yes: true, install: async () => ({ code: 1, out: 'boom\n' }) },
    });

    await done.run();
    await failed.run();

    expect(done.fake.out()).toContain('  + Claude Code  hooks installed in');
    expect(done.fake.out()).toContain("  - Claude Code  can't be tested from here");
    expect(done.fake.out()).toMatch(/- Codex CLI\s+not found/);
    expect(failed.fake.out()).toContain('  x Claude Code: boom');
  });

  it('draws the glyphs where the terminal can', async () => {
    const f = flow({ terminal: { unicode: true }, deps: { yes: true, check: async () => null } });

    await f.run();

    expect(f.fake.out()).toContain('✔ Claude Code');
    expect(f.fake.out()).toContain('– Claude Code');
  });

  // `shortPath` always cuts with "…", whatever the terminal can draw.
  it('prints no ellipsis for a path it has to cut', async () => {
    const deep =
      '/Users/someone/work/clients/a-very-long-client-name/services/billing/.claude/settings.json';
    const f = flow({
      terminal: { unicode: false, columns: 80 },
      deps: { yes: true, install: async () => ({ code: 0, out: installedOutput(deep) }) },
    });

    await f.run();

    expect(f.fake.out()).toContain('settings.json');
    expect(f.fake.out()).not.toContain('…');
    expect(f.fake.out()).not.toMatch(NON_ASCII);
  });
});
