import { armCommands, splitTop, type SplitCommand } from './shell-segments.js';

/**
 * A command cut at its own top level the way a shell cuts it, for the detectors that read
 * COMMANDS. The cut that makes `segments` (`splitTop`) ignores quotes, which suits the detectors
 * that read text, and does not suit one that has to know which words are a command's own.
 */

const HEREDOC_OPENER = /<<-?\s*(['"]?)([A-Za-z_]\w*)\1/y;

/** A lone `&` ends a command that runs in the background: not `&&`, `>&`, `<&`, `|&`, `&>`. */
function isBackgroundAmpersand(command: string, i: number, start: number): boolean {
  // Where nothing comes before it, it is PowerShell's call operator: `& ./clean.ps1`.
  if (command.charAt(i) !== '&' || command.slice(start, i).trim() === '') return false;
  const next = command.charAt(i + 1);
  const prev = command.charAt(i - 1);
  return next !== '&' && next !== '>' && !['>', '<', '&', '|'].includes(prev);
}

/**
 * The command's own top-level segments, cut only where the shell cuts: at `|`, `||`, `&&`,
 * `;` and a line break outside quotes. The plain cut (`splitTop`) ignores quotes, so
 * `perl -pi -e 's/a/b|c/' ~/.zshrc` lost its file to a segment `c/' ~/.zshrc`, and
 * `grep -E "a|crontab|b"` grew a segment `crontab` that bash never runs. A heredoc body is
 * not shell text, so an apostrophe in it opens no quote: its lines are cut as the plain
 * cut does, as before. A quote that never closes runs to the end, as it does in the shell,
 * which refuses the command. Without `bodies`, the lines of a heredoc are left out.
 */
export function splitTopQuoted(command: string, bodies = true): string[] {
  const out: string[] = [];
  const pending: string[] = [];
  let start = 0;
  let quote = '';
  const cut = (end: number): void => {
    const piece = command.slice(start, end).trim();
    if (piece !== '') out.push(piece);
  };
  for (let i = 0; i < command.length; i += 1) {
    const ch = command.charAt(i);
    if (quote !== '') {
      if (ch === '\\' && quote === '"') i += 1;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '<' && command.charAt(i + 1) === '<' && command.charAt(i + 2) !== '<') {
      HEREDOC_OPENER.lastIndex = i;
      const opener = HEREDOC_OPENER.exec(command);
      if (opener !== null) {
        pending.push(opener[2] as string);
        i = HEREDOC_OPENER.lastIndex - 1;
      }
      continue;
    }
    const two = command.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      cut(i);
      i += 1;
      start = i + 1;
      continue;
    }
    if (
      ch === ';' ||
      (ch === '|' &&
        command.charAt(i - 1) !== '>' &&
        !(command.charAt(i - 1) === '&' && command.charAt(i - 2) === '>')) ||
      isBackgroundAmpersand(command, i, start)
    ) {
      cut(i);
      if (ch === '|' && command.charAt(i + 1) === '&') i += 1;
      start = i + 1;
      continue;
    }
    if (ch !== '\n') continue;
    cut(i);
    start = i + 1;
    // The bodies of the heredocs this line opened, each up to its delimiter line.
    // An index, not `shift()`: a line that opens thousands of heredocs would make each
    // `shift` move the rest of the array.
    for (let next = 0; next < pending.length; next += 1) {
      const delimiter = pending[next] as string;
      let lineStart = start;
      while (lineStart <= command.length) {
        const lineEnd = command.indexOf('\n', lineStart);
        const end = lineEnd === -1 ? command.length : lineEnd;
        const line = command.slice(lineStart, end);
        lineStart = end + 1;
        if (line.trim() === delimiter) break;
        if (bodies) out.push(...splitTop(line));
        if (lineEnd === -1) break;
      }
      start = Math.min(lineStart, command.length);
      i = start - 1;
    }
    pending.length = 0;
  }
  if (quote === '' || start < command.length) cut(command.length);
  return out;
}

/**
 * The segments a detector that reads COMMANDS should see: the top level cut as the shell
 * cuts it (see `splitTopQuoted`), then the nested commands `splitCommand` extracted.
 */
export function commandSegments(command: string, split: SplitCommand): string[] {
  const top = splitTopQuoted(command);
  return [...top, ...armCommands(top), ...split.segments.slice(split.topLevel)];
}

/**
 * The segments the command itself runs, as `commandSegments` cuts them: its top level and the arms
 * of its compound commands, without the lines of a heredoc and without the commands read out of it
 * (an `sh -c` body, a substitution), which a reader takes with less certainty about what is a command.
 */
export function ownCommandSegments(command: string): string[] {
  const top = splitTopQuoted(command, false);
  const resolved = withLiteralVariables(top);
  return [...new Set([...top, ...armCommands(top), ...resolved, ...armCommands(resolved)])];
}

/** `NAME=value` alone in a segment, its value a literal: no expansion, no substitution. */
const LITERAL_ASSIGNMENT =
  /^\s*(?:export\s+)?([A-Za-z_]\w*)=((?:[^\s$`'"\\]|\\.)*|'[^']*'|"[^"$`\\]*")\s*$/;
const VARIABLE = /\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/g;
/**
 * The words that open a clause before its command: `then`, `do`, `!`, a group, and the head of a
 * function whose body it starts (`f() { read P`), which is taken where it is defined.
 */
const CLAUSE_OPENERS =
  /^\s*(?:(?:do|then|else|elif|if|while|until|!)\s+|[({]\s*|function\s+[\w-]+\s*(?:\(\))?\s*\{?\s*|[\w-]+\s*\(\)\s*\{?\s*)*/;
/** A name given a value at the front of a command: `NAME=`, `NAME+=`, `NAME[0]=`, the `A=1` of `A=1 cmd`. */
const FRONT_ASSIGNMENT = /^([A-Za-z_]\w*)(?:\[[^\]\s]*\])?\+?=\S*\s*/;
/** A redirect at the front of a command, which assignments may follow: `>/dev/null S=x`. */
const FRONT_REDIRECT = /^\d*(?:&>>?|>>?|<<<|<&|>&|<)\s*\S+\s*/;
/** Commands that hand the command after them the names their `NAME=value` words give: `env S=x cmd`. */
const PASSES_NAMES: ReadonlySet<string> = new Set(['env', 'sudo']);
/** Loops that give the name after their keyword each value in turn. */
const LOOPS: ReadonlySet<string> = new Set(['for', 'select']);
/** Commands that give names among their words a value, or take it away. */
const GIVES_NAMES: ReadonlySet<string> = new Set([
  'read',
  'mapfile',
  'readarray',
  'getopts',
  'unset',
  'let',
]);
/** Commands that declare names: a name is given a value after its `=`, and any name by `-n`. */
const DECLARES: ReadonlySet<string> = new Set([
  'export',
  'readonly',
  'declare',
  'typeset',
  'local',
]);
/** Commands that may give any name a value: the text they run, or a file they read in. */
const GIVES_ANY: ReadonlySet<string> = new Set(['eval', 'source', '.']);
/** An arithmetic expression, which may give any name in it a value: `(( S = 1 ))`, `$((S++))`. */
/** A bracket of arithmetic or a subscript, which may give a bare name in it a value: `$[ S = 1 ]`, `a[S=1]=x`. */
const BRACKET = /\[([^\][]*)\]/g;
/** A bare name, not one read with `$` or inside `${…}`. */
const BARE_NAMES = /(?<![$\w{])[A-Za-z_]\w*/g;
/** An expansion that gives a name a value when it has none: `${S:=x}`, `${S=x}`. */
const DEFAULT_ASSIGNMENT = /\$\{([A-Za-z_]\w*):?=/g;
/** Words that run the command after them, and its options, as it is: `builtin read x`, `command -p read x`. */
const PASS_THROUGH: ReadonlySet<string> = new Set(['builtin', 'command', 'time']);
/** A word as the shell reads it, without its quotes and backslashes: `\read`, `"read"`. */
const plainWord = (word: string): string => word.replace(/\\(.)/g, '$1').replace(/["']/g, '');
/** The longest value put in a variable's place: a longer one is left as written. */
const MAX_LITERAL_CHARS = 2048;
/** What one segment may grow by as its variables are put in their place; past it, the rest stay as written. */
const MAX_SEGMENT_GROWTH = 32 * 1024;
const NONE: ReadonlySet<string> = new Set();

/**
 * The names a segment gives a value or takes it from, at its place in the line, or `null` when it
 * may give any name one. Only the front of a command assigns: `echo S=1` and `make S=1` pass a word.
 */
function namesGiven(segment: string): readonly string[] | null {
  const front = namesGivenByCommand(segment);
  if (front === null || computesSubstring(segment)) return null;
  // Anywhere in the segment, not only at its front: arithmetic from its `((` on, however deep it nests
  // (`(( S = 1 ))`, `$((S++))`), a bracket of arithmetic or a subscript, and a default assignment.
  const arithmetic = segment.indexOf('((');
  const inExpressions = [
    ...(arithmetic === -1 ? [] : (segment.slice(arithmetic).match(BARE_NAMES) ?? [])),
    ...[...segment.matchAll(BRACKET)].flatMap((m) => (m[1] as string).match(BARE_NAMES) ?? []),
    ...[...segment.matchAll(DEFAULT_ASSIGNMENT)].map((m) => m[1] as string),
  ];
  return inExpressions.length === 0 ? front : [...front, ...inExpressions];
}

/** A character an offset or a length made of numbers may hold: digits, a sign, a colon, blanks. */
const numeric = (c: string): boolean =>
  (c >= '0' && c <= '9') || c === '-' || c === ':' || c === ' ' || c === '\t' || c === '\n';

/**
 * Whether a substring expansion's offset or length is more than numbers (`${X:S=1}`, `${@:$Y}`,
 * `${a[${i}]:S=1}`): it is arithmetic, which can give any name a value. Read once, keeping one frame
 * per `${` that is open, so an expansion nested in another is read in its turn and the outer one goes
 * on after it closes. One left open past a substring's colon is taken to be such an expansion: the
 * line was cut inside it (`${X:S=1|0}` at its `|`). One left open before any colon is not (a heredoc's
 * `${spec%%|*}`, cut the same way).
 */
function computesSubstring(segment: string): boolean {
  const frames: { colon: boolean; substring: boolean; computed: boolean }[] = [];
  for (let i = 0; i < segment.length; i += 1) {
    const c = segment[i] as string;
    const top = frames[frames.length - 1];
    if (c === '$' && segment[i + 1] === '{') {
      if (top?.substring === true) top.computed = true;
      frames.push({ colon: false, substring: false, computed: false });
      i += 1;
      continue;
    }
    if (top === undefined) continue;
    if (c === '}') {
      frames.pop();
      if (top.substring && top.computed) return true;
    } else if (!top.colon && c === ':') {
      // `:-`, `:=`, `:?` and `:+` are not a substring; a default assignment is read on its own.
      top.colon = true;
      top.substring = !'-=?+'.includes(segment[i + 1] ?? '-');
    } else if (top.substring && !numeric(c)) top.computed = true;
  }
  return frames.some((frame) => frame.substring);
}

/** The names the command of a segment gives a value, at its front or by what it is (`read`, `export`). */
function namesGivenByCommand(segment: string): readonly string[] | null {
  const names: string[] = [];
  let command = segment.replace(CLAUSE_OPENERS, '');
  for (;;) {
    const m = FRONT_ASSIGNMENT.exec(command) ?? FRONT_REDIRECT.exec(command);
    if (m === null) break;
    if (m[1] !== undefined) names.push(m[1]);
    command = command.slice(m[0].length);
  }
  const words = shellWords(command).map(plainWord);
  let first = 0;
  while (PASS_THROUGH.has(words[first] ?? '')) {
    first += 1;
    while ((words[first] ?? '').startsWith('-')) first += 1;
  }
  const head = words[first] ?? '';
  const rest = words.slice(first + 1);
  if (GIVES_ANY.has(head)) return null;
  if (LOOPS.has(head)) {
    const name = rest[0] ?? '';
    // `for ((i = 0; …))` counts with the names in its arithmetic.
    if (name.startsWith('((')) return [...names, ...(rest.join(' ').match(/[A-Za-z_]\w*/g) ?? [])];
    // Without a name after it, it is no loop a shell runs (`for (const n of a)`, SQL's `select 1`).
    return /^[A-Za-z_]\w*$/.test(name) ? [...names, name] : names;
  }
  // `printf -v NAME`, however the option is written (`-vNAME`, `-v"NAME"`), may give any name.
  if (head === 'printf') return rest.some((word) => word.startsWith('-v')) ? null : names;
  if (PASSES_NAMES.has(head))
    return [...names, ...rest.flatMap((word) => /^([A-Za-z_]\w*)=/.exec(word)?.[1] ?? [])];
  // A name spelled with an expansion (`read "$n"`) may be any name; any other is taken in whatever
  // way it is written (`read P<f`, `read "P"`): each word of a name's shape counts.
  if (GIVES_NAMES.has(head))
    return rest.some((word) => /[$`]/.test(word))
      ? null
      : [...names, ...rest.flatMap((word) => word.match(/[A-Za-z_]\w*/g) ?? [])];
  if (DECLARES.has(head)) {
    for (const word of rest) {
      // `declare -n ref=S` makes one name stand for another, which a later `ref=x` then changes.
      if (/^-\w*n/.test(word)) return null;
      if (word.startsWith('-')) continue;
      const at = word.indexOf('=');
      const name = (at === -1 ? word : word.slice(0, at)).replace(/\+$/, '').replace(/\[.*$/, '');
      if (/[$`]/.test(name)) return null;
      if (at !== -1 && /^[A-Za-z_]\w*$/.test(name)) names.push(name);
    }
  }
  return names;
}

/** The names a segment assigns at its front (`S=x`, `>f S=x cmd`), as a shell would in any text. */
function frontNames(segment: string): string[] {
  const names: string[] = [];
  let command = segment.replace(CLAUSE_OPENERS, '');
  for (;;) {
    const m = FRONT_ASSIGNMENT.exec(command) ?? FRONT_REDIRECT.exec(command);
    if (m === null) return names;
    if (m[1] !== undefined) names.push(m[1]);
    command = command.slice(m[0].length);
  }
}

/** A command's words as the shell cuts them at blanks, quotes kept: `MSG="a $x b"` is one. */
function shellWords(command: string): string[] {
  const out: string[] = [];
  let word = '';
  let quote = '';
  for (let i = 0; i < command.length; i += 1) {
    const ch = command.charAt(i);
    if (ch === '\\' && quote !== "'") {
      word += ch + command.charAt(i + 1);
      i += 1;
    } else if (quote !== '') {
      word += ch;
      if (ch === quote) quote = '';
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      word += ch;
    } else if (/\s/.test(ch)) {
      if (word !== '') out.push(word);
      word = '';
    } else word += ch;
  }
  if (word !== '') out.push(word);
  return out;
}

export interface LiteralVariables {
  readonly segments: string[];
  /**
   * Names the line gives more than one value (`S=a; S=b`, `P=1; read P`, a body's `S=b` after the
   * line's `S=a`): which of them a piece read out of the command sees is not known, so none is put in
   * there.
   */
  readonly changing: ReadonlySet<string>;
  /** Names the line gives a literal value somewhere: one of them left as written lost what it held. */
  readonly literal: ReadonlySet<string>;
}

/**
 * The segments with the variables the command sets to a literal put in their place, as the shell
 * runs the line (`d=/tmp/x; $d/install` runs `/tmp/x/install`): those are the command's own too. A
 * name keeps its value until the line gives it another, in any way (`P=$(curl …)`, `read P`, `for
 * P in`, `eval`); a variable it does not set is left as written. The pieces read out of the command
 * (`own` false) come after its own segments in the list, not where they run: a name that changes as
 * the line runs is left as written there. What is put in is bounded, because the command is the
 * agent's: a 38 KB line of one long value used four thousand times grew to 120 MB.
 */
export function literalVariables(
  segments: readonly string[],
  own: (index: number) => boolean = () => true,
): LiteralVariables {
  /**
   * Runs one segment against the values known: what it reads as with them put in (but for the names
   * in `skip`), and how it changes them. Each way a name is given a value goes to `way`, as the value
   * it is given (`T=$S/x` and the `T=/tmp/x` another reading of the line made of it are one) or as
   * the text that gives it.
   */
  const step = (
    values: Map<string, string>,
    segment: string,
    skip: ReadonlySet<string>,
    way: (name: string, how: string) => void,
  ): string => {
    let room = MAX_SEGMENT_GROWTH;
    const text = segment.replace(VARIABLE, (whole, braced?: string, plain?: string) => {
      const name = (braced ?? plain) as string;
      if (skip.has(name)) return whole;
      const value = values.get(name);
      if (value === undefined || value.length > room) return whole;
      room -= value.length;
      return value;
    });
    const set = LITERAL_ASSIGNMENT.exec(text);
    if (set !== null) {
      const name = set[1] as string;
      const value = (set[2] as string).replace(/^(['"])(.*)\1$/s, '$2');
      way(name, `=${value}`);
      // A value too long to put in is not known here, and nor is the shorter one it replaced.
      if (value.length <= MAX_LITERAL_CHARS) values.set(name, value);
      else values.delete(name);
      return text;
    }
    const names = namesGiven(text);
    for (const name of names ?? [...values.keys()]) {
      way(name, text);
      values.delete(name);
    }
    return text;
  };
  // How the line's own segments give each name a value, in their order: two ways is a name that
  // changes as the line runs.
  const ways = new Map<string, Set<string>>();
  const literal = new Set<string>();
  const ownValues = new Map<string, string>();
  segments.forEach((segment, index) => {
    if (own(index))
      step(ownValues, segment, NONE, (name, how) => {
        ways.set(name, (ways.get(name) ?? new Set()).add(how));
        if (how.startsWith('=')) literal.add(name);
      });
  });
  const changing = new Set([...ways].filter(([, how]) => how.size > 1).map(([name]) => name));
  const values = new Map<string, string>();
  const out = segments.map((segment, index) => {
    if (own(index)) return step(values, segment, NONE, () => undefined);
    // A piece that assigns a name the line set another value (a body's `S=b`, a heredoc's data line
    // read as one) makes it a name that changes: which value a later piece sees is not known. Only an
    // assignment counts: the other words of a piece may be another language's (`select 1`, `let x`).
    let front: string[] | undefined;
    return step(values, segment, changing, (name, how) => {
      if (how.startsWith('=')) literal.add(name);
      front ??= frontNames(segment);
      const known = values.get(name);
      if (
        known !== undefined &&
        how !== `=${known}` &&
        (how.startsWith('=') || front.includes(name))
      )
        changing.add(name);
    });
  });
  return { segments: out, changing, literal };
}

/** `literalVariables` for segments that are all the command's own. */
export function withLiteralVariables(segments: readonly string[]): string[] {
  return literalVariables(segments).segments;
}
