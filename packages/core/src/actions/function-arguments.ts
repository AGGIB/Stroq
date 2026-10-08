import {
  DOCUMENT_OPENER,
  arithmeticEnd,
  documentEnd,
  documentOf,
  type PendingDocument,
} from './function-definitions.js';
import { evaluateForm, newFormBudget, type FormBudget } from './parameter-forms.js';
import {
  newLexState,
  skipBacktick,
  skipDollar,
  skipDouble,
  skipSingle,
  startsComment,
} from './shell-skip.js';

/**
 * The words of a call, and the body of a function with them put where it uses its parameters: `"$@"`,
 * `$*`, `$1`, `${1:-w}`, `${@:2}`, `$#`, with `shift` followed where it always runs (see
 * `inlined-functions.ts`, which puts the calls in place).
 */

/** The operator of a redirect, which stands alone (`2> file`) or has its target with it (`2>file`, `>&2`, `{fd}>file`). */
const REDIRECT_OPERATOR = String.raw`(?:\d*|&|\{[A-Za-z_]\w*\})(?:>\||>>?&?|<<<|<<-?|<>|<&?)`;
export const REDIRECT = new RegExp(`^${REDIRECT_OPERATOR}`);
export const BARE_REDIRECT = new RegExp(`^${REDIRECT_OPERATOR}$`);

export interface RawWord {
  readonly text: string;
  readonly at: number;
}

/** A word that is only escaped line breaks: the shell takes them out, and it is no word. */
const CONTINUATION = /^(?:\\\n)+$/;

/**
 * The words of a text as it was written, cut at the blanks that no quote holds. A backslash and a line
 * break is a line continued: it is taken out of the text before it is cut into words, so a word that is
 * only that is not one (`r \<newline>  -rf ~` is given two words), and one that holds it has it taken out.
 */
export function rawWords(text: string): RawWord[] {
  const state = newLexState();
  const words: RawWord[] = [];
  let start = -1;
  const push = (end: number): void => {
    const word = start === -1 ? '' : text.slice(start, end);
    if (word !== '' && !CONTINUATION.test(word)) words.push({ text: word, at: start });
    start = -1;
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      push(i);
      continue;
    }
    if (start === -1) start = i;
    if (ch === '\\') i += 1;
    else if (ch === "'") i = skipSingle(text, i, state) - 1;
    else if (ch === '"') i = skipDouble(text, i, state) - 1;
    else if (ch === '`') i = skipBacktick(text, i, state) - 1;
    else if (ch === '$') {
      const end = skipDollar(text, i, state, false);
      if (end !== -1) i = end - 1;
    }
  }
  push(text.length);
  return words;
}

/** The words a function is given: the words of the call without the redirects, which the shell takes off. */
export function argumentsOf(words: readonly RawWord[]): string[] {
  const given: string[] = [];
  for (let i = 0; i < words.length; i += 1) {
    const word = (words[i] as RawWord).text;
    if (!REDIRECT.test(word)) given.push(word);
    // `>` and `2>` stand alone: the next word is where it goes.
    else if (BARE_REDIRECT.test(word)) i += 1;
  }
  return given;
}

/** The redirects among the words of a call, each with the word it stands before when it stands alone (`2>` `file`): what the call keeps. */
export function redirectsOf(words: readonly RawWord[]): string[] {
  const kept: string[] = [];
  for (let i = 0; i < words.length; i += 1) {
    const word = (words[i] as RawWord).text;
    if (!REDIRECT.test(word)) continue;
    kept.push(word);
    const target = words[i + 1];
    if (BARE_REDIRECT.test(word) && target !== undefined) {
      kept.push(target.text);
      i += 1;
    }
  }
  return kept;
}

/** A word as the shell takes its value: one level of quotes and escapes taken off. */
export function unquoteWord(word: string): string {
  let out = '';
  for (let i = 0; i < word.length; i += 1) {
    const ch = word.charAt(i);
    if (ch === '\\') {
      // An escaped line break is a line continued: it is not a letter of the word.
      if (word.charAt(i + 1) !== '\n') out += word.charAt(i + 1);
      i += 1;
    } else if (ch === "'") {
      const end = word.indexOf("'", i + 1);
      const stop = end === -1 ? word.length : end;
      out += word.slice(i + 1, stop);
      i = stop;
    } else if (ch === '"') {
      i += 1;
      while (i < word.length && word.charAt(i) !== '"') {
        if (word.charAt(i) === '\\' && word.charAt(i + 1) === '\n') {
          i += 2;
          continue;
        }
        if (word.charAt(i) === '\\' && '"\\$`'.includes(word.charAt(i + 1))) i += 1;
        out += word.charAt(i);
        i += 1;
      }
    } else out += ch;
  }
  return out;
}

