/**
 * What a shell skips whole when it looks for the end of a command: a quoted string, `$'…'`, a
 * parameter expansion, a command substitution, a backtick pair, a comment, a here-document.
 *
 * Each function returns the index after what it skipped, and says so (`uncertain`) when what it
 * was skipping never ended or went deeper than it reads. They share one `LexState`, and every one
 * that can contain another is bounded by its depth: the hook has one thread, and a host that times
 * it out, or a stack that overflows, ends in a command nobody read.
 */

/** A stretch of the text, from the index and up to, not including, the second. */
export type Region = readonly [number, number];

/**
 * The text of a command that runs inside another: a `$( … )`, `<( … )` or `>( … )` and a backtick
 * pair, as the stretch between the delimiters. A backtick pair's text has its escapes still on it.
 */
export interface Nested {
  readonly from: number;
  readonly to: number;
  readonly backtick: boolean;
}

export interface LexState {
  /** Something was left open or hard to read: a quote, a substitution, a here-document. */
  uncertain: boolean;
  /**
   * The commands that run inside this text, found wherever the shell runs them: among the words,
   * inside double quotes, in a parameter expansion, in a here-document that expands. Only the
   * outermost: what runs inside one of them is found when its own text is read.
   */
  readonly nested: Nested[];
  /** How many substitutions the reading stands inside: what they hold is theirs to find. */
  substitutions: number;
  /** How many quotes, expansions and substitutions deep the reading stands. */
  depth: number;
  /** An old-style `$[` was looked for and no `]` closes any: none will after it either. */
  noBracketClose: boolean;
  /**
   * A construct was met that the shells read in ways of their own, where a here-document body may
   * be a command to one of them and text to another: `((cmd<<'EOF'))` (an arithmetic to bash, zsh
   * and ksh, in which `<<` is a shift, and two subshells to dash), a `#` right after `)`, `<` or `>`
   * (a comment to some, and a word to others), a `$'…'` string with `\'` in it (which dash reads as `$` and a
   * string that ends at the first quote). No body in such a text is taken for text.
   */
  ambiguous: boolean;
}

export const newLexState = (): LexState => ({
  uncertain: false,
  nested: [],
  substitutions: 0,
  depth: 0,
  noBracketClose: false,
  ambiguous: false,
});

/** Nested constructs deeper than this are not read: the answer is a question, not a stack overflow. */
const MAX_DEPTH = 48;

/** Runs `read` one level deeper, or says the nesting is past what is read and skips the rest. */
function deeper(text: string, state: LexState, read: () => number): number {
  if (state.depth >= MAX_DEPTH) {
    state.uncertain = true;
    return text.length;
  }
  state.depth += 1;
  try {
    return read();
  } finally {
    state.depth -= 1;
  }
}

/** A shell by name: the words that, after a pipe, read their program from it. */
export const SHELL_WORDS: ReadonlySet<string> = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'ksh93',
  'pdksh',
  'mksh',
  'oksh',
  'rbash',
  'ash',
  'hush',
  'posh',
  'fish',
  'csh',
  'tcsh',
  'yash',
]);

/** Programs that start a shell or run what they are given as one, beside the shells themselves. */
export const SHELL_STARTERS: ReadonlySet<string> = new Set([
  'busybox',
  'su',
  'ssh',
  'runuser',
  'newgrp',
  'unshare',
  'nsenter',
  'chroot',
]);

/** A shell word anywhere in a text: where something may be handed to a shell. */
export const SHELL_WORD_ANYWHERE = new RegExp(
  `\\b(?:${[...SHELL_WORDS, ...SHELL_STARTERS].join('|')})\\b`,
  'gi',
);

/** Whether a text holds a shell word. */
export function mentionsShellWord(text: string): boolean {
  SHELL_WORD_ANYWHERE.lastIndex = 0;
  return SHELL_WORD_ANYWHERE.test(text);
}

