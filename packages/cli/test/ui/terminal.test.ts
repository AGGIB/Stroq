import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeUnfiltered } from '../../src/terminal-safe.js';
import { currentTerminal, terminalFacts, type World } from '../../src/ui/terminal.js';

type Env = Readonly<Record<string, string | undefined>>;

/** A person at a Linux terminal, 80 columns wide, with nothing set in the environment. */
const world = (overrides: Partial<World> = {}): World => ({
  env: {},
  stdoutIsTTY: true,
  stdinIsTTY: true,
  columns: 80,
  platform: 'linux',
  ...overrides,
});

const factsIn = (env: Env, rest: Partial<Omit<World, 'env'>> = {}) =>
  terminalFacts(world({ env, ...rest }));

describe('terminalFacts: a person at a terminal', () => {
  it('is interactive, with colour and glyphs, when both streams are terminals', () => {
    const facts = factsIn({ TERM: 'xterm' });

    expect(facts).toEqual({
      interactive: true,
      color: true,
      color256: false,
      unicode: true,
      columns: 80,
    });
  });

  it('is not interactive, and has no colour, when standard output is piped', () => {
    const facts = factsIn({ TERM: 'xterm-256color' }, { stdoutIsTTY: false });

    expect(facts.interactive).toBe(false);
    expect(facts.color).toBe(false);
    expect(facts.color256).toBe(false);
  });

  it('is not interactive, but still has colour, when only standard input is not a terminal', () => {
    const facts = factsIn({ TERM: 'xterm' }, { stdinIsTTY: false });

    expect(facts.interactive).toBe(false);
    expect(facts.color).toBe(true);
  });

  it('is not interactive when neither stream is a terminal', () => {
    const facts = factsIn({}, { stdoutIsTTY: false, stdinIsTTY: false });

    expect(facts.interactive).toBe(false);
  });
});

describe('terminalFacts: TERM=dumb', () => {
  it('is not interactive, has no colour and no glyphs', () => {
    const facts = factsIn({ TERM: 'dumb' });

    expect(facts).toMatchObject({
      interactive: false,
      color: false,
      color256: false,
      unicode: false,
    });
  });

  it('has no colour even when colour is forced', () => {
    expect(factsIn({ TERM: 'dumb', FORCE_COLOR: '1' }).color).toBe(false);
  });
});

describe('terminalFacts: CI', () => {
  it.each(['true', '1', 'yes', 'TRUE'])('is not interactive when CI=%s', (value) => {
    expect(factsIn({ CI: value }).interactive).toBe(false);
  });

  it.each(['0', 'false', ''])('is still interactive when CI=%j', (value) => {
    expect(factsIn({ CI: value }).interactive).toBe(true);
  });

  it('is interactive when CI is not set', () => {
    expect(factsIn({}).interactive).toBe(true);
  });

  it('keeps its colour in CI: only the question and the spinner are given up', () => {
    expect(factsIn({ CI: 'true' }).color).toBe(true);
  });
});

describe('terminalFacts: colour', () => {
  it('is off, and interactive stays true, when NO_COLOR is set', () => {
    const facts = factsIn({ NO_COLOR: '1', TERM: 'xterm-256color' });

    expect(facts.interactive).toBe(true);
    expect(facts.color).toBe(false);
    expect(facts.color256).toBe(false);
  });

  it('ignores a NO_COLOR that is empty', () => {
    expect(factsIn({ NO_COLOR: '' }).color).toBe(true);
  });

  it('takes any other NO_COLOR as a no, "0" included', () => {
    expect(factsIn({ NO_COLOR: '0' }).color).toBe(false);
  });

  it('lets NO_COLOR win over FORCE_COLOR', () => {
    expect(factsIn({ NO_COLOR: '1', FORCE_COLOR: '1' }).color).toBe(false);
  });

  it('is on, and interactive off, when FORCE_COLOR=1 is set on a pipe', () => {
    const facts = factsIn({ FORCE_COLOR: '1' }, { stdoutIsTTY: false });

    expect(facts.color).toBe(true);
    expect(facts.interactive).toBe(false);
  });

  it('does not force colour on a pipe when FORCE_COLOR=0', () => {
    expect(factsIn({ FORCE_COLOR: '0' }, { stdoutIsTTY: false }).color).toBe(false);
  });

  it('does not force colour on a pipe when FORCE_COLOR is empty', () => {
    expect(factsIn({ FORCE_COLOR: '' }, { stdoutIsTTY: false }).color).toBe(false);
  });
});

describe('terminalFacts: 256 colours', () => {
  it('has them when TERM says so', () => {
    expect(factsIn({ TERM: 'xterm-256color' }).color256).toBe(true);
  });

  it('reads TERM without regard to case', () => {
    expect(factsIn({ TERM: 'XTERM-256COLOR' }).color256).toBe(true);
  });

  it('has them when COLORTERM is set, whatever TERM is', () => {
    expect(factsIn({ TERM: 'xterm', COLORTERM: 'truecolor' }).color256).toBe(true);
  });

  it('has only 8 colours on a plain xterm', () => {
    expect(factsIn({ TERM: 'xterm' }).color256).toBe(false);
  });

  it('has none when colour is off, whatever TERM says', () => {
    expect(
      factsIn({ TERM: 'xterm-256color', COLORTERM: 'truecolor', NO_COLOR: '1' }).color256,
    ).toBe(false);
  });

  it('has them on a pipe when colour is forced and TERM says so', () => {
    const facts = factsIn({ TERM: 'xterm-256color', FORCE_COLOR: '1' }, { stdoutIsTTY: false });

    expect(facts.color256).toBe(true);
  });
});