/**
 * The forms of a parameter that the words of a call are put in place of, in one pass, so that what is put
 * in is not read again: `"$@"`, `$*`, `${@:2}`, `${*:2:3}`, `${@: -2}` (the words), `$1`, `"${1}"` (one word),
 * `${1:-word}`, `${1-word}`, `${1:+word}`, `${1:?word}`, `$#`, `${#@}` (how many), and the forms that change
 * a value (`${1%.*}`, `${1##*.}`, `${1/a/b}`, `${1:2:3}`, `${1^^}`, `${#1}`), worked out where the value is
 * plain text (see `parameter-forms.ts`). Each is tried where a `$` stands, and where a `"` that begins one stands.
 */
const PARAMETER_FORMS = [
  String.raw`"\$\{[@*]:\s*-?\d+(?::\s*-?\d+)?\}"`,
  String.raw`\$\{[@*]:\s*-?\d+(?::\s*-?\d+)?\}`,
  String.raw`"\$\{[1-9]:?[-+?][^}]*\}"`,
  String.raw`\$\{[1-9]:?[-+?][^}]*\}`,
  String.raw`"\$[@*]"`,
  String.raw`"\$\{[@*]\}"`,
  String.raw`\$\{[@*]\}`,
  String.raw`\$[@*]`,
  String.raw`"\$[1-9]"`,
  String.raw`"\$\{[1-9]\}"`,
  String.raw`\$\{[1-9]\}`,
  String.raw`\$[1-9]`,
  String.raw`"\$#"`,
  String.raw`"\$\{#\}"`,
  String.raw`\$\{#\}`,
  String.raw`\$#`,
  String.raw`"\$\{#[@*]\}"`,
  String.raw`\$\{#[@*]\}`,
  String.raw`"\$\{#?[1-9][^}]*\}"`,
  String.raw`\$\{#?[1-9][^}]*\}`,
];
const PARAMETER = new RegExp(PARAMETER_FORMS.join('|'), 'y');
/** The forms that are not between quotes, which are what a here-document that expands has in it. */
const UNQUOTED_FORMS = PARAMETER_FORMS.filter((form) => !form.startsWith('"'));
const UNQUOTED_PARAMETER = new RegExp(`^(?:${UNQUOTED_FORMS.join('|')})$`);
/** A use of the parameters that is not put in place: `${10}`, `${!1}`, `${1:=w}`, `${@/a/b}`, `${*#x}`. */
const OTHER_PARAMETER_SOURCE = String.raw`\$\{(?:[!#]?[0-9]+|[!#]?[@*])[^}]*\}`;
const OTHER_PARAMETER = new RegExp(OTHER_PARAMETER_SOURCE, 'y');
/** The forms and, where none is, the uses that are not put in place: what is in a document that expands. */
const PARAMETER_IN_TEXT = new RegExp([...UNQUOTED_FORMS, OTHER_PARAMETER_SOURCE].join('|'), 'g');
/** What changes the parameters in a way that a reading of the body does not follow. */
const CHANGES_PARAMETERS = /\bgetopts\b|\bset\s+--(?:\s|$)/;
const SHIFT = /shift(?:[ \t]+(\d+))?(?=[ \t]*(?:[;&|)}\n]|$))/y;
const SLICE = /^\$\{[@*]:\s*(-?\d+)(?::\s*(-?\d+))?\}$/;
const DEFAULT = /^\$\{([1-9])(:?)([-+?])([^}]*)\}$/;
/** How much of what is put in is kept to see whether the next parameter is the right side of an assignment. */
const RECENT_CHARS = 100;
/** The end of a text that is the left side of an assignment: the words put there are one word. */
const ASSIGNING = /(?<![\w$.-])[A-Za-z_]\w*\+?=$/;

/** How many times a word stands in a text, as a word. */
const countWord = (text: string, word: string): number =>
  text.match(new RegExp(String.raw`\b${word}\b`, 'g'))?.length ?? 0;

/**
 * Whether the command at `at` runs whenever the body does: not inside a loop, a branch of `if` or `case`,
 * a group or a subshell, and not after `&&` or `||`.
 */
function alwaysRuns(body: string, at: number): boolean {
  const before = body.slice(0, at).replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, '');
  if (/(?:&&|\|\|)\s*$/.test(before)) return false;
  for (const [opener, closer] of [
    ['then', 'fi'],
    ['do', 'done'],
    ['case', 'esac'],
  ] as const)
    if (countWord(before, opener) > countWord(before, closer)) return false;
  const count = (ch: string): number => before.split(ch).length - 1;
  return count('{') <= count('}') && count('(') <= count(')');
}

