import { optionTakesValue } from './shell-wrappers.js';
import type { FunctionDefinition } from './inlined-functions.js';
import { flattened } from './shell-names.js';
import { splitCommand, splitSegments, type SplitCommand } from './shell-segments.js';
import { resolve, withoutRedirects } from './shell-words.js';

/**
 * Stroq's own commands that change what it enforces: `untaint` clears a session's
 * taint, `trust <file>` waives the scan of a file, `init` and `uninstall` rewrite the
 * hooks. They touch no path the self-tamper gate protects — the state lives under
 * `~/.stroq` — so without this an agent could run them through Bash, in a tainted
 * session, and undo the decision that was about to stop it. They are the user's to
 * run, outside the agent. Asking how one works (`--help`, `-h`), `--dry-run`, `trust`
 * with no file and every reading command stay open.
 *
 * Judged on the whole command rather than on the segments the self-tamper gate reads,
 * because those are cut at every newline: a commit message or a heredoc body with a
 * line that starts `stroq init` was a "command" there, and denied. `joinText` first
 * folds the newlines of text — a quoted argument, a heredoc fed to anything but a
 * shell — so only lines a shell would run are read as commands; a string handed to
 * `sh -c` or `eval`, and a heredoc fed to a shell, keep theirs.
 */
export function stroqStateSignals(command: string): string[] {
  return stateSignalsOf(splitSegments(joinText(command)));
}

/**
 * Whether a text names Stroq at all, as the words that run it are spelled (`stroq`, `@stroq/cli`, the entry of
 * a checkout). What does not is no command of it, and is not read for the commands it holds.
 */
const NAMES_STROQ = /stroq|packages[\\/]cli[\\/]dist[\\/]index\.js/i;
const namesStroq = (text: string): boolean =>
  NAMES_STROQ.test(text) || (/['"\\$`]/.test(text) && NAMES_STROQ.test(flattened(text)));

function stateSignalsOf(segments: readonly string[]): string[] {
  const assigned = assignments(segments);
  return segments.some((segment) => runsStateCommand(segment, assigned))
    ? ['stroq-state-change']
    : [];
}

/**
 * The same, read as part of the reading of a command that is classified: where the text with its line
 * breaks folded is the command itself (it holds no string or document that spans lines), its segments are
 * the ones that were already cut, and where it is not, it is read for the functions it calls with the room
 * that the command was given, and not with a room of its own: a text that is read again for each reader
 * is a cost that is paid again. `unread` says that a call is left in the folded text that was not read.
 */
export function stroqStateReading(
  command: string,
  split: SplitCommand,
  functions: readonly FunctionDefinition[] | null | undefined,
): { readonly signals: string[]; readonly unread: boolean } {
  // A text that none of the texts read from the command names is no command of Stroq: a name that a variable
  // is given by a substitution that prints it is written out in the text that the variable is replaced in.
  if (!namesStroq(command) && !split.texts.some(namesStroq)) return { signals: [], unread: false };
  const folded = joinText(command);
  // A text that is an approximation of a program (a script, read with its variables replaced) was not read for
  // its functions, and is for this: a function that wraps `stroq` is a way to run it, and it asks nothing.
  if (functions === null) return { signals: stateSignalsOf(splitSegments(folded)), unread: false };
  if (folded === command) return { signals: stateSignalsOf(split.segments), unread: false };
  // What the folding changes is text: a string, a document that is written to a file. A function that stands in
  // it is no function of the shell (a plan of a few hundred lines has dozens), so the folded text is read for
  // functions only where the command has some of its own, as the command was read for them.
  const has = split.functions.length > 0 || (functions ?? []).length > 0;
  const own = splitCommand(folded, has ? functions : null, split.room);
  return { signals: stateSignalsOf(own.segments), unread: own.functionsUnread };
}

const SHELL_WORDS: ReadonlySet<string> = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'source',
  '.',
]);
/** Text before a quote that makes the quoted string a script: `sh -c "…"`, `eval "…"`. */
const RUNS_STRING = /(?:\b(?:ba|z|da|k)?sh\s+(?:-\w+\s+)*-c|\beval)\s*$/;

interface Heredoc {
  readonly delim: string;
  readonly stripTabs: boolean;
  /** Fed to a shell, so its lines are commands and keep their newlines. */
  readonly script: boolean;
}