// -------------------------------------------------------------------------------------------
// Comments
// -------------------------------------------------------------------------------------------

/** Whether the character at `at - 1` is escaped: an odd run of backslashes ends just before it. */
function isEscaped(text: string, at: number): boolean {
  let run = 0;
  for (let i = at - 1; i >= 0 && text.charAt(i) === '\\'; i -= 1) run += 1;
  return run % 2 === 1;
}

/**
 * Whether a `#` at `at` begins a comment. A shell has it begin a word: after a space, a tab or a
 * line break, or after `;`, `&`, `|` or `(`, and none of those may be escaped (`a\ #` and
 * `a\;#` are one word). A backslash and a line break are taken out before the words are read, so
 * what stands before them is what stands before the `#` that begins the next line (`a \` and a line
 * break and `#` is a comment, and `a\` and a line break and `#` is one word). Other characters that
 * JavaScript calls white space are not blanks to a shell. Where the reading is wrong about this,
 * the text after the `#` is skipped as a comment while the shell runs it, so this is the strict
 * way to be wrong: when unsure, it is not a comment.
 */
export function startsComment(text: string, at: number, floor: number): boolean {
  if (at === floor) return true;
  // What the shell joins: each `\` and line break before the `#` (the backslash not itself escaped).
  let from = at;
  while (
    from - 2 >= floor &&
    text.charAt(from - 1) === '\n' &&
    text.charAt(from - 2) === '\\' &&
    !isEscaped(text, from - 2)
  )
    from -= 2;
  if (from === floor) return true;
  const before = text.charAt(from - 1);
  const boundary = before === ' ' || before === '\t' || before === '\n' || ';&|('.includes(before);
  return boundary && !isEscaped(text, from - 1);
}

// -------------------------------------------------------------------------------------------
// Quotes
// -------------------------------------------------------------------------------------------

/** The index after the quote that closes a single-quoted string opened at `from`. */
export function skipSingle(text: string, from: number, state: LexState): number {
  const close = text.indexOf("'", from + 1);
  if (close === -1) {
    state.uncertain = true;
    return text.length;
  }
  return close + 1;
}

/** The index after the `'` that closes a `$'…'` string whose opening quote is at `from`. */
export function skipAnsiC(text: string, from: number, state: LexState): number {
  for (let i = from + 1; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (ch === '\\') {
      // dash has no `$'…'`: it reads a string that ends at the first quote, so where the escape is
      // `\'` the shells do not agree where the string ends. Any other escape (`\t`, `\x41`, `\\`) ends it
      // where they all do.
      if (text.charAt(i + 1) === "'") state.ambiguous = true;
      i += 1;
    } else if (ch === "'") return i + 1;
  }
  state.uncertain = true;
  return text.length;
}

/** The index after the backtick that closes a pair opened at `from`; `\`` does not close it. */
export function skipBacktick(text: string, from: number, state: LexState): number {
  const outer = state.substitutions === 0;
  for (let i = from + 1; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (ch === '\\') i += 1;
    else if (ch === '`') {
      if (outer) state.nested.push({ from: from + 1, to: i, backtick: true });
      return i + 1;
    }
  }
  state.uncertain = true;
  if (outer) state.nested.push({ from: from + 1, to: text.length, backtick: true });
  return text.length;
}

/**
 * What a `$` at `i` begins, for the reading of text where a quote is a quote: the index after
 * it, or -1 if it begins nothing that is skipped whole. `$'…'` and `$"…"` are decided here, at
 * the `$`, and not by the character before a quote: `\$'` and `$$'` are not ANSI-C strings.
 * Inside double quotes a `$` followed by a quote is only a dollar sign.
 */
