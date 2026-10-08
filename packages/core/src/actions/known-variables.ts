import type { Lexed } from './shell-lex.js';

/**
 * A command with the variables it sets to a word it spells out, put where they are used.
 *
 * `x=rm; $x -rf ~`, `a=r; b=m; $a$b -rf ~`, `f=x.sh; cat "$f" | bash` and `d=~; rm -rf $d` run
 * what the text of the command does not say: the classifier reads words, and a command word that
 * is a variable names no command. The shell that runs the line has the value, and the line holds
 * it, so the second reading is the line as that shell would expand it, read as a text of its own.
 * It adds what a reader of the first would have missed and takes nothing away; where it cannot say
 * (a value that is itself an expansion, a name that is set in a loop or read from a file) it says
 * nothing, and the first reading stands.
 */

/** The longest value that is put in place of a variable, and the most uses it is put in. */
const MAX_VALUE_CHARS = 256;
const MAX_SUBSTITUTIONS = 4096;
/** The longest command whose variables are put in place: a larger one is not read twice. */
const MAX_COMMAND_CHARS = 128 * 1024;

/**
 * What may stand in a word as it is written, with nothing a shell would read as more than text or
 * a pattern: a variable's value is not expanded where it is set, only where it is used, so a
 * pattern in it (`f=x.s?; bash $f`) is a pattern in the word it makes, and a blank in it
 * (`x='rm -rf ~'; $x`) is where bash splits the word.
 */
const PLAIN_VALUE = /^[\w./~:@%+=,*?[\]{} -]*$/;
/**
 * What may stand before an assignment in a stage the lexer cut: `then c=rm`, `{ c=rm`, `(c=rm`,
 * `!(c=rm` and the head of a function, `f() { c=rm`.
 */