/**
 * The command with the newlines of its text folded to spaces: inside a quoted string
 * that is not a script, and inside a heredoc whose command is not a shell. One pass,
 * no pattern that can backtrack: the classifier's ReDoS gate runs over this too.
 */
export function joinText(command: string): string {
  let out = '';
  let quote: { readonly char: string; readonly script: boolean } | null = null;
  const pending: Heredoc[] = [];
  let nextPending = 0;
  let body: Heredoc | null = null;
  let bodyLine = '';
  let lineStart = 0;
  for (let i = 0; i < command.length; i += 1) {
    const c = command.charAt(i);
    if (body !== null) {
      if (c !== '\n') {
        bodyLine += c;
        out += c;
        continue;
      }
      const line = body.stripTabs ? bodyLine.replace(/^\t+/, '') : bodyLine;
      if (line === body.delim) {
        out += '\n';
        body = pending[nextPending++] ?? null;
        lineStart = i + 1;
      } else {
        out += body.script ? '\n' : ' ';
      }
      bodyLine = '';
      continue;
    }
    if (quote !== null) {
      if (quote.char === '"' && c === '\\' && i + 1 < command.length) {
        out += c + command.charAt(i + 1);
        i += 1;
        continue;
      }
      if (c === quote.char) quote = null;
      out += c === '\n' && quote !== null && !quote.script ? ' ' : c;
      continue;
    }
    if (c === '\\' && i + 1 < command.length) {
      out += c + command.charAt(i + 1);
      i += 1;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = { char: c, script: RUNS_STRING.test(command.slice(Math.max(lineStart, i - 40), i)) };
      out += c;
      continue;
    }
    if (c === '<' && command.charAt(i + 1) === '<' && command.charAt(i + 2) !== '<') {
      // Only the start of the line is needed, for its command word: slicing the whole
      // line for each of many operators on it was quadratic (47 s on 256 KiB).
      const lineHead = command.slice(lineStart, Math.min(i, lineStart + 256));
      const { heredoc, end } = readHeredoc(command, i + 2, lineHead);
      if (heredoc !== null) pending.push(heredoc);
      out += command.slice(i, end);
      i = end - 1;
      continue;
    }
    if (c === '\n') {
      body = pending[nextPending++] ?? null;
      // The newline that opens a text heredoc's body is part of that text too: kept,
      // it made the body's first line a command of its own.
      out += body !== null && !body.script ? ' ' : c;
      lineStart = i + 1;
      continue;
    }
    out += c;
  }
  return out;
}

/** The heredoc whose operator ends at `from`, and where its delimiter word ends. */
function readHeredoc(
  command: string,
  from: number,
  lineBefore: string,
): { readonly heredoc: Heredoc | null; readonly end: number } {
  let j = from;
  const stripTabs = command.charAt(j) === '-';
  if (stripTabs) j += 1;
  while (command.charAt(j) === ' ' || command.charAt(j) === '\t') j += 1;
  const q = command.charAt(j);
  let delim = '';
  if (q === '"' || q === "'") {
    // Each operator's own quote is the next one to find, so this stays linear; a
    // quote with no close anywhere after it is answered without a scan.
    const close = command.lastIndexOf(q) > j ? command.indexOf(q, j + 1) : -1;
    if (close === -1) return { heredoc: null, end: j };
    delim = command.slice(j + 1, close);
    j = close + 1;
  } else {
    const start = j;
    while (j < command.length && /[\w.-]/.test(command.charAt(j))) j += 1;
    delim = command.slice(start, j);
  }
  if (delim === '') return { heredoc: null, end: j };
  const word = baseName(lineBefore.trim().split(/\s+/)[0] ?? '');
  return { heredoc: { delim, stripTabs, script: SHELL_WORDS.has(word) }, end: j };
}

const RUNNERS: ReadonlySet<string> = new Set([
  'npx',
  'pnpx',
  'pnpm',
  'bunx',
  'bun',
  'yarn',
  'npm',
  'node',
]);
/** Words a runner takes before the program it runs. */
const RUNNER_VERBS: ReadonlySet<string> = new Set([
  'exec',
  'dlx',
  'x',
  'run',
  'recursive',
  'multi',
  'm',
  '--',
]);
/**
 * The options of `npx`, `npm exec`, `pnpm` and `yarn` that are known to take a value: a package, a directory, a
 * cache, a registry. An option that is not here may take one as well, and the word after it is read for that.
 */
