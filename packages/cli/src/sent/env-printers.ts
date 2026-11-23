// Reading the words of a shell stage for a printer of the environment: `env`, `printenv`, `export -p`, a
// script that reads `environ`, and a printer inside a request's own words (`curl -d "$(env)"`).
import { shellJoined } from './needles.js';

/** Words that print the environment when given nothing else: `env`, `printenv`, `export -p`. */
const ENV_PRINTERS: ReadonlySet<string> = new Set([
  'env',
  'printenv',
  'set',
  'export',
  'declare',
  'typeset',
]);

/**
 * `environ` and `environb` in the spellings a script has them (`os.environ`, `os.environb`, `__environ`,
 * `/proc/self/environ`): not `environment`, which is a part of many addresses and sentences.
 */
const ENVIRON = /environb?(?![a-z])/i;
const SHELL_VARIABLE = /\$(?:[A-Za-z_]\w*|\{[A-Za-z_]\w*\})/g;
const URL_START = '\\bhttps?://';
const URL_CHARACTER = '[^\\s\'"`<>()$;|]';
/** In a Python f-string: a doubled brace, a replacement field, or a character of the URL. */
const FIELD_OR_CHARACTER = '\\{\\{|\\}\\}|\\{[^{}]*\\}|[^\\s\'"`<>(){}$;|]';
/** A URL as far as the shell keeps it in one word wherever it stands: it ends at a `$`. */
const PLAIN_URL = new RegExp(`${URL_START}${URL_CHARACTER}+`, 'gi');
/** The same, run on across `$NAME` and `${NAME}`: one word only where the shell does not split the value. */
const URL_WITH_VARIABLES = new RegExp(
  `${URL_START}(?:${URL_CHARACTER}|${SHELL_VARIABLE.source})+`,
  'gi',
);
// A triple-quoted one first: it may span lines, and its first quote would otherwise end it at once.
const PYTHON_F_STRING =
  /\b(?:fr?|rf)(?:'''(?:(?!''')[\s\S])*'''|"""(?:(?!""")[\s\S])*"""|(\\?['"])(?:(?!\1)(?:\\[^\r\n]|[^\\\r\n]))*\1)/gi;
/** A URL in a Python f-string. It ends at a `$`: a script can hand its strings to a shell. */
const INTERPOLATED_URL = new RegExp(`${URL_START}(?:${FIELD_OR_CHARACTER})+`, 'gi');

/**
 * What a URL is read as: blanks, or the word `environ` where it holds a reference to the environment. As
 * long as the URL, so that a place in the text is the same place before and after: a URL that holds such a
 * reference is longer than the word.
 */
const masked = (url: string, readsIt: boolean): string =>
  (readsIt ? ' environ ' : '').padEnd(url.length);

/** A replacement field of a Python f-string reads it. A doubled opening brace is literal there. */
function fieldReadsEnvironment(url: string): boolean {
  for (const [, field] of url.matchAll(/\{\{|\{([^{}]*)/g)) {
    if (field !== undefined && ENVIRON.test(field)) return true;
  }
  return false;
}

/** A shell variable inside the URL is named for it (`$environ`). */
function variableNamesEnvironment(url: string): boolean {
  for (const [variable] of url.matchAll(SHELL_VARIABLE)) {
    if (ENVIRON.test(variable)) return true;
  }
  return false;
}

/** Keep evidence from a replacement field without exposing the literal URL around it. */
const maskInterpolatedUrl = (url: string): string => masked(url, fieldReadsEnvironment(url));

/**
 * A simple shell variable can sit inside a URL. Where its value stays in the URL's word (`oneWord`: inside
 * quotes, in a command of an HTTP client), only a reference to the environment in its name is kept. Anywhere
 * else the shell splits the value into words, so the URL ends at the variable and what follows it is read as
 * words of the command.
 */
const maskShellUrl = (url: string, oneWord: boolean): string =>
  oneWord
    ? masked(url, variableNamesEnvironment(url))
    : url.replace(PLAIN_URL, (plain) => masked(plain, false));

/**
 * HTTP clients: a quoted word given to one is an address or a value, and no word of theirs goes to a shell.
 * With any other program (`ssh`, `watch`, `su -c`, a Python script) a quoted text may be a command that a
 * second shell reads, and that shell splits the value into words after all.
 */
const HTTP_CLIENTS: ReadonlySet<string> = new Set([
  'curl',
  'curlie',
  'wget',
  'http',
  'https',
  'xh',
  'xhs',
  'httpie',
]);
/** A program by its plain name, or in a folder a system keeps its programs in: not `./curl`, not `~/bin/curl`. */
const PLAIN_PROGRAM = /^(?:\/(?:usr\/(?:local\/)?bin|bin|opt\/homebrew\/bin)\/)?([\w.-]+)$/;

/** Whether the first word of a text, its quoting taken out, is an HTTP client by its plain name. */
function runsHttpClient(text: string): boolean {
  const word = shellJoined(/^\s*(\S*)/.exec(text)?.[1] ?? '');
  return HTTP_CLIENTS.has(PLAIN_PROGRAM.exec(word)?.[1] ?? '');
}

/**
 * Ways a command gives a program's name another meaning: a function (`name()`, `function`), an alias, a
 * remembered path (`hash`), a loaded builtin (`enable`), definitions read from a file (`source`, `.`,
 * `autoload`) or from a text (`eval`), another search path (`PATH=`). Any of them, whatever name it gives.
 */
const RENAMES =
  /\b(?:alias(?:es)?|functions?|autoload|hash|enable|source|eval)\b|\bPATH=|\(\s*\)|(?:^|[\s;&|({])\.\s/;

/**
 * Whether a command may give the name of a program in it another meaning (`curl() { ssh "$@"; }`), read
 * in the whole command with its quoting taken out. What an earlier command or a start-up file defined is
 * not in the text and is not seen.
 */
export const mayRenameProgram = (command: string): boolean => RENAMES.test(shellJoined(command));

const WORD_BREAK = /[\s()<>]/;
/** Outside quotes: the end of a command, a substitution, a here-document. */
const ENDS_COMMAND = /^(?:[;&|\n`]|\$\(|[<>]\(|<<)/;
/** A parameter expansion that is a name and nothing more: no word, pattern or quote of its own inside. */
const NAME_IN_BRACES = /\$\{[A-Za-z_]\w*\}/y;
const NOTHING_QUOTED = new Uint8Array(0);

/** Where the `${NAME}` that starts at `at` ends, or -1 when what starts there is more than a name. */
function nameInBracesEnd(text: string, at: number): number {
  NAME_IN_BRACES.lastIndex = at;
  const found = NAME_IN_BRACES.exec(text);
  return found === null ? -1 : at + found[0].length;
}

/**
 * For each character of one command, 1 where it stands inside shell quotes: `'…'`, `"…"` or `$'…'`. The
 * quotes are followed only as far as they are plain to read, and nothing after that counts as quoted: up
 * to the first `;`, `&`, `|`, new line or comment, the first substitution (`$(`, a backtick, `<(`, `>(`) or
 * here-document (`<<`), and the first `${` that is more than `${NAME}`, inside double quotes or outside
 * them. What comes after has a program, a word or quotes of its own that are not read here.
 */
function quotedPlaces(text: string): Uint8Array {
  const quoted = new Uint8Array(text.length);
  let quote: '' | "'" | '"' | "$'" = '';
  let wordStart = true;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i] as string;
    const pair = c + (text[i + 1] ?? '');
    if (pair === '${' && (quote === '' || quote === '"')) {
      const end = nameInBracesEnd(text, i);
      if (end < 0) break;
      if (quote !== '') quoted.fill(1, i, end);
      i = end - 1;
      wordStart = false;
    } else if (quote === '') {
      if (ENDS_COMMAND.test(pair) || (c === '#' && wordStart)) break;
      quote = pair === "$'" ? "$'" : c === "'" || c === '"' ? c : '';
      wordStart = quote === '' && WORD_BREAK.test(c);
      // An escaped character is read with its backslash, and the quote of `$'` with its dollar.
      if (c === '\\' || quote === "$'") i += 1;
    } else {
      quoted[i] = 1;
      if (quote === '"' && (c === '`' || pair === '$(')) break;
      if (c === '\\' && quote !== "'") {
        i += 1;
        if (i < text.length) quoted[i] = 1;
      } else if (c === (quote === '"' ? '"' : "'")) {
        quote = '';
      }
    }
  }
  return quoted;
}

/**
 * `renamed`: the command around the text may give a client's name another meaning; read from the text
 * itself when not given.
 */
function readsEnvironment(text: string, renamed: boolean | undefined): boolean {
  if (!ENVIRON.test(text)) return false;
  const followed = runsHttpClient(text) && !(renamed ?? mayRenameProgram(text));
  const quoted = followed ? quotedPlaces(text) : NOTHING_QUOTED;
  // One word: the URL begins inside quotes, and the quotes were followed to its last character.
  const oneWord = (at: number, length: number): boolean =>
    quoted[at] === 1 && quoted[at + length - 1] === 1;
  const withFields = text.replace(PYTHON_F_STRING, (literal) =>
    literal.replace(INTERPOLATED_URL, maskInterpolatedUrl),
  );
  return ENVIRON.test(
    withFields.replace(URL_WITH_VARIABLES, (url: string, at: number) =>
      maskShellUrl(url, oneWord(at, url.length)),
    ),
  );
}

/**
 * Whether a stage prints the environment, or reads a process's (`/proc/self/environ`, `os.environ`).
 * `renamed` is what `mayRenameProgram` says of the whole command the stage is in.
 */
export function printsEnvironment(text: string, renamed?: boolean): boolean {
  if (readsEnvironment(text, renamed)) return true;
  const words = joinedWords(text);
  const program = (words[0] ?? '').replace(/^.*\//, '');
  return ENV_PRINTERS.has(program) && words.slice(1).every((w) => /^-[pxi0u]*$/.test(w));
}

/**
 * The inner texts of the substitutions in a stage: `$(…)`, `<(…)`, `>(…)` and backticks. None in single
 * quotes. In double quotes a single quote is a plain character, `$(` and backticks still run, and `<(` and
 * `>(` do not.
 */
function substitutions(text: string): string[] {
  const out: string[] = [];
  let quote: '' | "'" | '"' = '';
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i] as string;
    if (quote === "'") {
      if (c === "'") quote = '';
      continue;
    }
    if (c === '\\') {
      i += 1;
      continue;
    }
    if (c === '"') {
      quote = quote === '"' ? '' : '"';
      continue;
    }
    if (c === "'") {
      if (quote === '') quote = "'";
      continue;
    }
    if (c === '`') {
      const end = text.indexOf('`', i + 1);
      if (end < 0) break;
      out.push(text.slice(i + 1, end));
      i = end;
    } else if ((c === '$' || (quote === '' && (c === '<' || c === '>'))) && text[i + 1] === '(') {
      let depth = 1;
      let j = i + 2;
      for (; j < text.length && depth > 0; j += 1) {
        if (text[j] === '(') depth += 1;
        else if (text[j] === ')') depth -= 1;
      }
      out.push(text.slice(i + 2, depth === 0 ? j - 1 : j));
      i += 1;
    }
  }
  return out;
}

/**
 * Whether a stage's own words embed a printer of the environment (`curl -d "$(env)"`, `--data
 * @<(printenv)`, `wget --post-data="$(set)"`, a here-string of `$(env)`): what it printed is the
 * request's own data, though no stage before it printed it.
 */
export const embedsPrinter = (text: string, renamed?: boolean): boolean =>
  substitutions(text).some((inner) => printsEnvironment(inner, renamed));

const joinedWords = (text: string): string[] =>
  shellJoined(text)
    .trim()
    .split(/\s+/)
    .filter((w) => w !== '');
