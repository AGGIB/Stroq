import { checkDeadline } from './deadline.js';
import {
  SHELL_WORDS,
  mentionsShellWord,
  newLexState,
  readBodies,
  readOpener,
  scanExpansions,
  skipAnsiC,
  skipBacktick,
  skipDollar,
  skipDouble,
  skipSingle,
  skipSubstitution,
  startsComment,
  type HeredocOpen,
  type LexState,
  type Nested,
  type Region,
} from './shell-skip.js';

export {
  SHELL_STARTERS,
  SHELL_WORDS,
  SHELL_WORD_ANYWHERE,
  mentionsShellWord,
  newLexState,
  skipSubstitution,
} from './shell-skip.js';
export type { LexState, Nested, Region } from './shell-skip.js';

/**
 * A reading of shell text that cuts it into pipelines and stages the way a shell does, and that
 * says so when it is not sure it read it right.
 *
 * It is not a shell. It knows quotes, `$'…'`, substitutions, parameter expansions, backticks,
 * comments, here-documents, `[[ ]]`, `(( ))` and `case` arms, and nothing else, and it keeps each
 * of them from being mistaken for a pipe. Everything it is unsure of sets `uncertain`, and the
 * caller answers with a question rather than a guess. One pass, no backtracking over what it has
 * read: the hook has one thread, and a host that times it out treats that as an allow.
 */

/** The blanks of a shell: a space, a tab and a line break. Other characters are part of a word. */
export const isSpace = (code: number): boolean => code === 32 || code === 9 || code === 10;

export interface Heredoc {
  readonly body: string;
  /** The delimiter was quoted, so the body is literal text: nothing in it is expanded. */
  readonly quoted: boolean;
}

export interface Stage {
  readonly text: string;
  /** Where in the command the stage begins. */
  readonly at: number;
  /** A single `|` (or `|&`) joins this stage to the one before it. */
  readonly piped: boolean;
  /** A lone `&` ends the stage: it runs in the background, in a subshell of its own. */
  readonly background: boolean;
  /** The here-document this stage was given, when it was given one. */
  readonly heredoc: Heredoc | null;
  /** A compound command that begins a stage handed a pipe: its body inherits that input. */
  readonly compound: boolean;
}

/** A here-document body that is text (its delimiter was quoted), and the stage that was given it. */
export interface HeredocBody {
  readonly range: Region;
  readonly stage: Stage;
  /** Its delimiter is a plain word, written plainly, which every shell reads as the same one (`HeredocOpen.plain`). */
  readonly plain: boolean;
}

export interface Lexed {
  readonly pipelines: readonly (readonly Stage[])[];
  /** Something was left open or hard to read: a quote, a substitution, a heredoc that never ends. */
  readonly uncertain: boolean;
  /** Where each `|` that was read as a pipe stands in the text. */
  readonly pipes: ReadonlySet<number>;
  /** Where each lone `&` that ends a command, which then runs in the background, stands. */
  readonly ampersands: ReadonlySet<number>;
  /**
   * Stretches read as text that is not this command's own words: a here-document body, and a
   * substitution or backtick pair, whose commands are read as texts of their own. Sorted.
   */
  readonly regions: readonly Region[];
  /**
   * The range of each here-document body whose delimiter was quoted (without the delimiter line that
   * ends it), in the order its opener comes: text, with nothing in it expanded. A body that expands
   * runs the commands in it, and is not here. It is text for the command that is given it, and a
   * program for a shell.
   */
  readonly heredocBodies: readonly HeredocBody[];
  /**
   * The text holds a construct that the shells read in ways of their own (`LexState.ambiguous`): a body
   * that this reading takes for text may be commands to one of them, and none is taken for text.
   */
  readonly ambiguous: boolean;
  /**
   * The commands that run inside this text, outermost only, wherever the shell runs them: among its
   * words, in double quotes, in a parameter expansion, in a here-document that expands. A quote, a
   * comment and the body of a here-document that does not expand hold none.
   */
  readonly nested: readonly Nested[];
}

