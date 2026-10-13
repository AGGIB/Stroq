/**
 * The forms of a positional parameter that change its value, worked out for a value that is plain text:
 * `${1%.*}`, `${1##*.}`, `${1/a/b}`, `${1:2:3}`, `${1^^}`, `${#1}`. A function that a command defines and calls
 * uses them to take a name apart (`${1%.*}` is the name without its extension), and the words it is given
 * are put in place of them (see `function-arguments.ts`), so what a detector reads is what the shell runs.
 *
 * Only what can be worked out exactly is: a value of letters, digits and a few marks (no expansion, glob,
 * quote or escape in it), a pattern of the same with `*` and `?`, and a replacement of the same without them.
 * Anything else is `null`, and the body that uses it is not read to its end and is asked about, because a
 * value that is not worked out is a value a detector may read wrongly (`${1#x}` of `x/` is `/`).
 */

/** What no shell reads as more than the letters it holds. */
const PLAIN_VALUE = /^[A-Za-z0-9_./:@%+=, -]*$/;
const PLAIN_PATTERN = /^[A-Za-z0-9_./:@%+=,*? -]*$/;
const PLAIN_REPLACEMENT = /^[A-Za-z0-9_./:@+=, -]*$/;
/** The longest value and pattern that are worked out: every cut of the value is tried against the pattern. */
const MAX_VALUE_CHARS = 128;
const MAX_PATTERN_CHARS = 24;

/**
 * What the forms of one command may spend in all, in letters compared: a value and a pattern of a real name cost a
 * few thousand. It is one budget for the command and not one for each call: a call costs what its forms cost,
 * and a command may have a call in every one of two thousand places.
 */
export interface FormBudget {
  steps: number;
}
export const newFormBudget = (): FormBudget => ({ steps: 1_000_000 });

/**
 * Whether a glob of letters, `*` and `?` matches the whole of `text`: one pass, with the last `*` to go back to,
 * which is as many steps as the pattern times the text at the worst, and is paid for as that.
 */
function globMatches(pattern: string, text: string, budget: FormBudget): boolean {
  budget.steps -= (pattern.length + 1) * (text.length + 1);
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    const ch = pattern.charAt(p);
    if (p < pattern.length && ch === '*') {
      star = p;
      mark = t;
      p += 1;
    } else if (p < pattern.length && (ch === '?' || ch === text.charAt(t))) {
      p += 1;
      t += 1;
    } else if (star !== -1) {
      p = star + 1;
      mark += 1;
      t = mark;
    } else return false;
  }
  while (pattern.charAt(p) === '*') p += 1;
  return p === pattern.length;
}

/** The length of the shortest or the longest prefix that a glob matches, or -1. */
function prefixLength(
  value: string,
  pattern: string,
  longest: boolean,
  budget: FormBudget,
): number {
  for (let k = 0; k <= value.length; k += 1) {
    const cut = longest ? value.length - k : k;
    if (globMatches(pattern, value.slice(0, cut), budget)) return cut;
  }
  return -1;
}

/** The length of the shortest or the longest suffix that a glob matches, or -1. */
function suffixLength(
  value: string,
  pattern: string,
  longest: boolean,
  budget: FormBudget,
): number {
  for (let k = 0; k <= value.length; k += 1) {
    const cut = longest ? value.length - k : k;
    if (globMatches(pattern, value.slice(value.length - cut), budget)) return cut;
  }
  return -1;
}

/** The text with the first (or each) longest match of a glob replaced. */
function replaced(
  value: string,
  pattern: string,
  by: string,
  all: boolean,
  budget: FormBudget,
): string {
  let out = '';
  let i = 0;
  while (i < value.length) {
    let end = -1;
    for (let j = value.length; j > i && end === -1 && budget.steps >= 0; j -= 1)
      if (globMatches(pattern, value.slice(i, j), budget)) end = j;
    if (end === -1) {
      out += value.charAt(i);
      i += 1;
      continue;
    }
    out += by;
    i = end;
    if (!all) return out + value.slice(i);
  }
  return out;
}

/** `${1:o}` and `${1:o:l}`: from `o` (from the end, if it is negative), `l` letters (up to `l` before the end, if it is negative). */
function substring(value: string, offset: number, length: number | undefined): string | null {
  const from = offset < 0 ? value.length + offset : offset;
  // From before the start is an empty value in one shell and the whole of it in another.
  if (from < 0) return null;
  if (length === undefined) return value.slice(from);
  const to = length < 0 ? value.length + length : from + length;
  // A negative length that ends before it starts is an error in the shell.
  if (to < from) return length < 0 ? null : '';
  return value.slice(from, to);
}

const FORM = /^\$\{(#)?([1-9])([^}]*)\}$/;

/**
 * What a form of a positional parameter comes to for a value, or null where it is not worked out: the
 * value or the form is not plain, or the form is one that is not read, or it costs more than the body may spend.
 */
export function evaluateForm(form: string, value: string, budget: FormBudget): string | null {
  if (budget.steps <= 0) return null;
  const parts = FORM.exec(form);
  if (parts === null || value.length > MAX_VALUE_CHARS || !PLAIN_VALUE.test(value)) return null;
  const rest = parts[3] as string;
  if (parts[1] !== undefined) return rest === '' ? String(value.length) : null;
  const result = evaluateOperator(rest, value, budget);
  return budget.steps < 0 ? null : result;
}

function evaluateOperator(rest: string, value: string, budget: FormBudget): string | null {
  const removal = /^(##?|%%?)(.*)$/.exec(rest);
  if (removal !== null) {
    const pattern = removal[2] as string;
    if (!PLAIN_PATTERN.test(pattern) || pattern.length > MAX_PATTERN_CHARS) return null;
    const operator = removal[1] as string;
    const longest = operator.length === 2;
    if (operator.startsWith('#')) {
      const cut = prefixLength(value, pattern, longest, budget);
      return cut === -1 ? value : value.slice(cut);
    }
    const cut = suffixLength(value, pattern, longest, budget);
    return cut === -1 ? value : value.slice(0, value.length - cut);
  }
  const replacement = /^(\/\/?)([^/]*)(?:\/(.*))?$/.exec(rest);
  if (replacement !== null) {
    const pattern = replacement[2] as string;
    const by = replacement[3] ?? '';
    if (!PLAIN_PATTERN.test(pattern) || !PLAIN_REPLACEMENT.test(by)) return null;
    // An empty pattern replaces nothing in one shell and at every place in another; one that begins with
    // `#` or `%` is anchored, one that can be empty matches at every place, and a long one is a cost
    // that the value of a real name never comes to.
    if (
      pattern === '' ||
      /^[#%]/.test(pattern) ||
      /^\**$/.test(pattern) ||
      pattern.length > MAX_PATTERN_CHARS
    )
      return null;
    return replaced(value, pattern, by, replacement[1] === '//', budget);
  }
  const cut = /^:\s*(-?\d+)(?::\s*(-?\d+))?$/.exec(rest);
  if (cut !== null)
    return substring(value, Number(cut[1]), cut[2] === undefined ? undefined : Number(cut[2]));
  if (rest === '^^') return value.toUpperCase();
  if (rest === ',,') return value.toLowerCase();
  if (rest === '^') return value.charAt(0).toUpperCase() + value.slice(1);
  if (rest === ',') return value.charAt(0).toLowerCase() + value.slice(1);
  return null;
}
