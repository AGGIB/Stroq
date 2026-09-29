import { splitSegments } from './shell-segments.js';

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
  const segments = splitSegments(joinText(command));
  const assigned = assignments(segments);
  return segments.some((segment) => runsStateCommand(segment, assigned))
    ? ['stroq-state-change']
    : [];
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

const RUNNERS: ReadonlySet<string> = new Set(['npx', 'pnpm', 'bunx', 'bun', 'yarn', 'npm', 'node']);
/** Words a runner takes before the program it runs. */
const RUNNER_VERBS: ReadonlySet<string> = new Set(['exec', 'dlx', 'x', 'run', '--']);
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
      i += 1;
      while (i < ws.length && /^-|^\d+[smhd]?$/.test(ws[i] as string)) i += 1;
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
  for (let j = i + 1; j < ws.length; j += 1) {
    const arg = ws[j] as string;
    if (arg === '-p' || arg === '--package') {
      j += 1;
      continue;
    }
    if (arg.startsWith('-') || RUNNER_VERBS.has(arg)) continue;
    return isStroq(arg) ? j : -1;
  }
  return -1;
}

function runsStateCommand(segment: string, assigned: ReadonlyMap<string, string>): boolean {
  const ws = words(segment);
  const at = stroqAt(ws, assigned);
  if (at === -1) return false;
  const args = ws.slice(at + 1).filter((word) => word !== '--');
  if (args.some((word) => word === '--dry-run' || word === '--help' || word === '-h')) return false;
  const sub = args.find((word) => !word.startsWith('-'));
  if (sub === 'untaint' || sub === 'init' || sub === 'uninstall') return true;
  if (sub !== 'trust') return false;
  const after = args.slice(args.indexOf('trust') + 1);
  return after.includes('--remove') || after.some((word) => !word.startsWith('-'));
}