// -------------------------------------------------------------------------------------------
// Constructs that hold a `|` that is not a pipe, or text that is not a command
// -------------------------------------------------------------------------------------------

/** `case WORD in`, at the start of a command: after it, arms begin with a pattern list. */
const CASE_HEADER = /case\s+(?:"[^"]*"|'[^']*'|[^\s;&|]+)\s+in(?=\s|$)/y;
/** Where `[[ … ]]` and `(( … ))` end: the closing token, after white space. */
const TEST_CLOSE = /\s\]\](?=[\s;&|)]|$)/g;
const ARITHMETIC_CLOSE = /\s\)\)(?=[\s;&|)]|$)/g;
/** The characters of a `case` pattern: a word, a glob, a class. */
const PATTERN_CHAR = /[\w.*?[\]!^/-]/;
/** Words after which a command position follows, so `[[` there opens a test. */
const COMMAND_KEYWORDS: ReadonlySet<string> = new Set([
  '{',
  '(',
  'if',
  'elif',
  'while',
  'until',
  'then',
  'do',
  'else',
  '!',
  'time',
]);
/** Words that open a compound command. */
const COMPOUND_OPENERS = /^(?:\{|\(|while\b|until\b|for\b|if\b|case\b|select\b)/;

interface PendingHeredoc extends HeredocOpen {
  readonly pipeline: number;
  readonly stage: number;
}

/** What the pass has read so far, and where in the current stage it stands. */
interface Scan {
  readonly text: string;
  readonly state: LexState;
  readonly pipelines: Stage[][];
  stages: Stage[];
  readonly pending: PendingHeredoc[];
  readonly bodies: Map<string, Heredoc>;
  readonly pipes: Set<number>;
  readonly ampersands: Set<number>;
  readonly regions: Region[];
  readonly bodyRanges: {
    readonly range: Region;
    readonly pipeline: number;
    readonly stage: number;
    readonly plain: boolean;
  }[];
  /** Where the current stage begins. */
  start: number;
  /** Where a comment cut the current stage short, or -1. */
  stageEnd: number;
  /** Nothing but white space has been seen in the current stage. */
  blank: boolean;
  /** The current stage is joined to the one before it by a pipe. */
  piped: boolean;
  /** How many `case` statements are open: their arms begin with a pattern list. */
  arms: number;
  /** For each open `case`, whether it was handed a pipe: what its arms run reads that input. */
  handed: boolean[];
  /** The next word begins an arm: right after `case … in` or `;;`, where `(bash)` is a pattern. */
  patternNext: boolean;
  /** A pattern list was looked for and none ends before here: none begins before it either. */
  patternFailsBefore: number;
  /** A `[[` (or `((`) was looked for and no closer was found: none will be after it either. */
  noTestClose: boolean;
  noArithmeticClose: boolean;
  /** The last character that was not white space and not read as a whole, for `2>&1` and `>|`. */
  last: string;
}

function newScan(text: string): Scan {
  return {
    text,
    state: newLexState(),
    pipelines: [],
    stages: [],
    pending: [],
    bodies: new Map(),
    pipes: new Set(),
    ampersands: new Set(),
    regions: [],
    bodyRanges: [],
    start: 0,
    stageEnd: -1,
    blank: true,
    piped: false,
    arms: 0,
    handed: [],
    patternNext: false,
    patternFailsBefore: -1,
    noTestClose: false,
    noArithmeticClose: false,
    last: '',
  };
}

/**
 * A stage that begins a compound command (`{ :`, `while read x`, `(cat`) hands its input to what is
 * inside. A subshell that is only one command, `(bash)`, is cut whole and is that command.
 */
function isCompound(piece: string): boolean {
  if (!COMPOUND_OPENERS.test(piece)) return false;
  if (!piece.startsWith('(') || !piece.endsWith(')')) return true;
  let depth = 0;
  for (const ch of piece) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if (depth === 0 && ch === ')') return piece.indexOf(')') !== piece.length - 1;
  }
  return true;
}

/** Closes the current stage at `end`, unless it is empty; `background` when a lone `&` ended it. */
function cut(scan: Scan, end: number, background = false): void {
  const to = scan.stageEnd === -1 ? end : Math.min(scan.stageEnd, end);
  const piece = scan.text.slice(scan.start, to).trim();
  if (piece !== '')
    scan.stages.push({
      text: piece,
      at: scan.start,
      piped: scan.piped,
      background,
      heredoc: null,
      compound: (scan.piped && isCompound(piece)) || scan.handed.includes(true),
    });
  scan.stageEnd = -1;
}

/** Begins a new stage at `next`. */
function begin(scan: Scan, next: number): void {
  scan.start = next;
  scan.blank = true;
}

function endPipeline(scan: Scan): void {
  if (scan.stages.length > 0) scan.pipelines.push(scan.stages);
  scan.stages = [];
  scan.piped = false;
}

/** The word before `at`, back no further than the stage start: where `[[` may follow a keyword. */
function previousWord(scan: Scan, at: number): string {
  let end = at;
  while (end > scan.start && isSpace(scan.text.charCodeAt(end - 1))) end -= 1;
  let from = end;
  while (from > scan.start && !isSpace(scan.text.charCodeAt(from - 1))) from -= 1;
  return scan.text.slice(from, end);
}

/**
 * What a test or an arithmetic holds is no separator, but it may run a command: `[[ $(rm -rf ~) ]]`
 * and `(( `rm -rf ~` ))` do. The quotes, substitutions and backticks in it are read between `from`
 * and `to` for the commands they hold.
 */
function readInside(scan: Scan, from: number, to: number): void {
  for (let j = from; j < to; j += 1) {
    const inert = skipInert(scan, j);
    if (inert !== -1) j = inert;
  }
}

/** `[[ … ]]` and `(( … ))` at a command position: the index of their last character, or -1. */
function skipTest(scan: Scan, i: number, atStart: boolean): number {
  const { text } = scan;
  const ch = text.charAt(i);
  if (ch !== '[' && ch !== '(') return -1;
  if (text.charAt(i + 1) !== ch || !isSpace(text.charCodeAt(i + 2))) return -1;
  if (ch === '[' ? scan.noTestClose : scan.noArithmeticClose) return -1;
  if (!atStart && !COMMAND_KEYWORDS.has(previousWord(scan, i))) return -1;
  const close = ch === '[' ? TEST_CLOSE : ARITHMETIC_CLOSE;
  close.lastIndex = i + 2;
  const found = close.exec(text);
  if (found !== null) {
    readInside(scan, i + 2, found.index);
    return found.index + found[0].length - 1;
  }
  // No closer after this opener means none after any later one: look no more.
  if (ch === '[') scan.noTestClose = true;
  else scan.noArithmeticClose = true;
  return -1;
}

/**
 * Whether a word that begins at `i` stands where a command may: at the start of a stage, or after
 * a keyword (`do case`, `then esac`). The word before is looked up only for a word that begins
 * there, so a long run of letters is not read back from each of them.
 */
function atCommand(scan: Scan, i: number, atStart: boolean): boolean {
  if (atStart) return true;
  const before = i === 0 ? ' ' : scan.text.charAt(i - 1);
  return isSpace(before.charCodeAt(0)) && COMMAND_KEYWORDS.has(previousWord(scan, i));
}

/**
 * The index after the pattern list of a `case` arm that begins at `i` (`a|b)`, `(a|b)`), or -1. A
 * list that does not end in `)` before the run of pattern characters and `|` does is no list, and
 * the run is remembered, so that each `|` of `a|a|a|…` does not read it again.
 */
function patternEnd(scan: Scan, i: number): number {
  const { text } = scan;
  if (i < scan.patternFailsBefore) return -1;
  let j = text.charAt(i) === '(' ? i + 1 : i;
  const first = j;
  while (j < text.length && (PATTERN_CHAR.test(text.charAt(j)) || text.charAt(j) === '|')) j += 1;
  if (j > first && text.charAt(j) === ')') return j + 1;
  scan.patternFailsBefore = j;
  return -1;
}

/** `case WORD in`, an arm's pattern list, and `esac`, at a command position: the last index, or -1. */
function skipCase(scan: Scan, i: number, atStart: boolean): number {
  const { text } = scan;
  const ch = text.charAt(i);
  if (ch === 'c' && text.startsWith('case', i) && atCommand(scan, i, atStart)) {
    CASE_HEADER.lastIndex = i;
    const header = CASE_HEADER.exec(text);
    if (header !== null) {
      scan.arms += 1;
      scan.handed.push(scan.piped);
      scan.patternNext = true;
      return i + header[0].length - 1;
    }
  }
  if (scan.arms === 0) return -1;
  if (ch === 'e' && text.startsWith('esac', i) && atCommand(scan, i, atStart)) {
    if (/^esac(?=[\s;&|)]|$)/.test(text.slice(i, i + 5))) {
      scan.arms -= 1;
      scan.handed.pop();
      return i + 3;
    }
  }
  if (atStart && scan.patternNext && (ch === '(' || PATTERN_CHAR.test(ch))) {
    const end = patternEnd(scan, i);
    if (end !== -1) {
      scan.patternNext = false;
      return end - 1;
    }
  }
  return -1;
}