const RUNNER_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '-p',
  '--package',
  '--filter',
  '-F',
  '-C',
  '--dir',
  '--prefix',
  '--cache',
  '--cache-folder',
  '--userconfig',
  '--globalconfig',
  '--registry',
  '--cwd',
  '--workspace',
  '--config',
  '--loglevel',
]);
const WRAPPERS: ReadonlySet<string> = new Set([
  'sudo',
  'doas',
  'env',
  'command',
  'exec',
  'nohup',
  'nice',
  'time',
  'timeout',
]);
const STROQ_PACKAGE = /^@stroq\/cli(?:@\S*)?$/;
/** The published entry, and the one in a checkout of this repository. */
const STROQ_ENTRY =
  /(?:[\\/]@stroq[\\/]cli[\\/]dist[\\/]index\.js|(?:^|[\\/])packages[\\/]cli[\\/]dist[\\/]index\.js)$/;
const ASSIGNMENT = /^([A-Za-z_]\w*)=(\S*)$/;
const VARIABLE = /^\$\{?([A-Za-z_]\w*)\}?$/;

/** A word's program name: no directory, no Windows launcher extension, lower case. */
const baseName = (word: string): string =>
  word
    .replace(/^.*[\\/]/, '')
    .replace(/\.(?:cmd|exe|ps1|bat)$/i, '')
    .toLowerCase();

/** `NAME=value` words anywhere in the command, quotes removed: `S=stroq; $S untaint`. */
function assignments(segments: readonly string[]): ReadonlyMap<string, string> {
  const found = new Map<string, string>();
  for (const segment of segments)
    for (const word of words(segment)) {
      const match = ASSIGNMENT.exec(word);
      if (match) found.set(match[1] as string, match[2] as string);
    }
  return found;
}

