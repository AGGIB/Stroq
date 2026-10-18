import type { Positioned } from './atom-kinds.js';
import { commandMap, type CommandMap, type LexedCommand } from './command-map.js';
import { normalizePackageName } from './package-name.js';
import { readInstaller, readRunner, runnerFamily } from './shell-words.js';
import { matchCommand } from './command-match.js';
import { INSTALLER, PHRASE_STARTS, RUNNER, canonicalCommand } from './tool-phrases.js';

// `restOfLine` scans at most this many characters past a runner/installer match.
// A command line longer than this is truncated (trailing packages are missed), which
// bounds the per-match scan cost and keeps package extraction linear instead of
// quadratic on adversarial input that never hits a LINE_END character. A wrapped list of sixty
// packages is about 1,300 characters once its lines are joined, so the window holds that; it is
// the smallest power of two that does, because every doubling is another stretch of an indented
// block that an installer's line runs through (see `wrappedCommandCut`).
export const MAX_LINE_SCAN = 2048;
// The most characters read after runners and installers in one pass over a text, all matches
// together. Each match reads its own line, and the lines of matches that sit on one long line
// overlap, so `npm i a npm i a …` over 200,000 characters would read the window 25,000 times: four
// seconds, inside a hook with nine. An honest text spends at most its own length (a line is read
// once); past this, the matches that are left are not read and count as a line that was cut.
export const MAX_LINE_WORK = 262_144;
const LINE_END = /[\n|;`]|&&|\|\|/;
// Where a command ends, as a shell reads it: a backtick does not end it, it opens a substitution
// in the middle of a word, and what a command says about its own backticks is not to be trusted to
// say where it ends. A page is not a command, and there a backtick closes the code span that a
// package is named in (`npx foo`), so `LINE_END` stays for the text of a result.
const COMMAND_END = /[\n|;]|&&|\|\|/;

/** The part of a line an extractor read, and whether the line went on past what it read. */
interface LineScan {
  readonly line: string;
  readonly cut: boolean;
  /** How many characters of the text were looked at to find it. */
  readonly read: number;
}

/**
 * The rest of the line after `from`. For a command a backtick is part of a word (`ev`x`il`) and
 * the word is a doubt (see `shell-words.ts`); for a page it ends the line.
 */
function restOfLine(text: string, from: number, command: boolean): LineScan {
  const rest = text.slice(from, from + MAX_LINE_SCAN);
  const end = command ? COMMAND_END : LINE_END;
  const stop = rest.search(end);
  return {
    line: (stop === -1 ? rest : rest.slice(0, stop)).trim(),
    cut: stop === -1 && text.length > from + MAX_LINE_SCAN,
    read: stop === -1 ? rest.length : stop,
  };
}

/** Atoms one extractor found, and whether it stopped reading a line before the line ended. */
export interface Found {
  readonly positioned: Positioned[];
  /** A line went on past the window, with no package found before it ended. */
  readonly cut: boolean;
  /** The pass spent its reading budget, so some matches were not read at all. */
  readonly budgetSpent: boolean;
  /** A word that should have named a package is a variable or a command (see `shell-words.ts`). */
  readonly doubt: boolean;
}

/** A runner or installer match with the rest of its line, positioned at the match's start. */
type LineAfter = (m: RegExpMatchArray) => { index: number; scan: LineScan };

/** Reads the line after each match, and says whether the budget ran out so some were skipped. */
interface LineReader {
  readonly after: LineAfter;
  readonly skipped: () => boolean;
}

/**
 * Reads the line after each match in turn, out of one budget for the pass (`MAX_LINE_WORK`). A
 * match that finds the budget spent is given an empty line that was cut: it was not read, and the
 * reader says so through `skipped`, apart from a line that is merely longer than the window. Every
 * pass over a text (the text as written, a decoded variant, the text with its continuation lines
 * joined) makes its own reader and so has its own budget, and the caller counts a spent budget as
 * a loss in every one of them: the joined pass is the one that reads a block of indented lines as
 * a single long line, which is where the budget goes first.
 */
function lineReader(text: string, command: boolean): LineReader {
  let budget = MAX_LINE_WORK;
  let skipped = false;
  return {
    after: (m) => {
      const index = m.index ?? 0;
      if (budget <= 0) {
        skipped = true;
        return { index, scan: { line: '', cut: true, read: 0 } };
      }
      const scan = restOfLine(text, index + m[0].length, command);
      budget -= scan.read + 1;
      return { index, scan };
    },
    skipped: () => skipped,
  };
}

/**
 * The words of the line that was read, without the last one when the line went on past the
 * window: that one may have been cut in the middle, and a name that is half of one is not a name.
 */
function readTokens(scan: LineScan): string[] {
  const tokens = scan.line === '' ? [] : scan.line.split(/\s+/);
  return scan.cut ? tokens.slice(0, -1) : tokens;
}

/** The tool a matched phrase is of, by its first word: `python -m pip install` is pip's. */
const toolOf = (phrase: string): string => {
  const first = canonicalCommand(phrase.trim().split(/\s+/)[0] ?? '');
  return first === 'python' ? 'pip' : first;
};

/** The last word of a matched phrase, lower-cased. */
const lastWord = (phrase: string): string => phrase.trim().split(/\s+/).pop()?.toLowerCase() ?? '';

/** Where a package was named, as atoms. */
const atomsAt = (index: number, packages: readonly string[]): Positioned[] =>
  packages.flatMap((pkg): Positioned[] => {
    const value = normalizePackageName(pkg);
    return value.length > 0 ? [{ index, atom: { kind: 'pkg', value } }] : [];
  });

/**
 * What the matches of a pattern name when they are read as mentions: the words after a runner or
 * installer in running text, a quoted string or a comment. A word that cannot be read counts as
 * a doubt unless the line PROVES the mention inert (see `command-map.ts`).
 */
interface Mentions {
  readonly text: string;
  readonly reader: LineReader;
  readonly isMention: (index: number) => boolean;
  /** Whether a word that cannot be read counts, for the mention that begins at an index. */
  readonly doubtsAt: (index: number) => boolean;
}

/**
 * Every package named after a runner match, positioned at that match's start index. A runner's
 * packages are the values of every `-p`, or else the first word that is not a flag, so a line that
 * goes on past the window after that word was reached has lost nothing. A line cut before it is
 * cut.
 */
function runnerMentions({ text, reader, isMention, doubtsAt }: Mentions): Found {
  const lines = [...text.matchAll(RUNNER)]
    .filter((m) => isMention(m.index ?? 0))
    .map((m) => ({
      ...reader.after(m),
      family: runnerFamily(m[0]),
      verb: lastWord(m[0]),
      tool: toolOf(m[0]),
    }))
    .map((line) => ({
      ...line,
      reading: readRunner(
        readTokens(line.scan),
        line.family,
        doubtsAt(line.index),
        false,
        true,
        line.tool,
      ),
    }));
  return {
    positioned: lines.flatMap(({ index, reading, verb }) =>
      atomsAt(index, withCreated(reading.packages, verb)),
    ),
    cut: lines.some(({ scan, reading }) => scan.cut && !reading.sure),
    budgetSpent: reader.skipped(),
    doubt: lines.some(({ reading }) => reading.doubt),
  };
}

/** Every package named after an installer match, positioned at that match's start index. */
function installerMentions({ text, reader, isMention, doubtsAt }: Mentions): Found {
  const lines = [...text.matchAll(INSTALLER)]
    .filter((m) => isMention(m.index ?? 0))
    .map((m) => ({ ...reader.after(m), tool: toolOf(m[0]) }))
    .map((line) => ({
      ...line,
      reading: readInstaller(readTokens(line.scan), doubtsAt(line.index), false, line.tool),
    }));
  return {
    positioned: lines.flatMap(({ index, reading }) => atomsAt(index, reading.packages)),
    cut: lines.some(({ scan }) => scan.cut),
    budgetSpent: reader.skipped(),
    doubt: lines.some(({ reading }) => reading.doubt),
  };
}

/** The words of a command as they were written, quotes and all. */
function wordsOf(text: string, command: LexedCommand): string[] {
  const words: string[] = [];
  for (let k = 0; k < command.words.length; k += 2)
    words.push(text.slice(command.words[k], command.words[k + 1]));
  return words;
}

/** The name of the package a `create` runs: `create-<name>`, and `@scope/create-<name>` for a scoped one. */
const createdBy = (name: string): string => {
  const slash = name.startsWith('@') ? name.indexOf('/') : -1;
  return slash === -1
    ? `create-${name}`
    : `${name.slice(0, slash + 1)}create-${name.slice(slash + 1)}`;
};

/** A `create` runs the package named `create-<name>`: both names are read. */
const withCreated = (packages: readonly string[], verb: string): string[] =>
  verb === 'create' ? [...packages, ...packages.map(createdBy)] : [...packages];

/** What one command that runs a runner or an installer names, read from its words. */
function readCommand(text: string, start: number, command: LexedCommand): Found | null {
  const words = wordsOf(text, command);
  const match = matchCommand(words);
  if (match === null) return null;
  const rest = words.slice(match.consumed);
  const found = (packages: string[], doubt: boolean, cut: boolean): Found => ({
    positioned: atomsAt(start, withCreated(packages, match.verb)),
    cut,
    budgetSpent: false,
    doubt: doubt || match.doubt,
  });
  const family = runnerFamily(words[0] ?? '');
  const tool = toolOf(words[0] ?? '');
  // The verb was not reached (more options than are looked at): the rest is read as the words of
  // either kind of launcher, and the packages of both are kept.
  if (match.unreached === true) {
    const installer = readInstaller(rest, true, true, tool);
    const runner = readRunner(rest, family, true, true, true, tool);
    return found([...installer.packages, ...runner.packages], true, command.truncated);
  }
  if (match.phrase.kind === 'installer') {
    const reading = readInstaller(rest, true, true, tool);
    return found(reading.packages, reading.doubt, command.truncated);
  }
  const reading = readRunner(rest, family, true, true, match.phrase.kind === 'runner', tool);
  return found(reading.packages, reading.doubt, command.truncated && !reading.sure);
}

/** The commands of a text that run a runner or an installer, each read from its words. */
function commandPackages(text: string, map: CommandMap): Found {
  const found = [...map.commands].flatMap(([start, command]) => {
    const read = readCommand(text, start, command);
    return read === null ? [] : [read];
  });
  return {
    positioned: found.flatMap((read) => read.positioned),
    cut: found.some((read) => read.cut),
    budgetSpent: false,
    doubt: found.some((read) => read.doubt),
  };
}

/** The window of words kept for a command: the line window, and the words of the phrase itself. */
const COMMAND_WINDOW = MAX_LINE_SCAN + 32;

/**
 * The packages a text names. A page is read for mentions. A command is read twice over: the
 * commands that run a runner or an installer, from their words as the shell reads them (quotes,
 * redirections and separators in place), and everything else that looks like one as a mention,
 * which can name a package but is no doubt about what will run. Where the reading of the command
 * is not sure (a quote that never closes, a construct it does not know), every match counts as a
 * command, as it did before.
 */
export function packageAtoms(text: string, command: boolean): Found {
  const map = command
    ? commandMap(text, (name) => PHRASE_STARTS.has(name), COMMAND_WINDOW, launcherIndexes(text))
    : null;
  const sure = map !== null && !map.uncertain;
  const reader = lineReader(text, command);
  const mentions: Mentions = {
    text,
    reader,
    isMention: (index) => !sure || !map.commands.has(index),
    // Only what the line proves inert is no doubt; a mention that is not proven inert, and every
    // match where the reading is not sure, counts as a command would.
    doubtsAt: (index) => command && (!sure || !map.inert.has(index)),
  };
  const runners = runnerMentions(mentions);
  const installers = installerMentions(mentions);
  const commands = sure ? commandPackages(text, map) : null;
  return {
    positioned: [...runners.positioned, ...installers.positioned, ...(commands?.positioned ?? [])],
    cut: runners.cut || installers.cut || (commands?.cut ?? false),
    budgetSpent: reader.skipped(),
    doubt: runners.doubt || installers.doubt || (commands?.doubt ?? false),
  };
}

/** Where a runner or installer is named in a text, in order. */
function launcherIndexes(text: string): number[] {
  return [...text.matchAll(RUNNER), ...text.matchAll(INSTALLER)]
    .map((m) => m.index ?? 0)
    .sort((a, b) => a - b);
}