/** The bodies of the here-documents the line just ended opened: attaches them, and moves past. */
function takeBodies(scan: Scan, lineEnd: number): number {
  const opens = scan.pending.slice();
  scan.pending.length = 0;
  const read = readBodies(scan.text, lineEnd + 1, opens);
  if (!read.closed) scan.state.uncertain = true;
  scan.regions.push([lineEnd + 1, read.end]);
  opens.forEach((open, n) => {
    const range = read.ranges[n];
    if (open.quoted && range !== undefined)
      scan.bodyRanges.push({
        range,
        pipeline: open.pipeline,
        stage: open.stage,
        plain: open.plain,
      });
    // A body that expands runs the commands in it; one whose delimiter was quoted does not.
    if (!open.quoted && range !== undefined)
      scanExpansions(scan.text, range[0], range[1], scan.state);
    const key = `${open.pipeline}:${open.stage}`;
    const kept = scan.bodies.get(key);
    scan.bodies.set(key, {
      body: `${kept?.body ?? ''}${read.bodies[n] ?? ''}`,
      quoted: (kept?.quoted ?? true) && open.quoted,
    });
  });
  return read.end;
}

/** A comment is not text of the stage, and does not end a pipe that goes on the next line. */
function skipComment(scan: Scan, i: number): number {
  if (scan.stageEnd === -1) scan.stageEnd = i;
  const eol = scan.text.indexOf('\n', i);
  return eol === -1 ? scan.text.length : eol - 1;
}