export function skipDollar(text: string, i: number, state: LexState, inDouble: boolean): number {
  const next = text.charAt(i + 1);
  if (next === '$') return i + 2;
  if (next === '(') return skipSubstitution(text, i + 2, state);
  if (next === '{') return skipBraces(text, i + 1, state, inDouble);
  if (next === '[') return skipBracketArithmetic(text, i + 2, state);
  if (inDouble) return -1;
  if (next === "'") return skipAnsiC(text, i + 1, state);
  if (next === '"') return skipDouble(text, i + 1, state);
  return -1;
}

/** Deprecated arithmetic, `$[ 1<<2 ]`: its `<<` is a shift, not a here-document. */
function skipBracketArithmetic(text: string, from: number, state: LexState): number {
  if (state.noBracketClose) return -1;
  let depth = 1;
  for (let i = from; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  state.noBracketClose = true;
  state.uncertain = true;
  return -1;
}

/**
 * The index after the `}` that closes a `${` whose `{` is at `from`: the first one that nothing
 * hides. A bare `{` inside does not open another (`${x:-{}` is the text `{`, and ends at the first
 * `}`); a `${` does, and so do quotes, which hide it. Inside double quotes a single quote is only
 * a quote character; outside them it opens a string.
 */
export function skipBraces(text: string, from: number, state: LexState, inDouble: boolean): number {
  return deeper(text, state, () => {
    for (let i = from + 1; i < text.length; i += 1) {
      const ch = text.charAt(i);
      if (ch === '\\') i += 1;
      else if (ch === "'" && !inDouble) i = skipSingle(text, i, state) - 1;
      else if (ch === '"') i = skipDouble(text, i, state) - 1;
      else if (ch === '`') i = skipBacktick(text, i, state) - 1;
      else if (ch === '$') {
        const end = skipDollar(text, i, state, inDouble);
        if (end !== -1) i = end - 1;
      } else if (ch === '}') return i + 1;
    }
    state.uncertain = true;
    return text.length;
  });
}

/** The index after the `"` that closes a double-quoted string opened at `from`. */
export function skipDouble(text: string, from: number, state: LexState): number {
  return deeper(text, state, () => {
    for (let i = from + 1; i < text.length; i += 1) {
      const ch = text.charAt(i);
      if (ch === '\\') i += 1;
      else if (ch === '"') return i + 1;
      else if (ch === '`') i = skipBacktick(text, i, state) - 1;
      else if (ch === '$') {
        const end = skipDollar(text, i, state, true);
        if (end !== -1) i = end - 1;
      }
    }
    state.uncertain = true;
    return text.length;
  });
}

// -------------------------------------------------------------------------------------------
// Here-documents
// -------------------------------------------------------------------------------------------

export interface HeredocOpen {
  readonly delimiter: string;
  /** `<<-`: tabs before the delimiter line, and before each body line, are not part of it. */
  readonly strip: boolean;
  /** Any part of the delimiter was quoted, so the body is text: nothing in it is expanded. */
  readonly quoted: boolean;
  /**
   * The delimiter is a plain word, written plainly: `'EOF'`, `"EOF"` or `\EOF`, with nothing in it
   * that a shell reads in a way of its own (`$'EOF'`, a backslash in double quotes, a line
   * continuation, a word made of several quoted parts). Every shell reads such a word the same way,
   * so only for such a body is it certain where the body ends.
   */
  readonly plain: boolean;
  /** Where the opener ends: the index after the delimiter word. */
  readonly end: number;
}

/** A delimiter word that every shell reads as the same one: quoted whole, or one backslash, of plain characters. */
const PLAIN_DELIMITER = /^(?:'[\w.-]+'|"[\w.-]+"|\\?[\w.-]+)$/;

/** The characters that end a word in shell text, besides blanks. */
const WORD_END = ';&|<>()';

/**
 * The opener of a here-document that begins with the `<<` at `at`: the delimiter is a word, read
 * as a shell reads one, up to a blank or an operator, with its quotes and backslashes taken off
 * (`E"O"F` and `E\OF` are `EOF`) and `quoted` when it had any. A backslash before a line break is a
 * continuation and is not part of the word (`<<EOF\` and a line break is `<<EOF`, not quoted). A
 * word that a shell reads with rules of its own (`$'EOF'` and `$"EOF"`, whose escapes a shell decodes
 * and a locale translates) is read only when it has no escape in it. An opener that cannot be read
 * (nothing after it, a quote that never closes, a word it will not guess at) is `null`, and the
 * caller says so.
 */
export function readOpener(text: string, at: number): HeredocOpen | null {
  let i = at + 2;
  const strip = text.charAt(i) === '-';
  if (strip) i += 1;
  while (text.charAt(i) === ' ' || text.charAt(i) === '\t') i += 1;
  const wordStart = i;
  let delimiter = '';
  let quoted = false;
  while (i < text.length) {
    const ch = text.charAt(i);
    if (ch === ' ' || ch === '\t' || ch === '\n' || WORD_END.includes(ch)) break;
    if (ch === '\\') {
      // A backslash and a line break are removed before the word is read: the word goes on.
      if (text.charAt(i + 1) !== '\n') {
        quoted = true;
        delimiter += text.charAt(i + 1);
      }
      i += 2;
    } else if (ch === '$' && (text.charAt(i + 1) === "'" || text.charAt(i + 1) === '"')) {
      const quote = text.charAt(i + 1);
      const close = text.indexOf(quote, i + 2);
      if (close === -1) return null;
      const inside = text.slice(i + 2, close);
      // `$'\x45OF'` is `EOF` to a shell and `$"$x"` is not: no guess is made at a word that has an
      // escape or an expansion in it.
      if (/[\\$`\n]/.test(inside)) return null;
      quoted = true;
      delimiter += inside;
      i = close + 1;
    } else if (ch === "'" || ch === '"') {
      const close = ch === "'" ? text.indexOf("'", i + 1) : doubleQuoteEnd(text, i + 1);
      if (close === -1) return null;
      quoted = true;
      delimiter += text.slice(i + 1, close);
      i = close + 1;
    } else {
      delimiter += ch;
      i += 1;
    }
  }
  if (delimiter === '' && !quoted) return null;
  const plain = PLAIN_DELIMITER.test(text.slice(wordStart, i));
  return { delimiter, strip, quoted, plain, end: i };
}

/** The index of the `"` that closes a delimiter word's double-quoted part, or -1. */
function doubleQuoteEnd(text: string, from: number): number {
  for (let i = from; i < text.length; i += 1) {
    if (text.charAt(i) === '\\') i += 1;
    else if (text.charAt(i) === '"') return i;
  }
  return -1;
}

/** The bodies of here-documents opened on the line before `from`, each up to its delimiter line. */
export function readBodies(
  text: string,
  from: number,
  opens: readonly HeredocOpen[],
): {
  readonly bodies: readonly string[];
  readonly ranges: readonly Region[];
  readonly end: number;
  readonly closed: boolean;
} {
  const bodies: string[] = [];
  const ranges: Region[] = [];
  let lineStart = from;
  let closed = true;
  for (const open of opens) {
    const lines: string[] = [];
    const bodyFrom = lineStart;
    let bodyTo = text.length;
    let found = false;
    while (lineStart <= text.length && !found) {
      const lineEnd = text.indexOf('\n', lineStart);
      const end = lineEnd === -1 ? text.length : lineEnd;
      const line = text.slice(lineStart, end);
      if ((open.strip ? line.replace(/^\t+/, '') : line) === open.delimiter) {
        found = true;
        bodyTo = lineStart;
      } else lines.push(line);
      lineStart = end + 1;
      if (lineEnd === -1) break;
    }
    if (!found) closed = false;
    bodies.push(`${lines.join('\n')}\n`);
    // The body is its lines; the delimiter line that ends it is shell text again.
    ranges.push([bodyFrom, Math.min(bodyTo, text.length)]);
  }
  return { bodies, ranges, end: Math.min(lineStart, text.length), closed };
}

// -------------------------------------------------------------------------------------------
// Command substitutions
// -------------------------------------------------------------------------------------------

/** Whether a `case` that begins at `i` is the keyword: at the start of the text or after a boundary. */
function isCaseKeyword(text: string, i: number, floor: number): boolean {
  if (!text.startsWith('case', i) || !/\s/.test(text.charAt(i + 4))) return false;
  return i === floor || ' \t\n;&|({'.includes(text.charAt(i - 1));
}

/**
 * The index after the `)` that closes a `$(`, `<(` or `>(` whose `(` is just before `from`.
 * Quotes, comments (which may hold an apostrophe), backticks, parameter expansions, nested
 * substitutions and the here-documents inside it (the body of a `git commit -m "$(cat <<'EOF' …
 * EOF)"` is free text, with apostrophes and parentheses in it) are skipped as the shell skips them.
 * A `case` inside leaves a `)` that is not a closer, which this does not model, so it is said.
 */
export function skipSubstitution(text: string, from: number, state: LexState): number {
  return deeper(text, state, () => {
    const outer = state.substitutions === 0;
    state.substitutions += 1;
    try {
      const close = readSubstitution(text, from, state);
      if (outer)
        state.nested.push({ from, to: close === -1 ? text.length : close, backtick: false });
      return close === -1 ? text.length : close + 1;
    } finally {
      state.substitutions -= 1;
    }
  });
}

/** The index of the `)` that closes the substitution, or -1 when none does. */
function readSubstitution(text: string, from: number, state: LexState): number {
  let depth = 1;
  const opens: HeredocOpen[] = [];
  for (let i = from; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (ch === '\\') i += 1;
    else if (ch === "'") i = skipSingle(text, i, state) - 1;
    else if (ch === '"') i = skipDouble(text, i, state) - 1;
    else if (ch === '`') i = skipBacktick(text, i, state) - 1;
    else if (ch === '$') {
      const end = skipDollar(text, i, state, false);
      if (end !== -1) i = end - 1;
    } else if (ch === '#' && startsComment(text, i, from)) {
      const eol = text.indexOf('\n', i);
      if (eol === -1) break;
      i = eol - 1;
    } else if (text.startsWith('<<<', i)) i += 2;
    else if (text.startsWith('<<', i)) {
      // A `<<` inside parentheses is a shift, not an opener; one at the level of the substitution is.
      const open = depth === 1 ? readOpener(text, i) : null;
      if (open !== null) {
        opens.push(open);
        i = open.end - 1;
      } else {
        if (depth === 1) state.uncertain = true;
        i += 1;
      }
    } else if (ch === '\n' && opens.length > 0) {
      const read = readBodies(text, i + 1, opens);
      if (!read.closed) state.uncertain = true;
      i = read.end - 1;
      opens.length = 0;
    } else if (ch === 'c' && isCaseKeyword(text, i, from)) state.uncertain = true;
    else if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  state.uncertain = true;
  return -1;
}

/**
 * Reads the text of a here-document that expands, for the commands that run in it: `$(…)` and
 * backticks, found as they are in a double-quoted string, where a quote is only a character.
 */
export function scanExpansions(text: string, from: number, to: number, state: LexState): void {
  const body = text.slice(from, to);
  const inner = newLexState();
  for (let i = 0; i < body.length; i += 1) {
    const ch = body.charAt(i);
    if (ch === '\\') i += 1;
    else if (ch === '`') i = skipBacktick(body, i, inner) - 1;
    else if (ch === '$') {
      const end = skipDollar(body, i, inner, true);
      if (end !== -1) i = end - 1;
    }
  }
  for (const n of inner.nested) state.nested.push({ ...n, from: n.from + from, to: n.to + from });
  if (inner.uncertain) state.uncertain = true;
}
