import {
  BARE_REDIRECT,
  REDIRECT,
  rawWords,
  redirectsOf,
  unquoteWord,
  withArguments,
  type RawWord,
  type Substituted,
} from './function-arguments.js';
import {
  MAX_NAME_CHARS,
  MAY_DEFINE,
  functionKey,
  functionsDefinedIn,
  type FunctionDefinition,
} from './function-definitions.js';
import { newFormBudget, type FormBudget } from './parameter-forms.js';
import { readingCost } from './reading-cost.js';
import type { Lexed } from './shell-lex.js';
import { resolve } from './shell-words.js';

export { withArguments } from './function-arguments.js';
export { functionKey, functionsDefinedIn, inheritedFunctions } from './function-definitions.js';
export type { FunctionDefinition } from './function-definitions.js';

/**
 * A function that a command defines and then calls: `g() { git "$@"; }; g rebase -x '…'`, `f() { rm
 * "$@"; }; f -rf ~`. What every reader of a command looks for is a program by its name, and the call is
 * `g`, with the program in a body that is somewhere else and the words it is given in the call. The call
 * is read as the body with the words put where they are used (`"$@"`, `$*`, `$1`), as one more reading of
 * the text, which the readers read as they read the rest: `git rebase -x '…'`, `rm -rf ~`.
 *
 * A function is there for every text that is read from the command that defines it: a substitution
 * (`echo $(g -rf ~)`), an `eval` argument, a `trap` body, and a shell that is given the function by
 * `export -f`. So the definitions of the whole command are put to each of its texts, and a name that is
 * defined twice (in the two arms of an `if`) is read as both bodies.
 *
 * What is not read is said, and not left out: a call that is left after the levels that are followed, a
 * body that is too long, has a function of its own in it, a document that never ends, or is a compound
 * command other than a group and a subshell (`f() if …`), more definitions than are read, a call that
 * cannot be found in the text (a name made with `$'…'`), and a body that uses its parameters in a way that
 * is not put in place (`${1%x}`, `${@: -2}`, `getopts`, `set --`, a `shift` in a loop). A command that
 * calls a function in a way that is not read is a question. It follows no function that the command does
 * not define (a function a shell has from its startup file is not in the text).
 *
 * Where a definition ends is found by a reading of its own, and a quote can make it disagree with the
 * shell, so no call is skipped for standing inside a body: a stage that begins with `command` or
 * `builtin` is the one thing that is not a call, because those two never run a function. A function
 * that is named like a wrapper (`sudo() { …; }; sudo -rf ~`) is the call: the function is looked up
 * before the program, and the first word of the stage is the one that runs.
 */

/** The most calls put in place a level, and how deep. */
const MAX_CALLS = 256;
const MAX_ROUNDS = 5;
/**
 * The most bodies a name that is defined more than once is read as. A loop that sets a variable is
 * read once for each of its items (four at most, and again with the substitutions put in place), and each
 * of those readings holds its own copy of a function that the loop is in.
 */
const MAX_BODIES_PER_NAME = 12;
/**
 * The longest text whose calls are put in place: each level is a copy of it, read again by every
 * reader, and the time a hook may take is the same for a text of a megabyte. A longer one that calls a
 * function is asked about.
 */
const MAX_INLINED_TEXT_CHARS = 64 * 1024;

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

interface Call {
  /** Where the command word is, and where the stage ends. */
  readonly start: number;
  readonly end: number;
  readonly bodies: readonly string[];
  /** What follows the word in the stage: the words the function is given, and the redirects of the call. */
  readonly args: string;
}

/** The functions in force for a text: its own, and the ones it is given; a name defined twice has both. */
function definedFor(
  own: readonly FunctionDefinition[],
  inherited: readonly FunctionDefinition[],
): Map<string, FunctionDefinition[]> {
  const byName = new Map<string, FunctionDefinition[]>();
  const seen = new Set<string>();
  for (const definition of [...own, ...inherited]) {
    const key = functionKey(definition);
    if (seen.has(key)) continue;
    seen.add(key);
    byName.set(definition.name, [...(byName.get(definition.name) ?? []), definition]);
  }
  return byName;
}

/** Where in a stage the word that is the command stands, and how long it is as written; null where it is not found. */
function wordAt(
  stage: string,
  word: string,
): { readonly at: number; readonly length: number } | null {
  // A name past this is not looked for: the pattern would be as long, and is not one a shell is given.
  if (word.length > MAX_NAME_CHARS) return null;
  const plain = new RegExp(`(^|[\\s{(!])${escaped(word)}(?=\\s|$)`).exec(stage);
  if (plain !== null) return { at: plain.index + (plain[1] as string).length, length: word.length };
  // Spelled with quotes or escapes (`"g" -rf ~`, `\g`, `g''`).
  const spelled = rawWords(stage).find((each) => unquoteWord(each.text) === word);
  return spelled === undefined ? null : { at: spelled.at, length: spelled.text.length };
}