/** `<( … )`, `>( … )` and `$( … )`: the index of their last character, noted as a text of its own. */
function skipSubstituted(scan: Scan, i: number): number {
  const end = skipSubstitution(scan.text, i + 2, scan.state);
  scan.regions.push([i, end]);
  // `>( … )` is a pipe whose other end is the command written before it: a shell in it reads
  // what that command prints, which no reading of the stages connects.
  if (scan.text.charAt(i) === '>' && mentionsShellWord(scan.text.slice(i + 2, end - 1)))
    scan.state.uncertain = true;
  return end - 1;
}

/** Reads what holds no separator: a quote, a substitution, an expansion. -1 if none. */
function skipInert(scan: Scan, i: number): number {
  const { text, state } = scan;
  const ch = text.charAt(i);
  if (ch === '\\') return i + 1;
  if (ch === "'") return skipSingle(text, i, state) - 1;
  if (ch === '"') return skipDouble(text, i, state) - 1;
  if (ch === '`') {
    const end = skipBacktick(text, i, state);
    scan.regions.push([i, end]);
    return end - 1;
  }
  if ((ch === '$' || ch === '<' || ch === '>') && text.charAt(i + 1) === '(')
    return skipSubstituted(scan, i);
  if (ch !== '$') return -1;
  const end = skipDollar(text, i, state, false);
  return end === -1 ? -1 : end - 1;
}

