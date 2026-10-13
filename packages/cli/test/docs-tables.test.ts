import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { commandHelp, usage } from '../src/help.js';
import {
  NAMES,
  REAL_COUNT,
  commandRows,
  flagsIn,
  flagsOf,
  hasWord,
  initAgents,
  mentionsFlag,
  rowsOf,
  saidBy,
  scenarioClaims,
  wrongCounts,
  type Suite,
} from './helpers/docs-readers.js';

/**
 * The command tables and the scenario counts in the docs, held to the code. This file checks
 * these things and no others:
 *
 * - Counts. A number in digits next to the word "scenarios" ("36 scenarios"), or the second
 *   number of an "<N> of the <M>" near that word, is read as the total of a suite and must be the
 *   length of the list the command replays (`attack`, or `bench --actions`). In both docs and in
 *   the help text.
 * - Rows. The "## Commands" table of each doc has a row for every command in `COMMANDS`
 *   (help.ts) and none for a command that does not exist.
 * - Flags. No row names a flag its command does not have, and the `attack`, `bench` and
 *   `coverage` rows name every flag help.ts gives those three.
 * - Agents. The `init` row names every agent help.ts lists for `init --agent`.
 *
 * What a row says beyond that is not checked: not its description, not the flags of the other
 * rows, not a count spelled out in words ("twenty-six scenarios" states sub-counts too, and a
 * sub-count cannot be told from a total without understanding the sentence).
 *
 * Every number below is read from the code, never typed here, so adding a scenario, a command or
 * a flag fails this file until the docs say so. The readers are in helpers/docs-readers.ts and
 * are tried on text of their own first, so that a reader gone blind fails instead of passing.
 */

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

// Paths are from this file, not the working directory: vitest can be started anywhere.
const GUIDE = { name: 'docs/GUIDE.md', text: read('../../../docs/GUIDE.md') };
const CLI_README = { name: 'packages/cli/README.md', text: read('../README.md') };
const DOCS = [GUIDE, CLI_README];

/**
 * Commands whose rows must name every flag `--help` lists for them: the three whose rows had
 * fallen behind their own help (`attack --fuzz`, `bench --actions`, `coverage` itself). Other
 * rows have older gaps (`init --yes`, `doctor --all`, ...) that are a separate piece of work,
 * so this is a list to grow, not a rule for every row yet.
 */
const ROWS_NAME_EVERY_FLAG = ['attack', 'bench', 'coverage'] as const;

describe('reading the commands from help.ts', () => {
  it('finds each command once, and the commands, flags and agents this file relies on', () => {
    // A change to the shape of COMMANDS must not turn the table checks below into checks over nothing.
    expect(NAMES).toEqual(expect.arrayContaining(['init', 'attack', 'bench', 'coverage']));
    expect(new Set(NAMES).size).toBe(NAMES.length);
    expect(flagsOf('attack')).toContain('--fuzz');
    expect(flagsOf('bench')).toContain('--actions');
    expect(flagsOf('coverage')).toContain('--format');
    expect(
      initAgents(),
      '`stroq init --help` no longer opens its --agent line with "a, b or c."',
    ).toEqual(expect.arrayContaining(['claude-code', 'antigravity', 'mcp']));
  });
});

describe('reading the rows, on text of their own', () => {
  it('reads rows out of a table, and commands only out of the first column', () => {
    const rows = commandRows(
      [
        '## Commands',
        '',
        '| Command | What it does |',
        '| --- | --- |',
        '| `stroq a [--x\\|--y]` | Does `stroq b` things |',
        '| `stroq c` / `stroq d <e\\|f>` | Does it |',
        '| not a command | `stroq g` is only in prose |',
        '',
        '| `stroq h` | a second table is not read |',
      ].join('\n'),
    );
    expect(rows.map((row) => [row.line, row.commands])).toEqual([
      [5, ['a']],
      [6, ['c', 'd']],
    ]);
    expect(rows[0]?.synopsis).toBe('`stroq a [--x\\|--y]`');
    expect(rows[0]?.what).toBe('Does `stroq b` things');
    expect(commandRows('no commands section')).toEqual([]);
  });

  it('knows an agent by its whole name', () => {
    expect(hasWord('`stroq init [--agent a\\|cursor\\|mcp]`', 'cursor')).toBe(true);
    expect(hasWord('wrap with `--agent mcp --client <name>`', 'mcp')).toBe(true);
    expect(hasWord('the mcp-proxy and the mcpx', 'mcp')).toBe(false);
  });
});