/** Words that stand before the command of a stage and are not it. */
const BEFORE_COMMAND: ReadonlySet<string> = new Set([
  '{',
  '(',
  '!',
  'if',
  'then',
  'else',
  'elif',
  'while',
  'until',
  'do',
  'time',
]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/;
/**
 * Wrappers that may run the command after them as a function: zsh's `noglob f`, `nocorrect f` and `coproc f`
 * run it in the shell that holds the functions, and `parallel f` and `watch f` start a shell that has the
 * ones that were exported. Any other (`sudo`, `env`, `nice`, `timeout`, `xargs`, `exec`, `command`) starts a
 * program of that name, which a function is not (`ls() { sudo ls "$@"; }` is the program `ls` and not a call
 * of itself), and `eval` reads its argument as a text of its own, where the call is found.
 */
const SEES_FUNCTIONS: ReadonlySet<string> = new Set([
  'noglob',
  'nocorrect',
  'coproc',
  'parallel',
  'watch',
]);

/**
 * The first word of a stage that the shell runs: past `{`, `(`, `!`, `then`, `do`, `time`, the
 * assignments and the redirects that come before it. A function is looked up by this word, and not by
 * the word a wrapper runs: `sudo() { …; }; sudo -rf ~` runs the function.
 */
function leadingWord(stage: string): RawWord | null {
  const words = rawWords(stage);
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i] as RawWord;
    let text = word.text;
    let at = word.at;
    // `(f` and `!f`: the opener is written against the word.
    while (text.length > 1 && (text.startsWith('(') || text.startsWith('!'))) {
      text = text.slice(1);
      at += 1;
    }
    if (BEFORE_COMMAND.has(text) || ASSIGNMENT.test(text)) continue;
    if (REDIRECT.test(text)) {
      if (BARE_REDIRECT.test(text)) i += 1;
      continue;
    }
    return { text, at };
  }
  return null;
}

/**
 * Each call of a function in the stages of a text, and whether one is left that cannot be put in place:
 * its body is not read, there are too many bodies, or the stage is not where the lexer said.
 */
function callsIn(
  text: string,
  lexed: Lexed,
  own: readonly FunctionDefinition[],
  inherited: readonly FunctionDefinition[],
): { readonly calls: Call[]; readonly unread: boolean } {
  const byName = definedFor(own, inherited);
  const calls: Call[] = [];
  if (byName.size === 0) return { calls, unread: false };
  let unread = false;
  for (const pipeline of lexed.pipelines)
    for (const stage of pipeline) {
      // Every stage is read: a name may be spelled with quotes, escapes or `$'…'`, which no pattern over
      // the text finds.
      const resolved = resolve(stage.text);
      // A stage that opens a definition (`h() { g "$@"`) holds the first command of a body: it is not run
      // where the function is defined.
      if (resolved !== null && resolved.defined.length > 0) continue;
      let name: string | undefined;
      let spelled: { readonly at: number; readonly length: number } | null = null;
      const lead = leadingWord(stage.text);
      const leadName = lead === null ? undefined : unquoteWord(lead.text);
      if (lead !== null && leadName !== undefined && byName.has(leadName)) {
        name = leadName;
        spelled = { at: lead.at, length: lead.text.length };
      } else if (
        resolved !== null &&
        byName.has(resolved.word) &&
        resolved.wrappers.every((wrapper) => SEES_FUNCTIONS.has(wrapper))
      ) {
        name = resolved.word;
        spelled = wordAt(stage.text, name);
      } else continue;
      const from = text.indexOf(stage.text, stage.at);
      if (spelled === null || from === -1) {
        unread = true;
        continue;
      }
      const group = byName.get(name) as FunctionDefinition[];
      const readable = group.filter((d) => d.body !== null);
      if (readable.length < group.length || group.length > MAX_BODIES_PER_NAME) unread = true;
      if (readable.length === 0 || group.length > MAX_BODIES_PER_NAME) continue;
      calls.push({
        start: from + spelled.at,
        end: from + stage.text.length,
        bodies: readable.map((d) => d.body as string),
        args: stage.text.slice(spelled.at + spelled.length),
      });
    }
  return { calls, unread };
}

/** The text without the semicolons and blanks that end it: one pass, where a pattern for them backtracks over every run. */
function withoutTrailingSeparators(text: string): string {
  let end = text.length;
  while (end > 0 && /[;\s]/.test(text.charAt(end - 1))) end -= 1;
  return text.slice(0, end);
}