/**
 * The operators that end or join stages. Returns the last index it used, or -1 if `i` is none.
 * `atStart`: nothing but white space came before `i` in the stage.
 */
function readOperator(scan: Scan, i: number, atStart: boolean): number {
  const { text } = scan;
  const ch = text.charAt(i);
  const two = text.slice(i, i + 2);
  if (two === '&&' || two === '||') {
    cut(scan, i);
    endPipeline(scan);
    begin(scan, i + 2);
    return i + 1;
  }
  // `>|` and zsh's `>&|` force a redirect over `noclobber`
  if (ch === '|' && (scan.last === '>' || (scan.last === '&' && text.charAt(i - 2) === '>')))
    return -1;
  if (ch === '|') {
    cut(scan, i);
    scan.pipes.add(i);
    const skip = text.charAt(i + 1) === '&' ? 1 : 0;
    scan.piped = true;
    begin(scan, i + 1 + skip);
    return i + skip;
  }
  if (ch === ';' || ch === '&') {
    // `2>&1`, `>&2`, `<&3` and `&>file` are redirects, not a separator.
    if (ch === '&' && (scan.last === '>' || scan.last === '<' || text.charAt(i + 1) === '>'))
      return -1;
    // After a command it sends that command to the background; where a command begins it is
    // PowerShell's call operator (`& ./clean.ps1`, `(& $tool)`), and ends nothing. Right after a
    // `;` it is none of these (`a;&b`), and is cut as a separator all the same.
    const begins = atStart && text.charAt(i - 1) !== ';';
    if (ch === '&' && !begins && scan.last !== '(' && scan.last !== '{') scan.ampersands.add(i);
    cut(scan, i, ch === '&');
    endPipeline(scan);
    begin(scan, i + 1);
    // `;;` ends an arm, and the next word begins another.
    if (ch === ';' && text.charAt(i - 1) === ';') scan.patternNext = true;
    return i;
  }
  return -1;
}

/** A line break: the end of a stage, or white space inside a pipe that goes on. Returns the last index. */
function readNewline(scan: Scan, i: number): number {
  if (scan.blank && scan.piped) {
    // The pipe goes on: a line break after `|` (or after only a comment) is white space. A body that
    // the line opened begins here all the same (`cat <<'EOF' |` and a line break), and is not the lines
    // of the pipe's next command.
    const end = scan.pending.length === 0 ? i + 1 : takeBodies(scan, i);
    scan.start = end;
    scan.stageEnd = -1;
    return end - 1;
  }
  cut(scan, i);
  endPipeline(scan);
  if (scan.pending.length === 0) {
    begin(scan, i + 1);
    return i;
  }
  const end = takeBodies(scan, i);
  begin(scan, end);
  return end - 1;
}

/** Reads the construct at `i`, if it is a here-document opener or a here-string. -1 if it is not. */
function readRedirect(scan: Scan, i: number): number {
  const { text } = scan;
  if (text.charAt(i) !== '<' || text.charAt(i + 1) !== '<') return -1;
  if (text.charAt(i + 2) === '<') return i + 2;
  const open = readOpener(text, i);
  if (open === null) {
    // `<<` that opens nothing this can read: what follows may be a body the shell skips.
    scan.state.uncertain = true;
    return i + 1;
  }
  scan.pending.push({ ...open, pipeline: scan.pipelines.length, stage: scan.stages.length });
  return open.end - 1;
}

