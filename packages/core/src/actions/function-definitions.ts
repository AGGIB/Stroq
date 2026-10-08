import { checkDeadline } from './deadline.js';
import {
  newLexState,
  skipBacktick,
  skipDollar,
  skipDouble,
  skipSingle,
  startsComment,
} from './shell-skip.js';

/**
 * The functions that a command defines: where a definition stands, what its name is, and the text of its
 * body, found by a reading of its own, which a quote or a document can make disagree with the shell (see
 * `inlined-functions.ts`, which puts the calls of them in place).
 */

/** The most definitions that are read in one text, and the longest body and name. */
const MAX_DEFINITIONS = 64;
const MAX_BODY_CHARS = 16_384;
export const MAX_NAME_CHARS = 256;
/** The longest arithmetic that is skipped: the one that closes within a line or two, so that a run of `(` is not a pass over the rest for each. */
const MAX_ARITHMETIC_CHARS = 1024;

/**
 * What a name that a shell takes for a function is made of: nearly any word (`1f`, `a+b`, `.a`, `:`, `[`,
 * `é`), not one with a blank, a separator, a bracket, a quote, `$`, a backslash or `=` in it, and not one
 * that begins with `#`.
 */
const NAME_END = String.raw`\s;&|<>(){}'"` + '`' + String.raw`$\\=`;
const NAME = `[^${NAME_END}#][^${NAME_END}]*`;
/**
 * Where the gap between the header of a definition and its body ends: blanks and line breaks, comments and escaped
 * line breaks. It is read by hand, and not by a pattern that ends in the opener: from every `;` in a text of
 * comment lines (`#;g()` a thousand times) a pattern runs the gap to the end of the text and finds no opener, once
 * for each, and a text of a hundred thousand of them cost seven seconds (and the clock cannot stop a pattern).
 */
function gapEnd(text: string, from: number): number {
  let i = from;
  for (;;) {
    while (i < text.length && /\s/.test(text.charAt(i))) i += 1;
    if (text.charAt(i) === '\\' && text.charAt(i + 1) === '\n') {
      i += 2;
      continue;
    }
    if (text.charAt(i) !== '#') return i;
    const end = text.indexOf('\n', i);
    if (end === -1) return i;
    i = end + 1;
  }
}
/** What the gaps of all the headers in a text may add up to: past it the text is asked about, and not read. */
const GAP_FLOOR = 65_536;
const GAP_PER_CHARACTER = 4;
/** What zsh and bash allow before the name of a function: `export f() { …; }`, `typeset -f f() { …; }`. */
const DECLARATION = String.raw`(?:(?:export|declare|typeset|readonly|local)\s+(?:-\w+\s+)*)?`;
/**
 * `name() {` and `function name {` (with or without the parentheses), where a command begins: at the
 * start of the text, after a separator, an opening bracket or the `)` of an arm of `case`, and after
 * `then`, `do` and `else`. The body is a group (`{`), a subshell (`(`), or another compound command,
 * which is not read (`if`, `while`, `[[`). White space after the start is blanks and tabs only, because a
 * line break is a start of its own: with `\s*` here, the line breaks of a long run each began a pass
 * over the rest of the run, and a text of a hundred thousand of them cost minutes. A keyword is a word of its own
 * (no name character before or after it): with `\b`, every `do` in `-do-do-do…` began a name that ran to the end
 * of the word and looked for the parentheses there, and 160 KiB of it took thirty seconds.
 */