/**
 * The call as the body it runs, as a group, so that what it is piped into or redirected to is what the body
 * is. A body of lines is kept as lines, closed on a line of its own, because the end of a document is a line
 * (`PY`) and cannot be followed by `; }`. The redirects of the call stay with it, after the group, so that a
 * document that the call is given (`w notes.md <<'EOF'`) is still the input of what it runs, and the lines of
 * it that follow are still text.
 */
function inPlaceOf(call: Call, limit: number, forms: FormBudget): Substituted {
  let complete = true;
  let spent = 0;
  const groups: string[] = [];
  for (const body of call.bodies) {
    const put = withArguments(body, call.args, limit - spent, forms);
    if (put.overflow === true) return { text: '', complete: false, overflow: true };
    complete &&= put.complete;
    const read = put.text;
    const group = read.includes('\n')
      ? `{\n${read.trimStart()}${read.endsWith('\n') ? '' : '\n'}}`
      : `{ ${withoutTrailingSeparators(read.trim()) || ':'}; }`;
    spent += group.length;
    groups.push(group);
  }
  const group = groups.length === 1 ? (groups[0] as string) : `{ ${groups.join('; ')}; }`;
  const redirects = redirectsOf(rawWords(call.args));
  return { text: redirects.length === 0 ? group : `${group} ${redirects.join(' ')}`, complete };
}

/**
 * One round: each call of a function in force is replaced by its body, with what the call is given
 * put in. Null where there is nothing to replace, or it would grow past `limit`.
 */
function inlineOnce(
  text: string,
  lexed: Lexed,
  limit: number,
  inherited: readonly FunctionDefinition[],
  forms: FormBudget,
): { readonly out: string | null; readonly incomplete: boolean } {
  const { calls } = callsIn(text, lexed, functionsDefinedIn(text).definitions, inherited);
  const parts: string[] = [];
  let at = 0;
  let put = 0;
  let size = 0;
  let incomplete = false;
  for (const call of calls) {
    if (put >= MAX_CALLS) break;
    if (call.start < at) continue;
    // What the body may still come to: it is not built past it, whatever the words it is given are.
    const room = limit - size - (call.start - at) - (text.length - call.end);
    if (room < 0) return { out: null, incomplete };
    const body = inPlaceOf(call, room, forms);
    if (body.overflow === true) return { out: null, incomplete: true };
    incomplete ||= !body.complete;
    size += call.start - at + body.text.length;
    // Past the limit it is not built: a text of sixteen kilobytes for each of two hundred calls is a
    // string of megabytes that is thrown away.
    if (size + text.length - call.end > limit) return { out: null, incomplete };
    parts.push(text.slice(at, call.start), body.text);
    at = call.end;
    put += 1;
  }
  if (put === 0) return { out: null, incomplete: false };
  parts.push(text.slice(at));
  const out = parts.join('');
  return out === text ? { out: null, incomplete } : { out, incomplete };
}

export interface InlinedFunctions {
  /** The text with the calls put in place as their bodies, a level at a time. */
  readonly readings: string[];
  /** A call is left that is not read: past the levels followed, a body that is not read, no more room. */
  readonly unread: boolean;
}

const NOTHING: InlinedFunctions = { readings: [], unread: false };

/**
 * The text with the calls of the functions in force put in place as their bodies, a level at a time:
 * the functions the text defines, and those that `inherited` holds, which are defined in the text it was
 * read from. `cost` is what reading the texts that are made may come to (see `readingCost`): a level is
 * lexed to find the calls of the next, so one that costs more is not made, and is a question.
 */
export function withInlinedFunctions(
  text: string,
  lexed: Lexed,
  lexOf: (text: string) => Lexed,
  limit: number,
  inherited: readonly FunctionDefinition[] = [],
  cost = Infinity,
  forms: FormBudget = newFormBudget(),
): InlinedFunctions {
  if (inherited.length === 0 && !MAY_DEFINE.test(text)) return NOTHING;
  if (text.length > MAX_INLINED_TEXT_CHARS) {
    const found = callsIn(text, lexed, functionsDefinedIn(text).definitions, inherited);
    return { readings: [], unread: found.unread || found.calls.length > 0 };
  }
  const readings: string[] = [];
  let current = text;
  let currentLexed = lexed;
  let incomplete = false;
  let spend = cost;
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const next = inlineOnce(current, currentLexed, limit, inherited, forms);
    incomplete ||= next.incomplete;
    if (next.out === null) break;
    const price = readingCost(next.out);
    if (price > spend) break;
    spend -= price;
    readings.push(next.out);
    current = next.out;
    currentLexed = lexOf(next.out);
  }
  const left = callsIn(current, currentLexed, functionsDefinedIn(current).definitions, inherited);
  return { readings, unread: incomplete || left.unread || left.calls.length > 0 };
}