/** Reads one step of the pass at `i`; returns the index of the last character it consumed. */
function step(scan: Scan, i: number): number {
  const { text } = scan;
  const ch = text.charAt(i);
  if (ch === '\\' && text.charAt(i + 1) === '\n') return i + 1; // joined lines: white space
  if (ch === '#') {
    if (startsComment(text, i, 0)) return skipComment(scan, i);
    // A `#` right after `)`, `<` or `>` is a comment to a shell that takes the character for an operator
    // that ends a word, and part of a word to one that does not: not a comment here, as the strict way
    // to be wrong, and a `<<` after it may be no opener to the shell that reads a comment.
    if (i > 0 && ')<>'.includes(text.charAt(i - 1))) scan.state.ambiguous = true;
  }
  const atStart = scan.blank;
  const space = isSpace(text.charCodeAt(i));
  if (!space) scan.blank = false;
  const inert = skipInert(scan, i);
  if (inert !== -1) {
    scan.last = ch;
    return inert;
  }
  const test = skipTest(scan, i, atStart);
  if (test !== -1) return test;
  // `((` that is not an arithmetic command with white space after it (`((true<<'EOF'))`): bash, zsh
  // and ksh read an arithmetic, in which `<<` is a shift, and dash reads two subshells.
  if (ch === '(' && text.charAt(i + 1) === '(') scan.state.ambiguous = true;
  const arm = skipCase(scan, i, atStart);
  if (arm !== -1) {
    // What stood before the header in this stage (`f() { `, `{ `) is a stage of its own, not lost.
    if (scan.text.slice(scan.start, i).trim() !== '') {
      cut(scan, i);
      endPipeline(scan);
    }
    begin(scan, arm + 1);
    return arm;
  }
  const redirect = readRedirect(scan, i);
  if (redirect !== -1) return redirect;
  const operator = readOperator(scan, i, atStart);
  if (operator !== -1) {
    scan.last = text.charAt(operator);
    return operator;
  }
  if (ch === '\n') return readNewline(scan, i);
  if (!space) scan.last = ch;
  return i;
}

/**
 * The pipelines of a command: its stages, cut at a `|` or `|&` outside quotes, where the next
 * stage is joined to the one before it, and its pipelines cut at `;`, `&&`, `||`, a lone `&`
 * and a line break that does not follow a pipe. A quoted string, `$'…'`, a substitution, a
 * parameter expansion, a backtick pair and a comment hold no separator, and a here-document's body
 * is not shell text: it is kept on the stage that was given it.
 */
export function lex(text: string): Lexed {
  checkDeadline();
  const scan = newScan(text);
  for (let i = 0; i < text.length; i += 1) i = step(scan, i);
  cut(scan, text.length);
  endPipeline(scan);
  if (scan.pending.length > 0) scan.state.uncertain = true;
  // Attach the bodies: each was keyed by the pipeline index and the stage it belonged to.
  return {
    uncertain: scan.state.uncertain,
    ambiguous: scan.state.ambiguous,
    nested: scan.state.nested,
    pipes: scan.pipes,
    ampersands: scan.ampersands,
    regions: scan.regions.slice().sort((a, b) => a[0] - b[0]),
    heredocBodies: scan.bodyRanges.flatMap(({ range, pipeline, stage, plain }) => {
      const found = scan.pipelines[pipeline]?.[stage];
      return found === undefined ? [] : [{ range, stage: found, plain }];
    }),
    pipelines: scan.pipelines.map((pipeline, p) =>
      pipeline.map((stage, s) => {
        const body = scan.bodies.get(`${p}:${s}`);
        return body === undefined ? stage : { ...stage, heredoc: body };
      }),
    ),
  };
}

/** The lone `&` of a text read without its quotes: the ones that stand after a command. */
function everyLoneAmpersand(text: string): number[] {
  const found: number[] = [];
  for (let i = text.indexOf('&'); i !== -1; i = text.indexOf('&', i + 1)) {
    const next = text.charAt(i + 1);
    const before = text.charAt(i - 1);
    if (next === '&' || next === '>' || '&><|'.includes(before)) continue;
    let back = i - 1;
    while (back >= 0 && (text.charAt(back) === ' ' || text.charAt(back) === '\t')) back -= 1;
    if (back >= 0 && !';|&({\n'.includes(text.charAt(back))) found.push(i);
  }
  return found;
}