const HEADER = new RegExp(
  String.raw`(^|[;&|\n({)]|(?<![^${NAME_END}])(?:then|do|else)(?![^${NAME_END}]))([ \t]*)${DECLARATION}(?:function\s+(${NAME})(?:\s*\(\s*\))?|(${NAME})\s*\(\s*\))`,
  'g',
);
/** What opens the body of a definition, after the gap that follows its header. */
const OPENER = /\{|\(|(?:if|while|until|for|case|select)\b|\[\[/y;
/** What a text has that may be a definition: a `)` that a body follows, or the keyword. */
export const MAY_DEFINE = /\)\s*(?:[{(#\\]|(?:if|while|until|for|case|select)\b|\[\[)|\bfunction\b/;
/** A body with a function of its own in it: where the outer one ends is not certain. */
const NESTED_DEFINITION = /\(\s*\)\s*[{(]|\bfunction\s+[^\s;&|<>(){}]/;
/** What a `<<` opens: the delimiter that ends the document (bare, quoted or escaped), and `-` where tabs are taken off the lines. */
export const DOCUMENT_OPENER = /<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|(\\)?([^\s;&|()<>'"\\]+))/y;

export interface PendingDocument {
  readonly delimiter: string;
  readonly stripTabs: boolean;
  /** The delimiter was quoted or escaped: the lines are text, and nothing in them is expanded. */
  readonly literal: boolean;
}

/** The document that an opener that `DOCUMENT_OPENER` matched opens. */
export function documentOf(found: RegExpExecArray): PendingDocument {
  return {
    delimiter: (found[2] ?? found[3] ?? found[5]) as string,
    stripTabs: found[1] === '-',
    literal: found[2] !== undefined || found[3] !== undefined || found[4] !== undefined,
  };
}

/**
 * Where a document that is read from `from` ends: past the line that is its delimiter. -1 where it never
 * ends, or where that is past `limit`.
 */
export function documentEnd(
  text: string,
  from: number,
  document: PendingDocument,
  limit: number,
): number {
  let at = from;
  for (;;) {
    if (at >= text.length || at > limit) return -1;
    const eol = text.indexOf('\n', at);
    const end = eol === -1 ? text.length : eol;
    const line = text.slice(at, end);
    at = eol === -1 ? text.length : eol + 1;
    if ((document.stripTabs ? line.replace(/^\t+/, '') : line) === document.delimiter) return at;
  }
}

/**
 * Where the lines of the documents that a line opened end, from where its first body line begins: past the
 * line that is each one's delimiter, in the order they were opened. -1 where one never ends.
 */
function skipDocuments(
  text: string,
  from: number,
  pending: readonly PendingDocument[],
  limit: number,
): number {
  let at = from;
  for (const document of pending) {
    at = documentEnd(text, at, document, limit);
    if (at === -1) return -1;
  }
  return at;
}

export interface FunctionDefinition {
  readonly name: string;
  /** What is between the braces; null where it is not read (too long, a function in it, a document that never ends, no certain end). */
  readonly body: string | null;
}

/**
 * Where the arithmetic `((` … `))` that begins at `at` ends (past the `))`), or -1 where it does not close:
 * a `<<` in it is a shift and not a document, and a brace in it closes nothing.
 */
export function arithmeticEnd(text: string, at: number): number {
  let depth = 0;
  for (let i = at; i < text.length && i - at <= MAX_ARITHMETIC_CHARS; i += 1) {
    const ch = text.charAt(i);
    if (ch === '\\') i += 1;
    else if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return text.charAt(i - 1) === ')' && i - 1 > at + 1 ? i + 1 : -1;
    }
  }
  return -1;
}

/**
 * Where the `}` that closes the `{` at `open` is (or the `)` that closes the `(`), and the text up to it as
 * code: quotes, substitutions, comments and the lines of here-documents hide a closing bracket, and are
 * blanks in `code`, so that what is looked for in it (a function of its own, a `case`) is not found in a
 * string. Null where there is no certain end: a document that never ends, a quote that does not close.
 */
function closingBody(
  text: string,
  open: number,
): { readonly close: number; readonly code: string } | null {
  const state = newLexState();
  const pending: PendingDocument[] = [];
  const opens = text.charAt(open);
  const closes = opens === '(' ? ')' : '}';
  const code: string[] = [];
  let depth = 0;
  let i = open;
  while (i < text.length) {
    if (i - open > MAX_BODY_CHARS) return null;
    const ch = text.charAt(i);
    // Where the walk goes on, and whether what it passed is code.
    let next = i + 1;
    let blank = false;
    const arithmetic =
      ch === '(' && i !== open && text.charAt(i + 1) === '(' ? arithmeticEnd(text, i) : -1;
    if (ch === '\\') {
      next = i + 2;
      blank = true;
    } else if (ch === "'") {
      next = skipSingle(text, i, state);
      blank = true;
    } else if (ch === '"') {
      next = skipDouble(text, i, state);
      blank = true;
    } else if (ch === '`') {
      next = skipBacktick(text, i, state);
      blank = true;
    } else if (ch === '$') {
      const end = skipDollar(text, i, state, false);
      if (end !== -1) {
        next = end;
        blank = true;
      }
    } else if (ch === '<' && text.startsWith('<<<', i)) {
      next = i + 3;
    } else if (ch === '<' && text.startsWith('<<', i)) {
      DOCUMENT_OPENER.lastIndex = i;
      const found = DOCUMENT_OPENER.exec(text);
      if (found === null) return null;
      pending.push(documentOf(found));
      next = DOCUMENT_OPENER.lastIndex;
      blank = true;
    } else if (ch === '\n' && pending.length > 0) {
      const after = skipDocuments(text, i + 1, pending, open + MAX_BODY_CHARS);
      if (after === -1) return null;
      pending.length = 0;
      next = after;
      blank = true;
    } else if (ch === '#' && startsComment(text, i, open)) {
      const eol = text.indexOf('\n', i);
      if (eol === -1) return null;
      next = eol;
      blank = true;
    } else if (arithmetic !== -1) {
      next = arithmetic;
      blank = true;
    } else if (ch === opens) depth += 1;
    else if (ch === closes) {
      depth -= 1;
      if (depth === 0)
        return state.uncertain || pending.length > 0
          ? null
          : { close: i, code: code.join('').slice(1) };
    }
    code.push(blank ? ' '.repeat(next - i) : text.slice(i, next));
    i = next;
  }
  return null;
}

/** The functions a text defines, and whether it defines more than are read. */
export function functionsDefinedIn(text: string): {
  readonly definitions: FunctionDefinition[];
  readonly crowded: boolean;
} {
  const definitions: FunctionDefinition[] = [];
  if (!MAY_DEFINE.test(text)) return { definitions, crowded: false };
  const pattern = new RegExp(HEADER);
  const allowance = GAP_PER_CHARACTER * text.length + GAP_FLOOR;
  let spent = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    checkDeadline();
    const headerEnd = match.index + match[0].length;
    const open = gapEnd(text, headerEnd);
    spent += open - headerEnd;
    // A text whose headers are followed by more gap than the text has is not one: it is asked about.
    if (spent > allowance) return { definitions, crowded: true };
    OPENER.lastIndex = open;
    const found = OPENER.exec(text);
    if (found === null) {
      // No body: the next try is from the next character, as it is for a pattern that failed.
      pattern.lastIndex = match.index + 1;
      continue;
    }
    pattern.lastIndex = open + found[0].length;
    if (definitions.length >= MAX_DEFINITIONS) return { definitions, crowded: true };
    const name = (match[3] ?? match[4]) as string;
    const opener = found[0];
    // A compound command other than a group or a subshell is a body that is not read, and a name that no
    // shell is given is not looked for.
    const group = (opener === '{' || opener === '(') && name.length <= MAX_NAME_CHARS;
    const closed = group ? closingBody(text, open) : null;
    // A function in the body, or in a subshell the `)` of a pattern of `case`, is where the end is not certain.
    const readable =
      closed !== null &&
      !NESTED_DEFINITION.test(closed.code) &&
      !(opener === '(' && /\bcase\b/.test(closed.code));
    definitions.push({
      name,
      body: closed !== null && readable ? text.slice(open + 1, closed.close) : null,
    });
  }
  return { definitions, crowded: false };
}

/** What makes two definitions one: the name and the body. */
export const functionKey = (definition: FunctionDefinition): string =>
  `${definition.name}\u0000${definition.body ?? '\u0001'}`;

const NO_TEXTS: ReadonlySet<string> = new Set();

/**
 * The functions that any of `texts` defines, each once: what every text read from the command is given. `copies`
 * are the texts that are another text with some variables put in (a loop's word, a variable's value): they define the
 * functions of the text they copy again, with the word put in, and a function that the texts which are none of them
 * define is that function and not five; a name that only a copy defines (a definition that a variable's value
 * made) is one, in each of the bodies the copies give it.
 */
export function inheritedFunctions(
  texts: readonly string[],
  given: readonly FunctionDefinition[] = [],
  copies: ReadonlySet<string> = NO_TEXTS,
): {
  readonly definitions: FunctionDefinition[];
  readonly crowded: boolean;
} {
  const seen = new Set<string>();
  const definitions: FunctionDefinition[] = [];
  let crowded = false;
  const take = (each: { definitions: readonly FunctionDefinition[]; crowded: boolean }): void => {
    crowded ||= each.crowded;
    for (const definition of each.definitions) {
      const key = functionKey(definition);
      if (seen.has(key)) continue;
      seen.add(key);
      if (definitions.length >= MAX_DEFINITIONS) crowded = true;
      else definitions.push(definition);
    }
  };
  for (const text of texts) if (!copies.has(text)) take(functionsDefinedIn(text));
  take({ definitions: [...given], crowded: false });
  if (copies.size === 0) return { definitions, crowded };
  const named = new Set(definitions.map((definition) => definition.name));
  for (const text of texts) {
    if (!copies.has(text)) continue;
    const each = functionsDefinedIn(text);
    take({
      definitions: each.definitions.filter((definition) => !named.has(definition.name)),
      crowded: each.crowded,
    });
  }
  return { definitions, crowded };
}