export interface Substituted {
  readonly text: string;
  /** Every use of a parameter in the body was put in place. */
  readonly complete: boolean;
  /** The body came to more than it was let: nothing is made of it. */
  readonly overflow?: boolean;
}

/** Whether the quotes of a text open and close within it, as the shell reads a word. */
function quotesBalance(text: string): boolean {
  let quote = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (quote === "'") {
      if (ch === "'") quote = '';
    } else if (ch === '\\') i += 1;
    else if (quote === '"') {
      if (ch === '"') quote = '';
    } else if (ch === "'" || ch === '"') quote = ch;
  }
  return quote === '';
}

/**
 * The body with the words of a call put where it uses them (exported for the tests of it). `limit` is the most
 * that it may come to: a body that uses `$@` eight thousand times, given words of forty kilobytes, is not built,
 * and is said to be past it (`overflow`), with nothing in `text`. `budget` is what the forms of a parameter may
 * still spend (see `FormBudget`), shared by the calls of a command.
 */
export function withArguments(
  body: string,
  args: string,
  limit = Infinity,
  budget: FormBudget = newFormBudget(),
): Substituted {
  const words = rawWords(args);
  const given = argumentsOf(words);
  let complete = !CHANGES_PARAMETERS.test(body);
  let offset = 0;
  let out = '';
  let size = 0;
  let overflow = false;
  // The last of `out`, kept apart: a slice of a string that is built by adding is a copy of all of it.
  let recent = '';
  let double = false;
  const emit = (text: string): void => {
    size += text.length;
    if (size > limit) {
      overflow = true;
      return;
    }
    out += text;
    recent =
      text.length >= RECENT_CHARS
        ? text.slice(-RECENT_CHARS)
        : (recent + text).slice(-RECENT_CHARS);
  };
  // All the words, where they are put as one: the same text at each use of `$@`, made once.
  const everything = new Map<string, string>();
  const left = (): string[] => given.slice(offset);
  /**
   * A value put where the shell takes it as it is: a quote in it is a letter of a word, and one that would
   * open a string that does not close (`it's`) or end the string it stands in is written as a letter.
   */
  const embedded = (value: string, inText: boolean): string => {
    if (inText) return value;
    if (double) return value.replace(/[\\"]/g, '\\$&');
    return quotesBalance(value) ? value : value.replace(/['"]/g, '\\$&');
  };
  const joined = (list: readonly string[], raw: boolean, inText = false): string =>
    list.map((word) => (raw ? word : embedded(unquoteWord(word), inText))).join(' ');
  const put = (token: string, inText = false): string => {
    const quoted = token.length > 1 && token.startsWith('"') && token.endsWith('"');
    const inner = quoted ? token.slice(1, -1) : token;
    // As written where the token is a whole word of its own, between quotes or after `name=`; as the value
    // it stands for where it is not quoted or is part of a longer string, which word splitting then reads.
    const raw = !inText && ((quoted && !double) || ASSIGNING.test(recent));
    if (/^\$\{?#[@*]?\}?$/.test(inner) && !/^\$\{#[1-9]/.test(inner)) return String(left().length);
    const slice = SLICE.exec(inner);
    if (slice !== null) {
      const count = left().length;
      const start = Number(slice[1]);
      // `${@:0}` begins with `$0`, which a function is not given by its call.
      const from = start < 0 ? Math.max(count + start, 0) : Math.max(start, 1) - 1;
      const length = slice[2] === undefined ? undefined : Number(slice[2]);
      // A negative length is an error of the shell, and no value.
      if (length !== undefined && length < 0) {
        complete = false;
        return token;
      }
      return joined(
        left().slice(from, length === undefined ? undefined : from + length),
        raw,
        inText,
      );
    }
    if (/^\$\{?[@*]\}?$/.test(inner)) {
      const key = `${offset}|${raw}|${inText}|${double}`;
      let all = everything.get(key);
      if (all === undefined) {
        all = joined(left(), raw, inText);
        everything.set(key, all);
      }
      return all;
    }
    const defaulted = DEFAULT.exec(inner);
    if (defaulted !== null) {
      const value = given[offset + Number(defaulted[1]) - 1];
      const set = value !== undefined && (defaulted[2] === '' || !/^(?:''|"")?$/.test(value));
      const word = quoted ? `"${defaulted[4]}"` : (defaulted[4] as string);
      // `${1:?word}` ends the shell where the parameter is not set: what is read is the value, or nothing.
      if (defaulted[3] === '?') return set ? joined([value as string], raw, inText) : '';
      if (defaulted[3] === '-') return set ? joined([value as string], raw, inText) : word;
      return set ? word : '';
    }
    const number = Number(/[1-9]/.exec(inner)?.[0]);
    const value = given[offset + number - 1] ?? '';
    if (/^\$\{?[1-9]\}?$/.test(inner)) return joined([value], raw, inText);
    // A form that changes the value: worked out where the value is plain, and where it is not it is a use of the
    // parameter that is not put in place.
    const worked = evaluateForm(inner, unquoteWord(value), budget);
    if (worked === null) {
      complete = false;
      return token;
    }
    return quoted && !inText && !double ? `"${worked}"` : worked;
  };
  const pending: PendingDocument[] = [];
  /** What a here-document that expands has in it, with its parameters put in place; its quotes are text. */
  const expanded = (text: string): string =>
    text.replace(PARAMETER_IN_TEXT, (token) => {
      if (UNQUOTED_PARAMETER.test(token)) return put(token, true);
      complete = false;
      return token;
    });
  let i = 0;
  while (i < body.length && !overflow) {
    const ch = body.charAt(i);
    if (ch === '<' && !double && body.startsWith('<<', i) && !body.startsWith('<<<', i)) {
      DOCUMENT_OPENER.lastIndex = i;
      const found = DOCUMENT_OPENER.exec(body);
      if (found !== null) {
        pending.push(documentOf(found));
        emit(found[0]);
        i += found[0].length;
        continue;
      }
    }
    if (ch === '\n' && pending.length > 0 && !double) {
      // The lines of the documents that this line opened are text, up to the line of each delimiter.
      emit(ch);
      i += 1;
      for (const document of pending) {
        const end = documentEnd(body, i, document, body.length);
        const stop = end === -1 ? body.length : end;
        const text = body.slice(i, stop);
        emit(document.literal ? text : expanded(text));
        i = stop;
      }
      pending.length = 0;
      continue;
    }
    if (ch === '#' && !double && startsComment(body, i, 0)) {
      // A comment: nothing in it is expanded, and its quotes are not quotes.
      const eol = body.indexOf('\n', i);
      const stop = eol === -1 ? body.length : eol;
      emit(body.slice(i, stop));
      i = stop;
      continue;
    }
    if (ch === '\\') {
      emit(body.slice(i, i + 2));
      i += 2;
      continue;
    }
    // An arithmetic expansion, or the arithmetic command `(( … ))`: a `<<` in it is a shift and not a document,
    // and its parameters are values.
    const arithmetic =
      ch === '$' && body.startsWith('$((', i)
        ? skipDollar(body, i, newLexState(), false)
        : ch === '(' && !double && body.startsWith('((', i)
          ? arithmeticEnd(body, i)
          : -1;
    if (arithmetic !== -1) {
      emit(expanded(body.slice(i, arithmetic)));
      i = arithmetic;
      continue;
    }
    if (ch === "'" && !double) {
      const end = body.indexOf("'", i + 1);
      const stop = end === -1 ? body.length : end + 1;
      emit(body.slice(i, stop));
      i = stop;
      continue;
    }
    if (ch === '$' || (ch === '"' && !double)) {
      PARAMETER.lastIndex = i;
      const found = PARAMETER.exec(body);
      if (found !== null) {
        emit(put(found[0]));
        i += found[0].length;
        continue;
      }
      if (ch === '$') {
        OTHER_PARAMETER.lastIndex = i;
        if (OTHER_PARAMETER.test(body)) complete = false;
      }
    } else if (ch === 's' && !double && (i === 0 || /[\s;&|({]/.test(body.charAt(i - 1)))) {
      SHIFT.lastIndex = i;
      const shift = SHIFT.exec(body);
      if (shift !== null) {
        offset += shift[1] === undefined ? 1 : Number(shift[1]);
        // A shift that is not one that always happens (in a loop, a branch, a group, after `&&`) is not
        // followed: what the parameters are after it depends on what ran.
        if (!alwaysRuns(body, i)) complete = false;
        emit(shift[0]);
        i += shift[0].length;
        continue;
      }
    }
    if (ch === '"') double = !double;
    emit(ch);
    i += 1;
  }
  // Quotes that do not close are a body that was not followed to its end.
  if (overflow) return { text: '', complete: false, overflow: true };
  return { text: out, complete: complete && !double };
}