describe('terminalFacts: glyphs', () => {
  it.each<[string, Env, boolean]>([
    ['no locale variable is set', {}, true],
    ['LANG=C', { LANG: 'C' }, false],
    ['LANG=POSIX', { LANG: 'POSIX' }, false],
    ['LANG=en_US.UTF-8', { LANG: 'en_US.UTF-8' }, true],
    ['LANG=en_US.utf8', { LANG: 'en_US.utf8' }, true],
    ['LANG=C.UTF-8', { LANG: 'C.UTF-8' }, true],
    ['LANG=de_DE.ISO-8859-1', { LANG: 'de_DE.ISO-8859-1' }, false],
    ['LC_ALL=C beats LANG=en_US.UTF-8', { LC_ALL: 'C', LANG: 'en_US.UTF-8' }, false],
    ['LC_ALL=en_US.UTF-8 beats LANG=C', { LC_ALL: 'en_US.UTF-8', LANG: 'C' }, true],
    ['LC_CTYPE=C beats LANG=en_US.UTF-8', { LC_CTYPE: 'C', LANG: 'en_US.UTF-8' }, false],
    ['LC_ALL beats LC_CTYPE', { LC_ALL: 'en_US.UTF-8', LC_CTYPE: 'C' }, true],
    ['an empty LC_ALL falls through to LANG=C', { LC_ALL: '', LANG: 'C' }, false],
    ['an empty LC_ALL falls through to LANG=UTF-8', { LC_ALL: '', LANG: 'en_US.UTF-8' }, true],
  ])('on Linux, when %s the glyphs are drawn: %s', (_name, env, drawn) => {
    expect(factsIn(env).unicode).toBe(drawn);
  });

  it('follows the locale on macOS as it does on Linux', () => {
    expect(factsIn({ LANG: 'en_US.UTF-8' }, { platform: 'darwin' }).unicode).toBe(true);
    expect(factsIn({ LANG: 'C' }, { platform: 'darwin' }).unicode).toBe(false);
  });

  it('does not draw them in an old Windows console', () => {
    expect(factsIn({}, { platform: 'win32' }).unicode).toBe(false);
  });

  it('draws them in Windows Terminal', () => {
    expect(factsIn({ WT_SESSION: 'a-guid' }, { platform: 'win32' }).unicode).toBe(true);
  });

  it('draws them in the VS Code terminal on Windows', () => {
    expect(factsIn({ TERM_PROGRAM: 'vscode' }, { platform: 'win32' }).unicode).toBe(true);
  });

  it('does not draw them in another Windows terminal program', () => {
    expect(factsIn({ TERM_PROGRAM: 'mintty' }, { platform: 'win32' }).unicode).toBe(false);
  });

  it('ignores the locale on Windows, whose console does not honour it', () => {
    expect(factsIn({ LANG: 'en_US.UTF-8' }, { platform: 'win32' }).unicode).toBe(false);
  });

  it('ignores WT_SESSION off Windows, where the locale decides', () => {
    expect(factsIn({ WT_SESSION: 'a-guid', LANG: 'C' }).unicode).toBe(false);
  });
});

describe('terminalFacts: columns', () => {
  it.each<[number | undefined, number]>([
    [20, 40],
    [39, 40],
    [40, 40],
    [72, 72],
    [100, 100],
    [101, 100],
    [300, 100],
    [undefined, 80],
    [0, 80],
    [-5, 80],
    [Number.NaN, 80],
  ])('turns a width of %s into %i columns', (width, expected) => {
    expect(terminalFacts(world({ columns: width })).columns).toBe(expected);
  });
});

describe('terminalFacts: purity', () => {
  it('reads a frozen environment without changing it, and answers the same twice', () => {
    const env = Object.freeze({ TERM: 'xterm-256color', LANG: 'en_US.UTF-8' });

    const first = terminalFacts(world({ env }));
    const second = terminalFacts(world({ env }));

    expect(second).toEqual(first);
    expect(env).toEqual({ TERM: 'xterm-256color', LANG: 'en_US.UTF-8' });
  });
});

describe('currentTerminal', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('can write and read lines', () => {
    const term = currentTerminal();

    expect(typeof term.write).toBe('function');
    expect(typeof term.readLine).toBe('function');
  });

  it('writes with the unfiltered writer, so that its own colours reach the screen', () => {
    expect(currentTerminal().write).toBe(writeUnfiltered);
  });

  it('has the facts of this process, no more and no less', () => {
    const term = currentTerminal();

    expect({
      interactive: term.interactive,
      color: term.color,
      color256: term.color256,
      unicode: term.unicode,
      columns: term.columns,
    }).toEqual(
      terminalFacts({
        env: process.env,
        stdoutIsTTY: process.stdout.isTTY === true,
        stdinIsTTY: process.stdin.isTTY === true,
        columns: process.stdout.columns,
        platform: process.platform,
      }),
    );
  });

  it('is never interactive in CI, whatever the streams are', () => {
    vi.stubEnv('CI', 'true');

    expect(currentTerminal().interactive).toBe(false);
  });

  it('has no colour when NO_COLOR is set', () => {
    vi.stubEnv('NO_COLOR', '1');

    const term = currentTerminal();

    expect(term.color).toBe(false);
    expect(term.color256).toBe(false);
  });

  it('is plain on TERM=dumb: nothing to ask, no colour, no glyphs', () => {
    vi.stubEnv('TERM', 'dumb');

    expect(currentTerminal()).toMatchObject({ interactive: false, color: false, unicode: false });
  });

  it('keeps its width between 40 and 100 columns', () => {
    const { columns } = currentTerminal();

    expect(columns).toBeGreaterThanOrEqual(40);
    expect(columns).toBeLessThanOrEqual(100);
  });
});