const CONTROL_LEAD =
  /^(?:(?:then|do|else|elif|if|while|until|time|!)(?:\s+|(?=\()|$)|function\s+[A-Za-z_][\w.+-]*\s*(?:\(\)\s*)?|[A-Za-z_][\w.+-]*\s*\(\)\s*|[({]\s*)+/;
/** Words that put an assignment after them: `export x=1`, `declare -r x=1`. */
const DECLARATION = /^(?:export|declare|typeset|local|readonly)(?:\s+-[A-Za-z]+)*\s+/;
/** What a value that is not quoted may hold: the same, but for the blank, which ends it. */
const BARE_VALUE = /^[\w./~:@%+=,*?[\]{}-]*/;

/** The most items of a loop that are tried one by one. */
const MAX_LOOP_ITEMS = 4;
const LOOP_HEAD = /^for\s+([A-Za-z_]\w*)\s+in\s+([^;]*)$/;
const LOOP_ITEM = /^[\w./~:@%+=,*?[\]{}-]+$/;

/**
 * `for f in a.sh b.sh`: the variable stands for each item in turn, so each is read in its place,
 * one reading per item. `choice` says which; a list with fewer items is read with its last.
 */
function loopBinding(stage: string, choice: number): readonly (readonly [string, string])[] | null {
  const head = LOOP_HEAD.exec(stage);
  if (head === null) return null;
  const items = (head[2] as string).trim().split(/\s+/);
  if (
    items.length > MAX_LOOP_ITEMS ||
    !items.every((w) => LOOP_ITEM.test(w) && w.length <= MAX_VALUE_CHARS)
  )
    return [];
  return [[head[1] as string, items[Math.min(choice, items.length - 1)] as string]];
}

/** The variables a stage sets to a word it spells out, or none when the stage is anything else. */
function assignmentsOf(stage: string, choice = 0): readonly (readonly [string, string])[] {
  const loop = loopBinding(stage, choice);
  if (loop !== null) return loop;
  const found: (readonly [string, string])[] = [];
  let rest = stage.replace(CONTROL_LEAD, '').replace(DECLARATION, '');
  for (;;) {
    const name = /^([A-Za-z_]\w*)=/.exec(rest)?.[1];
    if (name === undefined) return rest === '' ? found : [];
    rest = rest.slice(name.length + 1);
    let value: string;
    const quote = rest.charAt(0);
    if (quote === "'") {
      const close = rest.indexOf("'", 1);
      if (close === -1) return [];
      value = rest.slice(1, close);
      rest = rest.slice(close + 1);
    } else if (quote === '"') {
      const close = rest.indexOf('"', 1);
      const inner = close === -1 ? '' : rest.slice(1, close);
      // Inside double quotes an expansion or an escape makes the value one that is not known.
      if (close === -1 || /[$`\\]/.test(inner)) return [];
      value = inner;
      rest = rest.slice(close + 1);
    } else {
      value = BARE_VALUE.exec(rest)?.[0] ?? '';
      rest = rest.slice(value.length);
    }
    // A value is the whole of a word: what follows it is a blank, or the end, or not an assignment.
    if (rest !== '' && !/^\s/.test(rest)) return [];
    rest = rest.trimStart();
    found.push([name, value]);
  }
}

/**
 * `text` from `from` on with `$name` and `${name}` replaced by the values `known` holds, outside
 * single quotes. A value that is only plain characters goes in as it is, where it may split into
 * words as the shell splits it; any other goes in quoted where it is not already, and is left
 * out of double quotes, which it could end.
 */
function substituted(
  text: string,
  from: number,
  to: number,
  known: ReadonlyMap<string, string>,
  budget: { left: number },
): string {
  const parts: string[] = [];
  let quote = '';
  for (let i = from; i < to; i += 1) {
    const ch = text.charAt(i);
    if (quote === "'") {
      if (ch === "'") quote = '';
    } else if (ch === '\\') {
      parts.push(ch, text.charAt(i + 1));
      i += 1;
      continue;
    } else if (ch === "'" && quote === '') quote = "'";
    else if (ch === '"') quote = quote === '"' ? '' : '"';
    else if (ch === '$' && budget.left > 0) {
      const braced = text.charAt(i + 1) === '{';
      const start = i + (braced ? 2 : 1);
      // zsh's `$~name` and `${~name}` expand the value as a pattern, which is how it is put in.
      const first = start + (text.charAt(start) === '~' ? 1 : 0);
      const name = /^[A-Za-z_]\w*/.exec(text.slice(first, first + 64))?.[0];
      const end = name === undefined ? -1 : first + name.length;
      const closed = !braced || text.charAt(end) === '}';
      const value = name === undefined ? undefined : known.get(name);
      if (value !== undefined && closed) {
        const plain = PLAIN_VALUE.test(value);
        if (plain || quote === '') {
          budget.left -= 1;
          parts.push(plain ? value : `'${value.replaceAll("'", "'\\''")}'`);
          i = braced ? end : end - 1;
          continue;
        }
      }
    }
    parts.push(ch);
  }
  return parts.join('');
}

/**
 * The text with the variables it sets to a literal replaced where they are used after being set:
 * one reading, or one for each item of a loop that binds a variable. None when it sets none, uses
 * none, or would grow past what is read.
 */
export function withKnownVariables(text: string, lexed: Lexed, limit: number): string[] {
  if (text.length > MAX_COMMAND_CHARS || !/=|\bfor\s/.test(text)) return [];
  const choices = /\bfor\s+\w+\s+in\b/.test(text) ? MAX_LOOP_ITEMS : 1;
  const readings = new Set<string>();
  for (let choice = 0; choice < choices; choice += 1) {
    const reading = readWith(text, lexed, limit, choice);
    if (reading !== null) readings.add(reading);
  }
  return [...readings];
}

function readWith(text: string, lexed: Lexed, limit: number, choice: number): string | null {
  const known = new Map<string, string>();
  const budget = { left: MAX_SUBSTITUTIONS };
  const parts: string[] = [];
  let at = 0;
  for (const pipeline of lexed.pipelines) {
    for (const stage of pipeline) {
      const from = text.indexOf(stage.text, stage.at);
      if (from === -1 || from < at) continue;
      const set = assignmentsOf(stage.text, choice);
      // The text up to the end of the command that sets them is read as written, the rest with them.
      const end = from + stage.text.length;
      parts.push(
        known.size === 0 ? text.slice(at, end) : substituted(text, at, end, known, budget),
      );
      at = end;
      for (const [name, value] of set) {
        if (value.length <= MAX_VALUE_CHARS) known.set(name, value);
        else known.delete(name);
      }
    }
  }
  if (known.size === 0) return null;
  parts.push(substituted(text, at, text.length, known, budget));
  const out = parts.join('');
  return out === text || out.length > limit ? null : out;
}