/**
 * The text with each `&` that ends a command, which then runs in the background, written as `;`:
 * the same length, so every position stays. `sleep 1&rm -rf ~` runs both commands, and the cut that
 * makes a command's segments ignores quotes, so it cannot tell that `&` from the one in a quoted
 * `?a=1&b=2`. Where the lexer was not sure it read the text, every lone `&` ends a command, quoted or
 * not: the cut is then too fine, which only adds a segment, and not too coarse, which hides one.
 */
export function withBackgroundEnded(text: string, lexed: Lexed): string {
  const at = lexed.uncertain ? everyLoneAmpersand(text) : [...lexed.ampersands];
  if (at.length === 0) return text;
  const parts: string[] = [];
  let from = 0;
  for (const index of at) {
    parts.push(text.slice(from, index), ';');
    from = index + 1;
  }
  parts.push(text.slice(from));
  return parts.join('');
}

// -------------------------------------------------------------------------------------------
// The second reading
// -------------------------------------------------------------------------------------------

/** The words after a pipe that are read for a shell: the shell itself, behind a wrapper or two. */
const WORDS_AFTER_PIPE = 4;

/** Whether a `|` at `at` is followed, within a few words, by a shell word that ends where it ends. */
function pipesToShell(text: string, at: number): boolean {
  let i = at + 1;
  if (text.charAt(i) === '&') i += 1;
  for (let words = 0; words < WORDS_AFTER_PIPE; words += 1) {
    while (i < text.length && (isSpace(text.charCodeAt(i)) || text.charAt(i) === '\\')) i += 1;
    let end = i;
    while (
      end < text.length &&
      !isSpace(text.charCodeAt(end)) &&
      !';&|<>()'.includes(text.charAt(end))
    )
      end += 1;
    if (end === i) return false;
    const word = text.slice(i, end);
    const after = text.charAt(end);
    if (SHELL_WORDS.has(word.slice(word.lastIndexOf('/') + 1)))
      return after === '' || isSpace(after.charCodeAt(0)) || ';&<>'.includes(after);
    i = end;
  }
  return false;
}

/**
 * Whether a `|` into a shell stands in the text that the first reading did not take for a pipe.
 * That reading sets whole stretches aside as a test, an arithmetic, a `case` arm or an expansion,
 * and a pipe it set aside by mistake is a program nobody read. This is a second pass that has
 * none of those readings: quotes, comments and the stretches the first set aside as other texts
 * (substitutions and here-document bodies, read on their own), and every other `|` that is
 * followed by a shell word and was not read as a pipe is one the first reading lost. An
 * alternation in a pattern, `(bash|dash)`, is followed by `|` or `)`, which ends no stage.
 */
export function lostPipe(text: string, lexed: Lexed): boolean {
  const state = newLexState();
  let next = 0;
  for (let i = 0; i < text.length; i += 1) {
    while (next < lexed.regions.length && (lexed.regions[next] as Region)[1] <= i) next += 1;
    const region = lexed.regions[next];
    if (region !== undefined && region[0] <= i) {
      i = region[1] - 1;
      continue;
    }
    const ch = text.charAt(i);
    if (ch === '\\') i += 1;
    else if (ch === "'") i = skipSingle(text, i, state) - 1;
    else if (ch === '"') i = skipDouble(text, i, state) - 1;
    else if (ch === '$') {
      // `$'…'` and `$$`, decided at the dollar: a `$` another character escapes begins nothing.
      const following = text.charAt(i + 1);
      if (following === "'") i = skipAnsiC(text, i + 1, state) - 1;
      else if (following === '$') i += 1;
    } else if (ch === '#' && startsComment(text, i, 0)) {
      const eol = text.indexOf('\n', i);
      if (eol === -1) return false;
      i = eol - 1;
    } else if (ch === '|' && text.charAt(i + 1) === '|') i += 1;
    else if (ch === '|' && !lexed.pipes.has(i) && pipesToShell(text, i)) return true;
  }
  return false;
}
