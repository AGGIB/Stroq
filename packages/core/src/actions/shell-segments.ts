/**
 * Shell command tokenization: splitting a raw command string into the
 * individual "segments" (pipeline stages, `&&`/`||`/`;` chained commands,
 * and the inner text of process/command substitutions) and picking out the
 * meaningful command word of a segment.
 *
 * This is a simple lexical scanner, not a real shell parser: it does not
 * understand quoting well enough to avoid splitting inside a quoted string
 * that itself contains `;`/`|`/`&&`. In practice that "bug" is a feature for
 * a security classifier — e.g. `python3 -c "import os;os.remove(...)"` gets
 * split into two segments, and the second one (`os.remove(...)`) is what
 * lets the self-tamper gate see the protected path at all.
 *
 * What the plain cut cannot say is read beside it, by the lexer, which knows the quotes: where a
 * lone `&` ends a command, and each command as the shell reads its words (quotes and escapes off,
 * braces expanded, the name in lower case, a wildcard in its path read as the commands it could
 * name), added as segments of their own. The detectors match a pattern against all of them.
 */

import {
  newFunctionRoom,
  readFunctionCalls,
  type FunctionReadingTools,
  type FunctionRoom,
} from './function-readings.js';
import { argumentsOf, rawWords } from './function-arguments.js';
import type { FunctionDefinition } from './inlined-functions.js';
import { gitAliasBodies } from './git-aliases.js';
import { toolCommandBodies } from './git-commands.js';
import { programName } from './known-commands.js';
import { withKnownVariables } from './known-variables.js';
import { withLiteralSubstitutions } from './known-substitutions.js';
import {
  EVAL_ARG,
  GIT_FOREACH_OR_BISECT_RUN,
  extractArguments,
  extractFindExecCommands,
  extractShCStrings,
  extractTrapBodies,
  extractWindowsShellBodies,
  nestedBudget,
  type Budget,
} from './nested-extractors.js';
import { lex, withBackgroundEnded, type Lexed, type Nested } from './shell-lex.js';
import { globbedCommands, plainText } from './shell-plain.js';
import { bodyRanges, isFileWork, withoutRanges } from './text-heredocs.js';
import {
  commandDescribes,
  POSITIONAL_ARG_WRAPPERS,
  MAX_LOOKAHEAD,
  optionTakesValue,
  PREFIX_WORDS,
  replacesPositional,
  verbWrapperLength,
  verbWrapperNamed,
  wrapperNamed,
} from './shell-wrappers.js';

export { extractFindExecCommands };

// `>|` (and zsh's `>&|`) is a redirect that overwrites a file even under `noclobber`, not a pipe: split
// there, `echo x >| CLAUDE.md` came apart into `echo x >` and `CLAUDE.md`, and no
// segment held both the write and the file it wrote.
// `|&` is one operator, a pipe that carries the error output too: its `&` is not left to head the
// next command, where `curl x |& sh` would show a command called `&` and no shell after the fetch.
const PIPE = /(?<!>&?)\|&?/;
// A line break ends a command, unless an odd number of backslashes come before it: they join the lines.
const NEWLINE = String.raw`(?<!(?<!\\)\\(?:\\\\)*)\n`;
// A lone `&` ends a command as `;` does, but only a reading that knows the quotes can find it:
// see `withBackgroundEnded`, which writes it as `;` before the text is cut here.
const SEGMENT_SPLIT = new RegExp(String.raw`\|\||&&|(?<!>&?)\|&?|;|` + NEWLINE);

/** Shell keywords that are never a command word by themselves. */
export const SHELL_KEYWORDS = new Set([
  'do',
  'then',
  'else',
  'elif',
  'fi',
  'done',
  'in',
  'while',
  'until',
  'if',
  'for',
  'case',
  'esac',
  '{',
  '}',
  '(',
  ')',
  '!',
]);

const OPEN_SUBSTITUTIONS = ['<(', '>(', '$('];

/** Removes empty quote pairs (`""`, `''`) that shells drop before word-splitting. */
function stripEmptyQuotePairs(token: string): string {
  return token.replace(/""/g, '').replace(/''/g, '');
}

