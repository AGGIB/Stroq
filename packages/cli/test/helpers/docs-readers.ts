import { SCENARIOS } from '../../src/attack/scenarios/index.js';
import { ACTION_SCENARIOS } from '../../src/bench/actions-corpus.js';
import { COMMANDS } from '../../src/help.js';

/**
 * How docs-tables.test.ts reads the docs and the code. The readers live apart from the tests so
 * that they can be tried on text of their own: a reader that finds nothing makes every check
 * built on it pass, and only a test of the reader itself says so.
 */

/** The commands `stroq --help` lists: `COMMANDS` is the table it is printed from. */
export const NAMES: readonly string[] = COMMANDS.map((command) => command.name);

export const flagsIn = (text: string): readonly string[] => [
  ...new Set([...text.matchAll(/(?<![\w-])(--[a-z][a-z0-9-]*)/g)].map((match) => match[1] ?? '')),
];

/** The flags help.ts gives a command: `--format <table|navigator>` is the flag `--format`. */
export const flagsOf = (name: string): readonly string[] =>
  flagsIn(
    (COMMANDS.find((command) => command.name === name)?.flags ?? [])
      .map(([spelling]) => spelling)
      .join(' '),
  );

/** `--only` is named by `[--only <id>]` but not by `--only-x`, and `--json` not by `--jsonl`. */
export const mentionsFlag = (text: string, flag: string): boolean => flagsIn(text).includes(flag);

/**
 * The agents `stroq init --help` lists for `--agent`. That line opens with them ("claude-code,
 * cursor, ... or mcp."), and the list is read only while it still does: a rewording gives an
 * empty list and the non-vacuity test says so, instead of a doc being asked to name "one" and "of".
 */
export function initAgents(): readonly string[] {
  const init = COMMANDS.find((command) => command.name === 'init');
  const meaning = init?.flags.find(([spelling]) => spelling.startsWith('--agent'))?.[1] ?? '';
  const listed = /^([a-z][a-z0-9-]*(?:, [a-z][a-z0-9-]*)*) or ([a-z][a-z0-9-]*)\./.exec(meaning);
  return listed === null ? [] : [...(listed[1] ?? '').split(', '), listed[2] ?? ''];
}

/** Whether `text` has `word` as a whole word: `mcp` is not in `mcp-server`, `cursor` is in `a\|cursor`. */
export const hasWord = (text: string, word: string): boolean =>
  text.split(/[^\w-]+/).includes(word);

export interface Row {
  /** 1-based line in the file, for the failure message. */
  readonly line: number;
  /** The first cell: the command as typed, flags and all. */
  readonly synopsis: string;
  /** The second cell: what the row says the command does. */
  readonly what: string;
  /** The commands the synopsis names: `stroq hook cursor` names `hook`. */
  readonly commands: readonly string[];
}

