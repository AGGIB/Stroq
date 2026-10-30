import { named, SCRIPT_EXTENSION, type ScriptReference } from './script-paths.js';
import { baseOf, words } from './script-places.js';
import { parseShellArgs } from './shell-args.js';
import { SHELL_WORDS } from './shell-lex.js';
import { commandWord } from './shell-segments.js';
import { REDIRECT, resolve as resolveCommand } from './shell-words.js';
import { namedStartupFile, startupFileNames } from './startup-files.js';

/**
 * The script files a segment of a command line runs, as it names them: given to a shell (`bash x.sh`,
 * `source x`, `pwsh -File x.ps1`), run by a path (`./deploy.sh`), or the startup files a shell is
 * pointed at (`HOME=d bash -l`). Read word by word: what they hold is read by `script-exec.ts`.
 */

/** The names a shell is run by, from one list: a shell this reads from a pipe it reads a script of. */
const SCRIPT_SHELLS: ReadonlySet<string> = new Set([...SHELL_WORDS, 'busybox', 'source', '.']);
const POWERSHELLS: ReadonlySet<string> = new Set([
  'powershell',
  'powershell.exe',
  'pwsh',
  'pwsh.exe',
]);
export const isEnvAssignment = (word: string): boolean => /^[A-Za-z_]\w*=/.test(word);

/**
 * A script operand as the shell sees it. A redirect, a `&`, a `;` or a closing `)` glued to
 * the word (`x.sh>/dev/null`, `./x.sh&`, `x.sh)`) is not part of the name, and quote marks
 * inside it (`./"x.sh"`) are removed by the shell before the file is opened.
 */