describe('reading the claims, on text of their own', () => {
  it('reads "<N> ... scenarios", up to four plain words between, as a total of the attack suite', () => {
    expect(
      scenarioClaims('Replay 36 documented-incident and synthetic scenarios now'),
    ).toMatchObject([
      {
        n: 36,
        line: 1,
        quote: '36 documented-incident and synthetic scenarios',
        suite: 'attack',
        how: 'before-scenarios',
      },
    ]);
    expect(scenarioClaims('1 two three four five six scenarios')).toEqual([]);
    expect(scenarioClaims('twenty-six scenarios, none of them in digits')).toEqual([]);
  });

  it('puts a number with the word "ordinary" around it with the ordinary work', () => {
    const suites = (text: string): Suite[] => scenarioClaims(text).map((claim) => claim.suite);
    expect(suites('replays 75 scenarios of ordinary agent work')).toEqual(['ordinary work']);
    expect(suites('replays 75 ordinary scenarios')).toEqual(['ordinary work']);
    expect(suites('replays 36 scenarios of public incidents')).toEqual(['attack']);
  });

  it('reads the second number of an "<N> of the <M>" near the word scenario as a total', () => {
    const text = 'every scenario that carries untrusted text (20 of the 36) is mutated';
    expect(scenarioClaims(text)).toMatchObject([
      { n: 36, line: 1, quote: '20 of the 36', suite: 'attack', how: 'of-the' },
    ]);
    expect(scenarioClaims('20 of 36 are mutated, as the scenarios say')).toHaveLength(1);
    expect(scenarioClaims('3 of the 5 rules, with no such word')).toEqual([]);
    // The word is there, but further from the numbers than a reader would take it to belong to them.
    expect(scenarioClaims(`scenario ${'x'.repeat(120)} 3 of the 5`)).toEqual([]);
  });

  it('puts an "<N> of the <M>" with the word "ordinary" around it with the ordinary work', () => {
    const text = 'of the ordinary scenarios (30 of the 75) none is interrupted';
    expect(scenarioClaims(text).map((claim) => [claim.n, claim.suite])).toEqual([
      [75, 'ordinary work'],
    ]);
  });
});

describe('a count that is not the code’s number says why it was read as one', () => {
  it('names a number in digits next to "scenarios" as read as a total, and what to do', () => {
    const [problem, ...rest] = wrongCounts('x.md', 'Of these, 26 scenarios cite a public report.');
    expect(rest).toEqual([]);
    expect(problem).toContain('x.md:1: "26 scenarios"');
    expect(problem).toMatch(/digits/);
    expect(problem).toMatch(/total/);
    expect(problem).toMatch(/spell it out in words/);
    expect(problem).toMatch(/reword/);
  });

  it('names the words around the number as what put it with the attack suite', () => {
    const [problem] = wrongCounts('x.md', 'Replay 12 scenarios against your policy.');
    expect(problem).toMatch(/"ordinary" is not among the words around it/);
    expect(problem).toMatch(/attack suite/);
  });

  it('names the words around the number as what put it with the ordinary work', () => {
    const [problem] = wrongCounts('x.md', 'Replay 80 scenarios of ordinary agent work.');
    expect(problem).toMatch(/"ordinary" is among the words around it/);
    expect(problem).toMatch(/bench --actions/);
    expect(problem).toContain(`the code has ${REAL_COUNT['ordinary work']}`);
  });

  it('names an "<N> of the <M>" as read as a total, and holds the M to the code', () => {
    const real = REAL_COUNT.attack;
    expect(wrongCounts('x.md', `every scenario with text (20 of the ${real}) is mutated`)).toEqual(
      [],
    );
    const [problem] = wrongCounts(
      'x.md',
      `every scenario with text (20 of the ${real + 1}) is mutated`,
    );
    expect(problem).toContain(`"20 of the ${real + 1}"`);
    expect(problem).toMatch(/second number of an "<N> of the <M>"/);
    expect(problem).toMatch(/spell it out in words/);
  });
});