function matchingParenEnd(text: string, start: number): number {
  let depth = 1;
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * What a reading of a text's words can change: a quote, a backslash or a brace anywhere, and a capital
 * where the command is: in its first word, or in one of the first few after a word that runs another
 * command (`sudo RM`, `then GIT`). A parenthesis does not: `tokenize` takes it off a word.
 */
const SPELT = new RegExp(
  `['"\\\\{]|^\\s*(?:[A-Za-z_]\\w*=\\S*\\s+)*(?:\\S*[A-Z]|(?:${[...PREFIX_WORDS, 'if', 'then', 'else', 'elif', 'while', 'until', 'do'].join('|')})\\b\\s+(?:\\S+\\s+){0,6}\\S*[A-Z])`,
);

/**
 * The text as the words it holds, for comparing a reading of them with the text: no white space,
 * and one kind of quote. `echo "a b"` and `echo 'a b'` are the same words, and so are `(rm x)` and `( rm x )`.
 */
const wordsOf = (text: string): string => text.replace(/\s+/g, '').replace(/"/g, "'");

/**
 * The words of a text as the shell reads them (see `plainText`), or null where that is the text
 * as it is written, or where the budget for such readings is spent: a command made to be read at
 * length is asked about, not read in part.
 */
function plainReading(text: string, budget: Budget): string | null {
  if (!SPELT.test(text)) return null;
  if (text.length > budget.remaining) {
    budget.exceeded = true;
    return null;
  }
  budget.remaining -= text.length;
  const plain = plainText(text);
  // A string quoted with the other quote is the same words: not another text to read.
  return plain === text || wordsOf(plain) === wordsOf(text) ? null : plain;
}

/**
 * The commands of a text as the shell reads their words (see `plainText`), where that is not how
 * they are written: a pattern that looks for `git reset` finds `git "re""set" --hard`, and the command
 * of a `case` arm or after a `do` is found where it stands. The lexer cuts the text where a shell
 * does; where it was not sure it read it, the plain cut is read instead, which cuts a quote in two.
 */
function plainReadings(
  lexed: Lexed,
  plainCut: readonly (readonly string[])[],
  state: Readings,
): { readonly segments: string[]; readonly pipelines: string[][] } {
  const { budget, memo, emitted } = state;
  const pipelines = lexed.uncertain
    ? plainCut
    : lexed.pipelines.map((stages) => stages.map((stage) => stage.text));
  const segments: string[] = [];
  const read: string[][] = [];
  // A text that is read again with a variable put in differs from the first in a stage or two: a stage
  // that was read is not read again, nor added again.
  const reading = (stage: string): string | null => {
    const known = memo.get(stage);
    if (known !== undefined) return known;
    const found = plainReading(stage, budget);
    memo.set(stage, found);
    if (found !== null && !emitted.has(found)) {
      emitted.add(found);
      segments.push(found);
    }
    for (const globbed of globbedReadings(stage, budget))
      if (!emitted.has(globbed)) {
        emitted.add(globbed);
        segments.push(globbed);
      }
    return found;
  };
  for (const stages of pipelines) {
    const plain = stages.map(reading);
    if (plain.every((text) => text === null)) continue;
    read.push(stages.map((stage, i) => plain[i] ?? stage));
  }
  return { segments, pipelines: read };
}

/** What the readings of one command's stages share: the budget, and which stages were read. */
interface Readings {
  readonly budget: Budget;
  readonly memo: Map<string, string | null>;
  readonly emitted: Set<string>;
}

/** A path with a wildcard in its last part: where a stage may run a command it does not name. */
const GLOBBED_PATH = /\/[^\s/]*[*?[]/;

/**
 * The stage as each known command its command word could name, where a wildcard is in that word:
 * `/bin/r[m] -rf ~` is read as `rm -rf ~`. Where the word could name too many, the stage is asked about.
 */
function globbedReadings(stage: string, budget: Budget): string[] {
  if (!GLOBBED_PATH.test(stage)) return [];
  // Out of budget, the stage is not read: it is asked about.
  if (stage.length > budget.remaining) {
    budget.exceeded = true;
    return [];
  }
  budget.remaining -= stage.length;
  const found = globbedCommands(stage);
  if (found.broad) budget.exceeded = true;
  return found.texts;
}

/** The text of a command that runs inside another, as the shell hands it on. */
function bodyOf(command: string, nested: Nested): string {
  const body = command.slice(nested.from, nested.to);
  return nested.backtick ? body.replace(/\\([`$\\])/g, '$1') : body;
}

/**
 * The text of each command that runs inside another: `$( … )`, `<( … )`, `>( … )` and backtick
 * pairs, found where the shell runs them: among the words, inside double quotes, in a parameter
 * expansion and in a here-document that expands; not in a quote, a comment or a here-document
 * that does not. One level: what runs inside one of them is found when its own text is read.
 */
export function extractSubstitutions(command: string, lexed: Lexed = lex(command)): string[] {
  const results = lexed.nested.map((nested) => bodyOf(command, nested));
  // Where the reading lost track of the text (a quote that never closes), the shell may still run
  // what a `$(` it did not take for one holds: the plainer reading is added to it.
  if (lexed.uncertain) for (const body of plainSubstitutions(command)) results.push(body);
  return results;
}

/** Every `$(`, `<(`, `>(` and backtick pair, wherever it stands: more than the shell runs. */
function plainSubstitutions(command: string): string[] {
  const results: string[] = [];
  for (const open of OPEN_SUBSTITUTIONS) {
    let idx = command.indexOf(open);
    while (idx !== -1) {
      const start = idx + open.length;
      const end = matchingParenEnd(command, start);
      if (end === -1) break;
      results.push(command.slice(start, end));
      idx = command.indexOf(open, end + 1);
    }
  }
  // A loop, not `push(...)`: a command of backticks has more pairs than a call has arguments.
  for (const body of backtickBodies(command)) results.push(body);
  return results;
}

/**
 * The text of each backtick pair, as the shell reads it: a backslash before a backtick, a
 * dollar or a backslash is removed, and an escaped backtick does not close the pair, so
 * `echo \`echo \\\`rm -rf ~\\\`\`` is a command in a command.
 */
function backtickBodies(command: string): string[] {
  const results: string[] = [];
  let at = command.indexOf('`');
  while (at !== -1) {
    let end = -1;
    for (let i = at + 1; i < command.length; i += 1) {
      const ch = command.charAt(i);
      if (ch === '\\') i += 1;
      else if (ch === '`') {
        end = i;
        break;
      }
    }
    if (end === -1) break;
    results.push(command.slice(at + 1, end).replace(/\\([`$\\])/g, '$1'));
    at = command.indexOf('`', end + 1);
  }
  return results;
}

export function splitTop(command: string): string[] {
  return command
    .split(SEGMENT_SPLIT)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** `;`, `&&`, `||` and a newline start a new command; only `|` continues one. */
const SEQUENCE_SPLIT = new RegExp(String.raw`\|\||&&|;|` + NEWLINE);

/**
 * The same top-level split, but grouped into PIPELINES.
 *
 * `splitSegments` cuts on `|`, `;`, `&&`, `||` and newline with one regex and keeps
 * no record of which it was, so `curl x.sh | sh` and `curl x.sh; sh` reach a
 * classifier as the same two segments. For most signals that does not matter — a
 * `rm -rf /` is dangerous however it was reached. For the two named after a pipe it
 * is the whole question: the first is a fetch executed, the second is a fetch and,
 * separately, a shell.
 *
 * Each extracted inner text (a substitution, an `sh -c` body, a `find -exec`) is its
 * own group, because its stages pipe into each other and not into the line that
 * contained it.
 */
function pipelinesOf(command: string): string[][] {
  return command
    .split(SEQUENCE_SPLIT)
    .map((run) =>
      run
        .split(PIPE)
        .map((stage) => stage.trim())
        .filter((stage) => stage.length > 0),
    )
    .filter((stages) => stages.length > 0);
}

export function splitPipelines(command: string): string[][] {
  return splitCommand(command).pipelines;
}

/**
 * Splits a raw command into segments: top-level pipeline/chain segments plus
 * the (further-split) inner text of any process/command substitutions,
 * backtick expressions, `sh -c '...'` string bodies, `find -exec ... \;`
 * commands, `eval <arg>` arguments and `git submodule foreach <cmd>` /
 * `git bisect run <cmd>` tails found anywhere in the command.
 */
export function splitSegments(command: string): string[] {
  return splitCommand(command).segments;
}

const NO_FUNCTIONS = { found: [], unread: false, definitions: [] } as const;

/** What the reading of functions needs of a command's texts. */
function functionTools(
  lexes: Map<string, Lexed>,
  budget: Budget,
  limit: number,
): FunctionReadingTools {
  return {
    lexed: (text) => lexedIn(lexes, text),
    nested: (text) => nestedTexts(text, budget, lexes),
    withVariables: (text) => withKnownVariables(text, lexedIn(lexes, text), limit),
  };
}

/** A command cut into segments and into pipelines, from one pass over what it nests. */
export interface SplitCommand {
  readonly segments: string[];
  readonly pipelines: string[][];
  /** The nested arguments, or the readings of the words, outgrew their budget: not all of them are here. */
  readonly truncated: boolean;
  /** A function that the command defines is called in a way that is not read (see `withInlinedFunctions`). */
  readonly functionsUnread: boolean;
  /** The functions in force in the command: those it defines, and those it was given. */
  readonly functions: readonly FunctionDefinition[];
  /** What the reading of functions has left to spend on the command, which the programs read from it share. */
  readonly room: FunctionRoom;
  /** How many of `segments`, from the start, are the command's own top level. */
  readonly topLevel: number;
  /**
   * The command and each text nested in it (`sh -c` bodies, substitutions, `eval` arguments),
   * whole: a reader that has to see how its stages connect cannot work from the segments, which
   * are cut where the connection was.
   */
  readonly texts: readonly string[];
}

/**
 * `splitSegments` and `splitPipelines` together: the nested texts are extracted
 * once for both, and whether the budget cut them short is reported rather than
 * hidden, so the caller can say it could not read the whole command.
 */
/** The most texts, the command and what is nested in it, that are read a second time with what they set. */
const MAX_VARIANT_SOURCES = 64;
/** How many levels of commands inside commands are read: `a $(b $(c $(d)))`. */
const MAX_NESTING = 4;
/** What may hold a command inside a text: a substitution, a `-c` string, `eval`, `-exec`, `trap`. */
const MAY_NEST =
  /\$\(|[<>]\(|`|\s-c\s|\beval\b|-exec|\btrap\b|\bforeach\b|\bbisect\b|[/-]c(?:ommand)?\s|\brebase\b|\bdifftool\b|open-files-in-pager|_COMMAND=|EDITOR=|PAGER=|BROWSER=|ASKPASS=|GIT_SSH=|EXTERNAL_DIFF=|VISUAL=/i;

/** The reading of a text, made once: a text a command nests is read for its commands and then cut. */
function lexedIn(lexes: Map<string, Lexed>, text: string): Lexed {
  let lexed = lexes.get(text);
  if (lexed === undefined) {
    lexed = lex(text);
    lexes.set(text, lexed);
  }
  return lexed;
}

/** The commands one text holds: substitutions, `-c` strings, `find -exec`, `eval`, `trap`, … */
function nestedOnce(command: string, budget: Budget, lexed: Lexed): string[] {
  return [
    ...extractSubstitutions(command, lexed),
    ...extractShCStrings(command),
    ...extractFindExecCommands(command),
    ...extractArguments(command, EVAL_ARG, budget),
    ...extractArguments(command, GIT_FOREACH_OR_BISECT_RUN, budget),
    ...extractTrapBodies(command, budget),
    ...extractWindowsShellBodies(command),
    ...gitAliasBodies(command, lexed),
    ...toolCommandBodies(command, lexed),
  ];
}

/**
 * Every text nested in the command, a level at a time and each once: `echo $(echo $(rm -rf ~))`
 * runs the inner command as surely as the outer. Past `MAX_NESTING` levels, a text that still
 * holds a command is not read, and the budget says so.
 */
function nestedTexts(command: string, budget: Budget, lexes: Map<string, Lexed>): string[] {
  const seen = new Set<string>([command]);
  const all: string[] = [];
  let level = [command];
  for (let depth = 0; depth < MAX_NESTING && level.length > 0; depth += 1) {
    const next: string[] = [];
    for (const text of level) {
      for (const found of nestedOnce(text, budget, lexedIn(lexes, text))) {
        if (seen.has(found)) continue;
        seen.add(found);
        all.push(found);
        next.push(found);
      }
    }
    level = next;
  }
  if (level.some((text) => MAY_NEST.test(text))) budget.exceeded = true;
  return all;
}

/**
 * A command cut into segments and pipelines. The bodies of the here-documents of a command of plain
 * file work are text, not commands (see `text-heredocs.ts`): the command is read with them taken out,
 * and as it was written when anything in it is not plain file work.
 */
export function splitCommand(
  command: string,
  given: readonly FunctionDefinition[] | null = [],
  room: FunctionRoom = newFunctionRoom(command.length),
): SplitCommand {
  if (!command.includes('<<')) return splitWhole(command, given, room).split;
  const own = new Map<string, Lexed>();
  const ranges = bodyRanges(command, (text) => lexedIn(own, text));
  if (ranges.length === 0) return splitWhole(command, given, room).split;
  const masked = splitWhole(withoutRanges(command, ranges), given, room);
  return isFileWork(masked.split.texts, (text) => lexedIn(masked.lexes, text))
    ? masked.split
    : splitWhole(command, given, room).split;
}

function splitWhole(
  command: string,
  given: readonly FunctionDefinition[] | null,
  room: FunctionRoom,
): {
  readonly split: SplitCommand;
  readonly lexes: Map<string, Lexed>;
} {
  const budget: Budget = { remaining: nestedBudget(command), exceeded: false };
  const lexes = new Map<string, Lexed>();
  const nested = nestedTexts(command, budget, lexes);
  // The line as the shell that runs it would expand the variables it sets to a literal: a command
  // word that is a variable names no command, and the line holds what it is.
  const seen = new Set<string>([command, ...nested]);
  // And with each substitution that only prints a literal put where it stands (`$(echo rm) -rf ~`),
  // and then with the variables that set (`x=$(echo rm); $x -rf ~`): in the command, and in each text
  // nested in it (`bash -c 'c=rm; $c -rf ~'`, the body of `$( … )`).
  const limit = nestedBudget(command);
  const variantsOf = (text: string): string[] => {
    const lexedText = lexedIn(lexes, text);
    const literal = withLiteralSubstitutions(text, lexedText);
    return literal === null
      ? withKnownVariables(text, lexedText, limit)
      : [
          literal,
          ...withKnownVariables(text, lexedText, limit),
          ...withKnownVariables(literal, lexedIn(lexes, literal), limit),
        ];
  };
  // The texts that are the command with some of its variables put in, apart from the ones it holds: a function
  // that the command defines is defined by the command, and its copies with a loop's variable put in are the same
  // function, which must not be five functions of one name (see `readFunctionCalls`).
  const copies = new Set<string>();
  for (const source of [command, ...nested].slice(0, MAX_VARIANT_SOURCES)) {
    for (const variant of variantsOf(source)) {
      for (const text of [variant, ...nestedTexts(variant, budget, lexes)])
        if (!seen.has(text)) {
          seen.add(text);
          nested.push(text);
          copies.add(text);
        }
    }
  }
  // And with each call of a function that the command defines put in place as the body it runs, with
  // the words it is given where it uses them (`g() { git "$@"; }; g rebase -x '…'`), in the command
  // and in every text read from it (`echo $(g -rf ~)`). A text that is only an approximation of a
  // program (a script, read with its variables replaced) is not read for them: `given` is null.
  const functions =
    given === null
      ? NO_FUNCTIONS
      : readFunctionCalls(
          [command, ...nested],
          limit,
          functionTools(lexes, budget, limit),
          given,
          room,
          copies,
        );
  for (const text of functions.found)
    if (!seen.has(text)) {
      seen.add(text);
      nested.push(text);
    }
  // Cut where the shell cuts: a lone `&` ends a command, however it is spaced (`sleep 1&rm -rf ~`).
  const ended = (text: string): string => withBackgroundEnded(text, lexedIn(lexes, text));
  const plainBudget: Budget = { remaining: nestedBudget(command), exceeded: false };
  const readings: Readings = { budget: plainBudget, memo: new Map(), emitted: new Set() };
  const read = (text: string): { segments: string[]; pipelines: string[][] } => {
    const cut = ended(text);
    const pipelines = pipelinesOf(cut);
    const plain = plainReadings(lexedIn(lexes, text), pipelines, readings);
    const top = splitTop(cut).map(foldCommandWord);
    return {
      segments: [...top, ...plain.segments, ...stagesNotCut(lexedIn(lexes, text), top)],
      pipelines: [...pipelines, ...plain.pipelines],
    };
  };
  const own = read(command);
  const inside = nested.map(read);
  return {
    lexes,
    split: {
      segments: [...own.segments, ...inside.flatMap((found) => found.segments)],
      pipelines: [...own.pipelines, ...inside.flatMap((found) => found.pipelines)],
      truncated: budget.exceeded || plainBudget.exceeded,
      functionsUnread: functions.unread,
      functions: functions.definitions,
      room,
      topLevel: own.segments.length,
      texts: [command, ...nested],
    },
  };
}

/**
 * What comes before the command in a segment that is an arm of `case`: the header where the arm is on the same
 * line (`case x in`), and the pattern with its `)` (`x)`, `(x)`, `*)`).
 */
const CASE_ARM_PREFIX = /^(?:case\s+(?:"[^"]*"|'[^']*'|\S+)\s+in\s+)?\(?[^\s()]*\)\s+/;
/** What zsh allows before the command of a compound command whose body is in braces: `if true { cmd }`, `for x (a b) { cmd }`. */
const ZSH_BRACE_PREFIX = /^(?:if|elif|while|until|for|foreach|select|repeat)\b[^{}]*\{\s+/;

/**
 * The commands of the arms of `case` without what stands before them. A segment is cut at `;` and `|` and no
 * more, so the command of an arm (`x) git clone ext::… y`) has its pattern in front of it, and a detector that
 * finds a program by the first word of a segment found `x)` or `case` and not `git`.
 */
/**
 * The commands that the lexer cuts and the plain cut does not: the command of an arm of `case` without its
 * pattern, and the body of a zsh compound command in braces without what stands before it. The lexer knows the
 * quotes, so a pattern inside a string (`"(5) rm -rf x"`) is no arm: a command that the plain cut gives with a
 * pattern before it is one only where the lexer cuts the same command (`x) crontab -r` and the stage `crontab -r`),
 * and the body in braces is taken from the stages themselves.
 */
function stagesNotCut(lexed: Lexed, cut: readonly string[]): string[] {
  if (lexed.uncertain) return [];
  const stages = lexed.pipelines.flatMap((stages) =>
    stages.map((stage) => foldCommandWord(stage.text.trim())),
  );
  const staged = new Set(stages);
  const known = new Set(cut);
  const found = new Set<string>();
  for (const arm of armCommands(cut)) if (staged.has(arm) && !known.has(arm)) found.add(arm);
  for (const body of armCommands(stages)) if (!known.has(body)) found.add(body);
  return [...found];
}

export function armCommands(segments: readonly string[]): string[] {
  const found: string[] = [];
  for (const segment of segments) {
    const prefix = CASE_ARM_PREFIX.exec(segment) ?? ZSH_BRACE_PREFIX.exec(segment);
    if (prefix === null) continue;
    const command = segment.slice(prefix[0].length).trim();
    if (command !== '') found.push(foldCommandWord(command));
  }
  return found;
}

function stripBackslashes(token: string): string {
  return token.replace(/\\/g, '');
}

/**
 * Splits a segment into whitespace-delimited tokens, stripping empty quote
 * pairs and backslashes from each token first. Shared by every detector that
 * needs to inspect a segment's raw argument list (command-word resolution,
 * the `rm` target check, the unknown-wrapper network scan) so a
 * backslash-escaped command name (`\rm`, `cu\rl`) is recognised the same way
 * everywhere.
 */
export function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  for (const raw of segment.split(/\s+/)) {
    // Most words hold no quote, escape or parenthesis, and are what they were: this runs for every
    // word of every segment, once for each detector that reads one.
    if (!HAS_SPELLING.test(raw)) {
      tokens.push(raw);
      continue;
    }
    for (const piece of ungrouped(raw))
      tokens.push(
        HAS_QUOTE.test(piece)
          ? stripBackslashes(stripWordQuotes(stripEmptyQuotePairs(piece)))
          : piece,
      );
  }
  return tokens;
}

/** What a word's reading takes off: a quote, a backslash, a parenthesis. */
const HAS_SPELLING = /['"\\()]/;
/** What `stripEmptyQuotePairs`, `stripWordQuotes` and `stripBackslashes` take off. */
const HAS_QUOTE = /['"\\]/;

/** A word a shell reads after one of these is a command, though a `(` is written against it. */
const BEFORE_SUBSHELL = /(?:if|then|else|elif|while|until|do|time|!)(?=\()/y;

/** The keyword that stands against a parenthesis at `at` in the token, or null. */
function keywordAt(token: string, at: number): string | null {
  BEFORE_SUBSHELL.lastIndex = at;
  return BEFORE_SUBSHELL.exec(token)?.[0] ?? null;
}

/**
 * The words of one token and the parentheses of a subshell that stand against them: `(rm` is `(` and
 * `rm`, and `~)` is `~` and `)`, so `(rm -rf ~)` runs `rm` and `if(rm -rf ~)` does too, and so does
 * `(if(rm`, a subshell that holds a keyword that holds one. A `)` that has a `(` of its own in the
 * token stays (`f()`, `a=(b)`), and a quoted word starts with its quote.
 */
function ungrouped(token: string): string[] {
  // The word with no parenthesis at its start or its end, as most are, is the word.
  if (token.charAt(0) !== '(' && token.indexOf(')') === -1 && keywordAt(token, 0) === null)
    return [token];
  const lead: string[] = [];
  let start = 0;
  for (;;) {
    if (token.charAt(start) === '(') {
      while (token.charAt(start) === '(') start += 1;
      lead.push('(');
      continue;
    }
    const keyword = keywordAt(token, start);
    if (keyword === null) break;
    lead.push(keyword);
    start += keyword.length;
  }
  let opens = 0;
  let closes = 0;
  for (let i = start; i < token.length; i += 1) {
    const ch = token.charAt(i);
    if (ch === '(') opens += 1;
    else if (ch === ')') closes += 1;
  }
  let end = token.length;
  while (end > start && closes > opens && token.charAt(end - 1) === ')') {
    end -= 1;
    closes -= 1;
  }
  if (start === 0 && end === token.length) return [token];
  return [
    ...lead,
    ...(end > start ? [token.slice(start, end)] : []),
    ...(end < token.length ? [')'] : []),
  ];
}

/**
 * The quotes of a word that holds both of them: `"rm" -rf ~` runs `rm`, and `rm "-rf"` is the
 * flag. A word cut at a space inside its quotes (`"a`, `b"`) has only one and is left as it is.
 */
function stripWordQuotes(token: string): string {
  return token.replace(
    /"([^"]*)"|'([^']*)'/g,
    (_pair, double?: string, single?: string) => double ?? single ?? '',
  );
}

/**
 * Returns the base command word of a segment, skipping env assignments,
 * shell keywords (`do`, `then`, …) and wrapper prefixes (`sudo`, `nice -n 5`,
 * …), and stripping empty quote pairs from each token first so `c""url`
 * resolves to `curl`.
 */
/**
 * The segment with its command word in lower case: a file system that does not tell `RM` from
 * `rm` (the default on a Mac, and on Windows) runs both, and the classifier reads names in lower.
 */
function foldCommandWord(segment: string): string {
  return segment.replace(
    /^(\s*(?:[A-Za-z_]\w*=\S*\s+)*)([A-Za-z][\w.+]*)(?=\s|$)/,
    (_all, lead: string, word: string) => `${lead}${programName(word)}`,
  );
}

/** The operator of a redirect, which stands alone (`> file`) or has its target with it (`>file`, `2>&1`). */
const LEADING_REDIRECT = /^(?:\d*|&|\{[A-Za-z_]\w*\})(?:>\||>>?&?|<<<|<<-?|<&?|<>)/;

/**
 * The segment without its redirects where a cut at blanks cannot tell them from the words of the command: a quoted
 * word for a target (`> "/tmp/my out.log" crontab -r`, `<<< 'x y' crontab`) and a named descriptor (`{fd}>f crontab`).
 * Where there is none, the redirects are read as the words they are (see `LEADING_REDIRECT`).
 */
function withoutQuotedRedirects(segment: string): string {
  if (!/[<>]/.test(segment) || !/['"]|\{[A-Za-z_]\w*\}[<>]/.test(segment)) return segment;
  return argumentsOf(rawWords(segment)).join(' ');
}

export function commandWord(segment: string): string {
  const tokens = tokenize(withoutQuotedRedirects(segment));
  let wrapper = '';
  let needsPositional = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? '';
    if (token === '' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
    if (SHELL_KEYWORDS.has(token)) continue;
    // A redirect that stands before the command (`> /dev/null crontab -r`) is not it, nor is its target.
    const redirect = LEADING_REDIRECT.exec(token);
    if (redirect !== null) {
      if (redirect[0].length === token.length) i += 1;
      continue;
    }
    const named = wrapperNamed(token);
    // `command -v at` looks `at` up and runs nothing: `command` is the command.
    if (named === 'command' && commandDescribes(tokens.slice(i + 1, i + 1 + MAX_LOOKAHEAD)))
      return 'command';
    if (named !== null) {
      wrapper = named;
      needsPositional = POSITIONAL_ARG_WRAPPERS.has(named);
      continue;
    }
    // `direnv exec DIR cmd`, `mise exec -- cmd`, `uv run cmd`: past the verb.
    const verbWrapper = verbWrapperNamed(token);
    const verbLength =
      verbWrapper === null
        ? null
        : verbWrapperLength(verbWrapper, tokens.slice(i + 1, i + 1 + MAX_LOOKAHEAD));
    if (verbLength !== null) {
      i += verbLength;
      needsPositional = false;
      continue;
    }
    if (token.startsWith('-')) {
      if (replacesPositional(wrapper, token)) needsPositional = false;
      if (optionTakesValue(wrapper, token)) i += 1;
      continue;
    }
    if (needsPositional) {
      needsPositional = false;
      continue;
    }
    // A name is the one it is on a file system that does not tell `RM` from `rm`.
    return token.replace(/^.*\//, '').toLowerCase();
  }
  return '';
}

/**
 * Returns the first non-flag argument after the command word — the
 * "subcommand" for CLIs like `gh api`, `aws s3`, `docker push`. Used to
 * detect network-ish subcommands of otherwise-benign wrapper CLIs.
 */
export function firstArgAfter(segment: string): string {
  const tokens = tokenize(withoutQuotedRedirects(segment));
  let wrapper = '';
  let needsPositional = false;
  let sawCommand = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? '';
    if (token === '' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
    if (SHELL_KEYWORDS.has(token)) continue;
    const redirect = LEADING_REDIRECT.exec(token);
    if (redirect !== null) {
      if (redirect[0].length === token.length) i += 1;
      continue;
    }
    if (!sawCommand) {
      const named = wrapperNamed(token);
      if (named === 'command' && commandDescribes(tokens.slice(i + 1, i + 1 + MAX_LOOKAHEAD))) {
        sawCommand = true;
        continue;
      }
      if (named !== null) {
        wrapper = named;
        needsPositional = POSITIONAL_ARG_WRAPPERS.has(named);
        continue;
      }
      const verbWrapper = verbWrapperNamed(token);
      const verbLength =
        verbWrapper === null
          ? null
          : verbWrapperLength(verbWrapper, tokens.slice(i + 1, i + 1 + MAX_LOOKAHEAD));
      if (verbLength !== null) {
        i += verbLength;
        needsPositional = false;
        continue;
      }
      if (token.startsWith('-')) {
        if (replacesPositional(wrapper, token)) needsPositional = false;
        if (optionTakesValue(wrapper, token)) i += 1;
        continue;
      }
      if (needsPositional) {
        needsPositional = false;
        continue;
      }
      sawCommand = true;
      continue;
    }
    if (token.startsWith('-')) continue;
    return token.replace(/^.*\//, '');
  }
  return '';
}
