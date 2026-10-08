/**
 * What reading a command costs, estimated before it is read.
 *
 * The hook has one thread, and a host that gives up on it treats silence as an allow. Every reader
 * of a command here is linear in its text, but the constant is not the same for every text: a
 * command of a megabyte that is one word costs a second, and one that is a hundred thousand
 * commands costs many times that, because each word, each separator and each substitution is a
 * place the reading stops and starts again. Measured on two hundred commands built to be slow, the
 * cost stays under 1.2 microseconds a character, 24 for each of those places and 60 for each
 * `eval` and `trap`, which read what follows them as a command of its own; this estimate is that.
 * A command that is estimated past what the hook can spend is not read, and is asked about: no
 * model writes one by hand, and a file of that size belongs to the write tool.
 */
const CHARACTER_COST_US = 1.2;
const PLACE_COST_US = 24;
const NESTING_WORD_COST_US = 60;
/** What a substitution, a backtick pair or a process substitution costs, in places. */
const SUBSTITUTION_PLACES = 8;
/** What the hook may spend reading one command, so that the rest of its work and the host's wait fit around it. */
export const MAX_READING_COST_US = 5_000_000;

const SPACE = 32;
const TAB = 9;
const NEWLINE = 10;
const DOLLAR = 36;
const BACKTICK = 96;
const LESS = 60;
const GREATER = 62;
const OPEN_PAREN = 40;
const OPEN_BRACE = 123;
const OPEN_BRACKET = 91;
const LOWER_E = 101;
const LOWER_T = 116;
/** `; & | ( ) { } [ ] ' " \ #`: a character after which a reading looks again at what follows. */
const STOPS: ReadonlySet<number> = new Set([59, 38, 124, 40, 41, 123, 125, 91, 93, 39, 34, 92, 35]);

/** Whether `word` begins at `at` and ends there: `eval` and `trap` as words, not as parts of one. */
function wordAt(command: string, at: number, word: string): boolean {
  if (!command.startsWith(word, at)) return false;
  const after = command.charCodeAt(at + word.length);
  return Number.isNaN(after) || after === SPACE || after === TAB || after === NEWLINE;
}

/** The estimated microseconds of reading `command`, counted in one pass that costs next to nothing. */
export function readingCost(command: string): number {
  let places = 0;
  let nesting = 0;
  let inWord = false;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command.charCodeAt(i);
    if (ch === SPACE || ch === TAB || ch === NEWLINE) {
      inWord = false;
      if (ch === NEWLINE) places += 1;
      continue;
    }
    if (!inWord) {
      inWord = true;
      places += 1;
      if (
        (ch === LOWER_E && wordAt(command, i, 'eval')) ||
        (ch === LOWER_T && wordAt(command, i, 'trap'))
      )
        nesting += 1;
    }
    if (ch === DOLLAR) {
      const next = command.charCodeAt(i + 1);
      places +=
        next === OPEN_PAREN || next === OPEN_BRACE || next === OPEN_BRACKET
          ? SUBSTITUTION_PLACES
          : 1;
    } else if (ch === BACKTICK) places += SUBSTITUTION_PLACES;
    else if (ch === LESS || ch === GREATER) {
      const next = command.charCodeAt(i + 1);
      places += next === OPEN_PAREN ? SUBSTITUTION_PLACES : next === ch ? 4 : 1;
    } else if (STOPS.has(ch)) places += 1;
  }
  return (
    command.length * CHARACTER_COST_US + places * PLACE_COST_US + nesting * NESTING_WORD_COST_US
  );
}

/** Whether a command is estimated to cost more to read than the hook can spend. */
export const isTooCostly = (command: string): boolean => readingCost(command) > MAX_READING_COST_US;