describe.each(DOCS)('$name', ({ name, text }) => {
  const rows = commandRows(text);

  it('has a "## Commands" table to read', () => {
    expect(rows.length, 'no row names a `stroq <command>` under "## Commands"').toBeGreaterThan(0);
  });

  it('has a row for every command `stroq --help` lists', () => {
    const documented = new Set(rows.flatMap((row) => row.commands));
    const missing = NAMES.filter((command) => !documented.has(command));
    expect(
      missing,
      `the "## Commands" table in ${name} has no row for: ${missing.join(', ')}. Add a row for ` +
        'each, with its synopsis and what it does in the words of its --help',
    ).toEqual([]);
  });

  it('has rows only for commands that exist', () => {
    const unknown = rows
      .flatMap((row) => row.commands.map((command) => ({ command, line: row.line })))
      .filter(({ command }) => !NAMES.includes(command))
      .map(({ command, line }) => `${name}:${line}: stroq ${command} is not in \`stroq --help\``);
    expect(unknown).toEqual([]);
  });

  it('names no flag its command does not have', () => {
    const unknown = rows.flatMap((row) =>
      row.commands
        .filter((command) => NAMES.includes(command))
        .flatMap((command) => {
          const known = flagsOf(command);
          return flagsIn(row.synopsis)
            .filter((flag) => !known.includes(flag))
            .map((flag) => `${name}:${row.line}: stroq ${command} has no ${flag}`);
        }),
    );
    expect(unknown).toEqual([]);
  });

  it.each(ROWS_NAME_EVERY_FLAG)('names every flag of `stroq %s` in its row', (command) => {
    const mine = rowsOf(rows, command);
    expect(mine.length, `no row for \`stroq ${command}\` under "## Commands"`).toBeGreaterThan(0);
    const flags = flagsOf(command);
    expect(flags.length, `help.ts gives \`stroq ${command}\` no flags`).toBeGreaterThan(0);
    const missing = flags.filter((flag) => !mentionsFlag(saidBy(mine), flag));
    expect(
      missing,
      `the \`stroq ${command}\` row (line ${mine.map((row) => row.line).join(', ')}) does not ` +
        `name ${missing.join(', ')}, which \`stroq ${command} --help\` lists`,
    ).toEqual([]);
  });

  it('names every agent `stroq init --agent` lists in the `stroq init` row', () => {
    const mine = rowsOf(rows, 'init');
    expect(mine.length, 'no row for `stroq init` under "## Commands"').toBeGreaterThan(0);
    const missing = initAgents().filter((agent) => !hasWord(saidBy(mine), agent));
    expect(
      missing,
      `the \`stroq init\` row (line ${mine.map((row) => row.line).join(', ')}) does not name ` +
        `${missing.join(', ')}, which \`stroq init --help\` lists for --agent`,
    ).toEqual([]);
  });

  it('says in the `stroq attack` row how many scenarios it replays', () => {
    const stated = rowsOf(rows, 'attack')
      .flatMap((row) => scenarioClaims(row.what))
      .filter((claim) => claim.suite === 'attack');
    expect(
      stated.length,
      'the `stroq attack` row has no number this guard can read as its scenario count: it reads ' +
        'digits up to four plain words before "scenarios" ("36 documented-incident and synthetic ' +
        'scenarios"), with no "ordinary" around them. Write the count that way, or this guard ' +
        'has nothing to hold to the code',
    ).toBeGreaterThan(0);
  });

  it('counts scenarios the way the code does, wherever it counts them', () => {
    expect(wrongCounts(name, text)).toEqual([]);
  });
});

describe('the help text', () => {
  const HELP_TEXTS: [string, string][] = [
    ['stroq --help', usage()],
    ...NAMES.map((command): [string, string] => [
      `stroq ${command} --help`,
      commandHelp(command) ?? '',
    ]),
  ];

  it.each(HELP_TEXTS)('%s counts scenarios the way the code does', (where, text) => {
    expect(wrongCounts(where, text)).toEqual([]);
  });

  it('states how many ordinary-work scenarios `bench --actions` replays', () => {
    // The docs copy this sentence. If it stops saying a number, look at what they say too.
    const stated = scenarioClaims(commandHelp('bench') ?? '').filter(
      (claim) => claim.suite === 'ordinary work',
    );
    expect(
      stated.length,
      'stroq bench --help has no number this guard can read as the ordinary-work count: it reads ' +
        'digits up to four plain words before "scenarios", and takes them for ordinary work only ' +
        'when the word "ordinary" is among those words or the 30 characters after them ' +
        '("75 scenarios of ordinary agent work"). Write the count that way, or the docs that ' +
        'copy it have nothing to be held to',
    ).toBeGreaterThan(0);
  });
});