/** The segment's words with quotes removed and backslashes kept: Windows paths survive. */
const words = (segment: string): string[] =>
  segment
    .trim()
    .split(/\s+/)
    .map((word) => word.replace(/["']/g, ''))
    .filter((word) => word !== '');

const isStroq = (word: string): boolean =>
  baseName(word) === 'stroq' || STROQ_PACKAGE.test(word) || STROQ_ENTRY.test(word);

/** Index of the word that is Stroq, when the segment runs it; -1 when it does not. */
function stroqAt(ws: readonly string[], assigned: ReadonlyMap<string, string>): number {
  let i = 0;
  while (i < ws.length) {
    const word = ws[i] as string;
    if (ASSIGNMENT.test(word)) i += 1;
    else if (WRAPPERS.has(baseName(word))) {
      const wrapper = baseName(word);
      i += 1;
      // The options of the wrapper, with the value of those that take one (`sudo -nu root stroq untaint`), and
      // the number that `timeout` takes.
      while (i < ws.length && /^-|^\d+[smhd]?$/.test(ws[i] as string)) {
        const option = ws[i] as string;
        i += 1;
        if (option.startsWith('-') && optionTakesValue(wrapper, option)) i += 1;
      }
    } else break;
  }
  const word = ws[i];
  if (word === undefined) return -1;
  const variable = VARIABLE.exec(word)?.[1];
  if (variable !== undefined) return isStroq(assigned.get(variable) ?? '') ? i : -1;
  // `$(which stroq) untaint`, `` `which stroq` untaint ``: the program is whatever the
  // substitution prints, and a substitution that names Stroq prints Stroq.
  if (word.startsWith('$(') || word.startsWith('`')) {
    const close = word.startsWith('$(') ? ')' : '`';
    for (let j = i; j < ws.length; j += 1) {
      const part = ws[j] as string;
      const ends =
        j === i ? part.slice(word.startsWith('$(') ? 2 : 1).includes(close) : part.includes(close);
      if (ends) return ws.slice(i, j + 1).some((w) => /\bstroq\b/.test(w)) ? j : -1;
    }
    return -1;
  }
  if (isStroq(word) && !RUNNERS.has(baseName(word))) return i;
  if (!RUNNERS.has(baseName(word))) return -1;
  // Whether the word is the value of an option that this does not know: `npx --tag next prettier`, where `next` is
  // no program. The program is the first word that is none, unless it stands right after an option, where it may be.
  let maybeValue = false;
  for (let j = i + 1; j < ws.length; j += 1) {
    const arg = ws[j] as string;
    // An option that takes a value, and `yarn workspace NAME`: the word after it is not the program.
    if (RUNNER_VALUE_FLAGS.has(arg) || arg === 'workspace' || arg === 'workspaces') {
      j += 1;
      maybeValue = false;
    } else if (arg.startsWith('-')) maybeValue = !arg.includes('=');
    else if (RUNNER_VERBS.has(arg)) maybeValue = false;
    else if (isStroq(arg)) return j;
    else if (maybeValue) maybeValue = false;
    else return -1;
  }
  return -1;
}

/**
 * What stands before the command of a segment and is not it: a group or a subshell that opens (`{ stroq
 * untaint; }`, `(stroq untaint)`), a keyword (`then stroq untaint`, `do stroq untaint`, `! stroq untaint`), the
 * head of a function (`f() { stroq untaint; }`, `function f {`), and the pattern of an arm of `case`
 * (`x) stroq untaint ;;`). A segment is cut at `;`, so each of these is where the command begins.
 */
const OPENING_WORDS: ReadonlySet<string> = new Set([
  '{',
  '(',
  '((',
  '!',
  'if',
  'then',
  'else',
  'elif',
  'while',
  'until',
  'do',
  'coproc',
]);
function afterOpeners(ws: readonly string[]): string[] {
  const rest = [...ws];
  while (rest.length > 0) {
    const word = rest[0] as string;
    if (OPENING_WORDS.has(word) || /^[^\s()]+\(\)$/.test(word) || /^[^\s()]*\)$/.test(word))
      rest.shift();
    else if (word === 'function') rest.splice(0, rest[2] === '()' ? 3 : 2);
    else if (word === 'case' && rest.includes('in')) rest.splice(0, rest.indexOf('in') + 1);
    else if (word.length > 1 && word.startsWith('(')) rest[0] = word.replace(/^\(+/, '');
    else break;
  }
  return rest;
}

/** A word of the arguments of a command that ends a group or a subshell: `untaint)`, `--all}`. */
function withoutClosers(word: string): string {
  // Not `word.replace(/[)}]+$/, '')`: for a word of many closers that ends in something else, that takes time
  // quadratic in its length (3 s at 64 KiB), and the hook runs it on whatever a command holds.
  let end = word.length;
  while (end > 0 && (word[end - 1] === ')' || word[end - 1] === '}')) end -= 1;
  return word.slice(0, end);
}

/**
 * Whether a segment runs a command of Stroq that changes what it enforces. Read by its own words, past what
 * stands before a command (see `afterOpeners`), and by what the shell reads of it (`resolve`): past a
 * wrapper that this list does not know (`xargs`, `watch`, `stdbuf`, `builtin exec`), a redirect that stands
 * before the command (`> /dev/null stroq untaint`) and a function head. A segment that has no `stroq` in
 * it and no expansion that could make one is not read that way.
 */
function runsStateCommand(segment: string, assigned: ReadonlyMap<string, string>): boolean {
  if (changesState(afterOpeners(words(segment)), assigned)) return true;
  if (!namesStroq(segment) && !/[$`]/.test(segment)) return false;
  const found = resolve(segment);
  if (found === null || found.word === '') return false;
  const rest = withoutRedirects(found.args).map((word) => word.value);
  return changesState([found.word, ...rest], assigned);
}

function changesState(ws: readonly string[], assigned: ReadonlyMap<string, string>): boolean {
  const at = stroqAt(ws, assigned);
  if (at === -1) return false;
  const args = ws
    .slice(at + 1)
    .map(withoutClosers)
    .filter((word) => word !== '--' && word !== '');
  if (args.some((word) => word === '--dry-run' || word === '--help' || word === '-h')) return false;
  const sub = args.find((word) => !word.startsWith('-'));
  if (sub === 'untaint' || sub === 'init' || sub === 'uninstall') return true;
  if (sub !== 'trust') return false;
  const after = args.slice(args.indexOf('trust') + 1);
  return after.includes('--remove') || after.some((word) => !word.startsWith('-'));
}