function cleanToken(raw: string): string {
  const cut = raw.search(/(?<=.)[<>]/);
  const head = (cut === -1 ? raw : raw.slice(0, cut)).replace(/["']/g, '');
  // A loop, not `/[;&|)}]+$/`: that retries from every character of a long run of them.
  let end = head.length;
  while (end > 0 && TOKEN_TAIL.has(head.charAt(end - 1))) end -= 1;
  return head.slice(0, end);
}

/** What a shell leaves glued to the end of a word it has already finished with. */
const TOKEN_TAIL: ReadonlySet<string> = new Set([';', '&', '|', ')', '}']);

/** `./a\.sh` is `./a.sh` to a POSIX shell, and a path with separators in it to Windows: both are tried. */
const posixUnescaped = (token: string): string => token.replace(/\\(.)/g, '$1');

/** The script files a segment runs, as written: `bash x.sh`, `source x.sh`, `./x.sh`, `pwsh -File x.ps1`. */
function scriptReferences(segment: string): ScriptReference[] {
  return scriptReferencesOf(segment).flatMap((reference) =>
    spellings(reference.token).map((token) => ({ ...reference, token })),
  );
}

/**
 * The names a script operand can mean: as written, with what a shell strips from a word
 * (quote marks, a glued `;` `&` `)` or redirect) taken off, and each with its backslash
 * escapes resolved. The operand has already had its quotes removed once by the word split, so
 * a file whose own name holds a quote mark or ends in `;` is the first spelling, and `./a\.sh`
 * is the last. A name that exists as none of them is not a script.
 */
export function spellings(token: string): string[] {
  const clean = cleanToken(token);
  return [...new Set([token, clean, posixUnescaped(token), posixUnescaped(clean)])].filter(
    (name) => name !== '',
  );
}

/**
 * The files a shell is told to run, read from its words as the shell reads them: a word that is
 * quoted is a name and not a redirect (`bash '<x.sh'` runs a file called `<x.sh`), and a redirect
 * glued to the shell (`bash<x.sh`) is read as one.
 */
function shellScripts(segment: string, fallback: readonly string[]): ScriptReference[] {
  const command = resolveCommand(segment);
  const parsed =
    command === null
      ? parseShellArgs(fallback)
      : parseShellArgs(command.name === 'busybox' ? command.args.slice(1) : command.args);
  if (command?.name === 'busybox' && !SHELL_WORDS.has(command.args[0]?.value ?? '')) return [];
  // The files it runs as it starts count with the one it is told to run.
  const sourced = command?.name === 'source' || command?.name === '.';
  // `--rcfile x` and `--init-file x` name the file outright: it is judged like the one the shell is told to run.
  return [...parsed.files, ...parsed.startup].map((token) => named(token, sourced));
}

function scriptReferencesOf(segment: string): ScriptReference[] {
  return [
    // A file the shell only looks for in a directory is skipped when it is missing; one named outright is not.
    ...startupFileNames(segment).map((name) =>
      name === namedStartupFile(segment) ? named(name) : { ...named(name), startup: true },
    ),
    ...commandScripts(segment),
  ];
}

function commandScripts(segment: string): ScriptReference[] {
  const tokens = words(segment);
  // PowerShell's call operator: `& ./clean.ps1`, `& 'C:\\tools\\clean.ps1' -Force`.
  if (tokens[0] === '&') {
    const callee = tokens[1];
    return callee !== undefined && SCRIPT_EXTENSION.test(callee) ? [named(callee)] : [];
  }
  // The command a stage runs through its wrappers (`setsid bash x.sh`, `env -S "bash x.sh"`,
  // `exec -a z bash x.sh`) and the function heads before it.
  const command = resolveCommand(segment);
  // Assignments alone (`A=$(python3 x.py)`, `ALL="a b"`) run no file of their own: what a substitution
  // in them runs is read as text read out of the command.
  if (command === null && ASSIGNMENT_FIRST.test(segment)) return [];
  const word = (command?.name || commandWord(segment)).toLowerCase();
  if (word === '') return [];
  // The word that is the command, not a redirect's target of the same name (`>> x.sh ./x.sh` runs the
  // second, and keeps the first as it was).
  const at = tokens.findIndex(
    (t, i) =>
      !isEnvAssignment(t) &&
      !REDIRECT.test(t) &&
      !(i > 0 && isRedirect(tokens[i - 1] as string)) &&
      baseOf(t).toLowerCase() === word,
  );
  // What a shell runs is read from its arguments as the shell reads them; a program it is
  // handed on standard input (`cat x.sh | bash`) is found by `shellInput`, which sees the pipe.
  if (SCRIPT_SHELLS.has(word)) return shellScripts(segment, at === -1 ? [] : tokens.slice(at + 1));
  // A command word that a brace expansion makes (`./{t,u}.sh` is `./t.sh`) is not among the words
  // as they are written: the one the shell read is. Any other expansion names no command here.
  const written = at === -1 ? command?.word : tokens[at];
  // A word read across a quote left open (`' > /tmp/x.tsv`, a piece of quoted text the cut split
  // before a redirect) names no command either.
  if (written === undefined || (at === -1 && /[$`*?[\s'"]/.test(written))) return [];
  const head = written;
  const rest = at === -1 ? [] : tokens.slice(at + 1);
  if (POWERSHELLS.has(word)) {
    const file = rest.findIndex((t) => /^-f(?:ile)?$/i.test(t));
    if (file !== -1 && rest[file + 1] !== undefined) return [named(rest[file + 1] as string)];
    const direct = rest.find((t) => !t.startsWith('-') && SCRIPT_EXTENSION.test(t));
    return direct === undefined ? [] : [named(direct)];
  }
  if (word === 'cmd' || word === 'cmd.exe') {
    const run = rest.findIndex((t) => /^\/[ck]$/i.test(t));
    const target = run === -1 ? undefined : rest[run + 1];
    return target !== undefined && SCRIPT_EXTENSION.test(target) ? [named(target)] : [];
  }
  // Run directly, by a path: `./deploy.sh`, `scripts\clean.ps1`, and `./cleanup` when the
  // file begins with a shell `#!` line.
  if (!/[/\\]/.test(head)) return [];
  return [{ token: head, needsShebang: !SCRIPT_EXTENSION.test(head), direct: true }];
}

/** A segment that begins with an assignment, after the words that open a clause. */
const ASSIGNMENT_FIRST = /^\s*(?:(?:do|then|else|elif|!)\s+)*[A-Za-z_]\w*\+?=/;

/**
 * The scripts a segment runs. What is read out of the command may not be shell at all (a body's
 * Python, a `sed` program cut at its `;`); a script named in a piece a shell would not take is still
 * read when it is there, but is no question when it is not (`ScriptReference.uncertain`). A comment
 * with an apostrophe (`bash -c "bash x.sh # it's"`) makes a real body look like such a piece.
 */
export function readReferences(segment: string, own: boolean): ScriptReference[] {
  const found = scriptReferences(segment);
  if (own) return found;
  // The end of a quoted string the reading cut out of a command (`Error" /tmp/f.txt`, from `grep -E
  // "a|Error" /tmp/f.txt`) is words of that command, and a shell takes a word with a quote it does not
  // open as an error: neither runs a file.
  if (isCutQuoteTail(segment)) return [];
  // Nor does a path handed to a call in a body's Python or JavaScript (`p=Path('/tmp/x.jar')`).
  const kept = found.filter((reference) => !insideCall(segment, reference.token));
  if (isShellText(segment) && !opensSubstitution(segment)) return kept;
  return kept.map((reference) => ({ ...reference, uncertain: true }));
}

/**
 * Whether a segment is the end of a quoted string: its quotes do not close as they are, and do when
 * its first quote closes one opened before it (`Error" /tmp/f.txt`). `IFS=" " bash x.sh` is not.
 */
function isCutQuoteTail(segment: string): boolean {
  const first = /["']/.exec(segment)?.[0];
  return first !== undefined && !quotesClose(segment) && quotesClose(first + segment);
}

/** Whether every quote in a text closes, backslashes and a comment read as the shell reads them. */
function quotesClose(text: string): boolean {
  let quote = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (quote === "'") {
      if (ch === "'") quote = '';
    } else if (ch === '\\') i += 1;
    else if (quote === '"') {
      if (ch === '"') quote = '';
    } else if (ch === '#' && (i === 0 || /\s/.test(text.charAt(i - 1)))) break;
    else if (ch === "'" || ch === '"') quote = ch;
  }
  return quote === '';
}

/** Whether every place a token is in a segment is the first argument of a call: `Path('…`, `open("…`. */
function insideCall(segment: string, token: string): boolean {
  if (token === '') return false;
  let at = segment.indexOf(token);
  if (at === -1) return false;
  for (; at !== -1; at = segment.indexOf(token, at + token.length))
    if (!/[\w\]]\(\s*['"]?$/.test(segment.slice(Math.max(0, at - 4), at))) return false;
  return true;
}

/**
 * Whether a segment can be shell: no quote left open (`kb" /tmp/x.log`, a piece of `grep "a\|kb" …`)
 * and no `(` glued to a word (`p=Path('x')`, `print(len(l))`), which a shell takes as an error; `$(`,
 * `<(`, `arr=(…)` and `name()` are its own. A comment ends it: `bash x.sh # it's` is shell. Counted,
 * not matched: the segment is the agent's.
 */
function isShellText(segment: string): boolean {
  let quote = '';
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment.charAt(i);
    if (quote === "'") {
      if (ch === "'") quote = '';
    } else if (ch === '\\') i += 1;
    else if (quote === '"') {
      if (ch === '"') quote = '';
    } else if (ch === '#' && (i === 0 || /\s/.test(segment.charAt(i - 1)))) break;
    else if (ch === "'" || ch === '"') quote = ch;
    else if (ch === '(' && /[\w.\]]/.test(segment.charAt(i - 1)) && segment.charAt(i + 1) !== ')')
      return false;
  }
  return quote === '';
}

/** Whether a word is a redirect operator and nothing else: `>`, `2>>`, `&>`, `<`. */
const isRedirect = (word: string): boolean => REDIRECT.exec(word)?.[0] === word;

/**
 * Whether a segment opens a `$(` or a backtick it does not close: a piece of a substitution the reading
 * out of the command cut at its `|`. Quotes are honoured as the shell honours them: `'$('` is text.
 * Counted, not matched: the segment is the agent's.
 */
function opensSubstitution(segment: string): boolean {
  let open = 0;
  let ticks = 0;
  let quote = '';
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment.charAt(i);
    if (quote === "'") {
      if (ch === "'") quote = '';
    } else if (ch === '\\') i += 1;
    else if (ch === '$' && segment.charAt(i + 1) === '(') {
      open += 1;
      i += 1;
    } else if (ch === ')' && open > 0) open -= 1;
    else if (ch === '`') ticks += 1;
    else if (ch === '"') quote = quote === '"' ? '' : '"';
    else if (ch === "'" && quote === '') quote = "'";
  }
  return open > 0 || ticks % 2 === 1;
}