/** The rows of the first table under `## Commands`; the header and the divider name no command. */
export function commandRows(markdown: string): readonly Row[] {
  const lines = markdown.split(/\r?\n/);
  const start = lines.indexOf('## Commands');
  if (start === -1) return [];
  const rows: Row[] = [];
  let inTable = false;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (!line.startsWith('|')) {
      if (inTable) break;
      continue;
    }
    inTable = true;
    // A pipe inside a cell is written `\|`, so only an unescaped one ends a cell.
    const cells = line
      .split(/(?<!\\)\|/)
      .slice(1, -1)
      .map((cell) => cell.trim());
    const synopsis = cells[0] ?? '';
    const named = synopsis.matchAll(/`stroq ([a-z][a-z0-9-]*)/g);
    const commands = [...new Set([...named].map((match) => match[1] ?? ''))];
    if (commands.length > 0) rows.push({ line: i + 1, synopsis, what: cells[1] ?? '', commands });
  }
  return rows;
}

export const rowsOf = (rows: readonly Row[], command: string): readonly Row[] =>
  rows.filter((row) => row.commands.includes(command));

/** Everything the rows say, synopsis and description, as one text. */
export const saidBy = (rows: readonly Row[]): string =>
  rows.map((row) => `${row.synopsis} ${row.what}`).join(' ');

/** What a count counts: the attack suite, or the ordinary work `bench --actions` replays. */
export type Suite = 'attack' | 'ordinary work';

export interface Claim {
  /** The number that is read as the total of `suite`. */
  readonly n: number;
  /** 1-based line in the text. */
  readonly line: number;
  readonly quote: string;
  readonly suite: Suite;
  /** Which of the two readings found it. */
  readonly how: 'before-scenarios' | 'of-the';
}

export const REAL_COUNT: Readonly<Record<Suite, number>> = {
  attack: SCENARIOS.length,
  'ordinary work': ACTION_SCENARIOS.length,
};

/** How far from an "<N> of the <M>" the word "scenario" may be for the M to be read as a total. */
const NEAR = 100;

const suiteOf = (around: string): Suite =>
  /\bordinary\b/i.test(around) ? 'ordinary work' : 'attack';

/**
 * Every number in a text that is read as the total of a suite, found two ways:
 * - "<N> ... scenarios": digits, up to four plain words, then "scenarios". The suite comes from
 *   the words between and the 30 characters after.
 * - "<N> of the <M>" ("the" optional) with the word "scenario" within `NEAR` characters: the M.
 *   The suite comes from the characters around it.
 * Either way it is ordinary work when the word "ordinary" is among those words, the attack suite
 * otherwise. Both patterns run in time linear in the line: every repetition is bounded or ends at
 * a character it cannot contain.
 */
export function scenarioClaims(text: string): readonly Claim[] {
  return text.split(/\r?\n/).flatMap((line, index) => {
    const before = [
      ...line.matchAll(/\b(\d+) ((?:[A-Za-z][\w-]* ){0,4})scenarios\b(?=(.{0,30}))/g),
    ].map((match): Claim => ({
      n: Number(match[1]),
      line: index + 1,
      quote: match[0],
      suite: suiteOf(`${match[2] ?? ''}${match[3] ?? ''}`),
      how: 'before-scenarios',
    }));
    const ofThe = [...line.matchAll(/\b\d+ of (?:the )?(\d+)\b/g)].flatMap((match): Claim[] => {
      const around = line.slice(
        Math.max(0, match.index - NEAR),
        match.index + match[0].length + NEAR,
      );
      if (!/\bscenarios?\b/i.test(around)) return [];
      return [
        {
          n: Number(match[1]),
          line: index + 1,
          quote: match[0],
          suite: suiteOf(around),
          how: 'of-the',
        },
      ];
    });
    return [...before, ...ofThe];
  });
}

const READ_AS_A_TOTAL: Readonly<Record<Claim['how'], string>> = {
  'before-scenarios': 'digits up to four words before "scenarios" are taken for a total',
  'of-the':
    'the second number of an "<N> of the <M>" near the word "scenario" is taken for a total',
};

const HELD_TO_A_SUITE: Readonly<Record<Suite, string>> = {
  attack: '"ordinary" is not among the words around it, so it is held to the attack suite',
  'ordinary work':
    '"ordinary" is among the words around it, so it is held to the ordinary work `bench --actions` replays',
};

/**
 * The claims in `text` that are not the number the code has, one line each. A line says how the
 * number was read, because the reading is a guess: a part of a total written in digits looks
 * like a total, and the suite is chosen by one word.
 */
export const wrongCounts = (where: string, text: string): readonly string[] =>
  scenarioClaims(text)
    .filter((claim) => claim.n !== REAL_COUNT[claim.suite])
    .map(
      (claim) =>
        `${where}:${claim.line}: "${claim.quote}" says ${claim.n}, ` +
        `the code has ${REAL_COUNT[claim.suite]} (${claim.suite}). ` +
        `Read as a total: ${READ_AS_A_TOTAL[claim.how]}; ${HELD_TO_A_SUITE[claim.suite]}. ` +
        `If ${claim.n} is not meant as that total, spell it out in words or reword the sentence`,
    );
