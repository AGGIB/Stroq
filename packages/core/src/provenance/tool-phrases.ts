import { shellWord } from './shell-word.js';

/**
 * The commands that fetch and run a package (a RUNNER: `npx x`, `pnpm dlx x`), the ones that
 * install one (an INSTALLER: `npm install x`, `pip install x`) and the ones that name packages
 * only by an option (`uv run --with x`), as the words that name them. One table: the page side
 * finds them with a pattern made from it, and the action side finds them in the words of a
 * command by the words themselves, so the two cannot disagree about which commands there are.
 */

export type PhraseKind = 'runner' | 'installer' | 'with';

/** One word of a phrase, with the spellings that stand for it (`i`, `install` and `add` are one verb of npm). */
type Alternatives = readonly string[];

export interface Phrase {
  readonly kind: PhraseKind;
  readonly words: readonly Alternatives[];
}

const RUNNER_PHRASES = [
  'npx',
  'bunx',
  'uvx',
  'pnpm dlx|exec|create',
  'yarn dlx|create',
  'npm exec|x',
  'bun x|create',
  'pipx run',
  'uv tool run',
  'deno run',
  'go run',
];

const INSTALLER_PHRASES = [
  'npm i|in|ins|inst|insta|instal|install|isnt|isnta|isntal|add|it|install-test',
  'pnpm i|add|install|up',
  'yarn add',
  'yarn global add',
  'bun add|install|i',
  'pip install',
  'python -m pip install',
  'poetry add|install',
  'pdm add|install',
  'conda install',
  'uv add',
  'uv pip install',
  'uv tool install',
  'pipx install',
  'cargo add|binstall|install',
  'go get|install',
  'gem install|i',
  'bundle add',
  'brew install',
  'deno install',
];

/** Commands whose packages are named only by an option, and whose positional words are a program. */
const WITH_PHRASES = ['uv run'];

const parse = (kind: PhraseKind, spec: string): Phrase => ({
  kind,
  words: spec.split(' ').map((word) => word.split('|')),
});

export const PHRASES: readonly Phrase[] = [
  ...RUNNER_PHRASES.map((spec) => parse('runner', spec)),
  ...INSTALLER_PHRASES.map((spec) => parse('installer', spec)),
  ...WITH_PHRASES.map((spec) => parse('with', spec)),
];

/** The spellings of a command that are one command: `pip3.11` is `pip`, `python3.12` and `py` are `python`. */
const SPELLINGS: Readonly<Record<string, { readonly pattern: string; readonly test: RegExp }>> = {
  pip: { pattern: 'pip(?:3(?:\\.\\d+)?)?', test: /^pip3?(?:\.\d+)?$/ },
  python: { pattern: '(?:python(?:3(?:\\.\\d+)?)?|py)', test: /^(?:python3?(?:\.\d+)?|py)$/ },
};

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const alternativePattern = (alternative: string): string =>
  SPELLINGS[alternative]?.pattern ?? escaped(alternative);

const patternOf = (phrase: Phrase): string =>
  phrase.words
    .map((word) =>
      word.length > 1
        ? `(?:${word.map(alternativePattern).join('|')})`
        : alternativePattern(word[0] ?? ''),
    )
    .join('\\s+');

/** The pattern that finds a phrase of one kind in a text, preceded by anything but a word character, a dot, a slash or a dash. */
const patternFor = (kind: PhraseKind): RegExp =>
  new RegExp(
    `(?<![\\w./-])(?:${PHRASES.filter((p) => p.kind === kind)
      .map(patternOf)
      .join('|')})(?=\\s)`,
    'gi',
  );

// Package runners: the first positional token after them is the package.
export const RUNNER = patternFor('runner');
// Package installers: every positional token after them is a package.
export const INSTALLER = patternFor('installer');

const LAUNCHER = new RegExp(`${RUNNER.source}|${INSTALLER.source}`, 'i');

/** Whether a text holds a runner or an installer anywhere: the question of a part of a command that was not read. */
export const mentionsLauncher = (text: string): boolean => LAUNCHER.test(text);

/** The first words of the phrases: a command that starts with another is neither. */
export const PHRASE_STARTS: ReadonlySet<string> = new Set(
  PHRASES.flatMap((phrase) => phrase.words[0] ?? []),
);

/**
 * The name a command word goes by in the table: unquoted, lower-cased, without the directory it
 * is run from or an extension a Windows shim has (`/usr/local/bin/npx`, `"npx"`, `n''px`,
 * `npx.cmd` are `npx`), and with the spellings of a version folded in (`pip3.11` is `pip`). Empty
 * when the word is an expansion, which names nothing.
 */
export function canonicalCommand(raw: string): string {
  const { word } = shellWord(raw);
  if (/[$`]/.test(word)) return '';
  const base = word
    .toLowerCase()
    .replace(/^.*[\\/]/, '')
    .replace(/\.(?:cmd|exe|ps1|bat)$/, '');
  for (const [name, spelling] of Object.entries(SPELLINGS))
    if (spelling.test.test(base)) return name;
  return base;
}

/**
 * The options before a verb that take the word after them as a value, in the tools that have a
 * verb. Words are compared lower-cased, so `-C` (the directory of pnpm and git) is `-c` here.
 */
const VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '-c',
  '--dir',
  '--directory',
  '--prefix',
  '--filter',
  '-w',
  '--workspace',
  '--cwd',
  '--loglevel',
  '--cache',
  '--cache-dir',
  '--registry',
  '--store-dir',
  '--reporter',
  '--node-options',
  '--before',
  '--tag',
  '--project',
  '--env-file',
  '--python',
  '--python-preference',
  '--refresh-package',
  '--userconfig',
  '--globalconfig',
  '--index-url',
  '--extra-index-url',
  '--proxy',
  '--cert',
  '--trusted-host',
  '--log',
]);

/** How many words are looked at, from the tool on, to find its verb. */
const MAX_SKIPPED = 16;

/** A phrase and how many of the words of a command it takes, the options before its verbs included. */
export interface CommandMatch {
  readonly phrase: Phrase;
  readonly consumed: number;
  /** An option with a value nobody knows stood before the verb, so what it took is a guess. */
  readonly doubt: boolean;
  /** The last word of the phrase, as written. */
  readonly verb: string;
}

const plainWord = (raw: string | undefined): string => shellWord(raw ?? '').word.toLowerCase();

const isOption = (word: string): boolean =>
  word.startsWith('-') || (word.startsWith('+') && word.length > 1);

/**
 * Where the verb `alternatives` stands in `words`, from `from` on, past the options that come
 * first: an option takes the word after it when it is one of those that take a value, and
 * otherwise stands alone. A word that is neither the verb nor an option is the value of an option
 * nobody knows when the verb follows it, and the match is then a doubt; otherwise it is another
 * command (`npm run`), and there is no match. A word that is itself an option (`-m`) stands where it is.
 */
function findVerb(
  words: readonly string[],
  from: number,
  alternatives: Alternatives,
): { at: number; doubt: boolean; word: string } | null {
  const literal = alternatives[0]?.startsWith('-') === true;
  let at = from;
  let doubt = false;
  for (let steps = 0; at < words.length && steps < MAX_SKIPPED; steps += 1) {
    const word = plainWord(words[at]);
    if (alternatives.includes(word)) return { at, doubt, word };
    if (literal) return null;
    if (isOption(word)) {
      at += !word.includes('=') && VALUE_OPTIONS.has(word) ? 2 : 1;
      continue;
    }
    const after = plainWord(words[at + 1]);
    if (at > from && isOption(plainWord(words[at - 1])) && alternatives.includes(after)) {
      doubt = true;
      at += 1;
      continue;
    }
    return null;
  }
  return null;
}

function followPhrase(phrase: Phrase, words: readonly string[]): CommandMatch | null {
  let at = 1;
  let doubt = false;
  let verb = '';
  for (const alternatives of phrase.words.slice(1)) {
    const found = findVerb(words, at, alternatives);
    if (found === null) return null;
    at = found.at + 1;
    doubt = doubt || found.doubt;
    verb = found.word;
  }
  return { phrase, consumed: at, doubt, verb };
}

/**
 * The phrase the words of a command begin with, the longest if several do, and how many of its
 * words it takes. The options between the tool and each verb are passed over (`npm --prefix app
 * install x`), and the tool may be spelled with a path or quotes (see `canonicalCommand`).
 */
export function matchCommand(words: readonly string[]): CommandMatch | null {
  const first = canonicalCommand(words[0] ?? '');
  let best: CommandMatch | null = null;
  for (const phrase of PHRASES) {
    if (phrase.words[0]?.includes(first) !== true) continue;
    const match = followPhrase(phrase, words);
    if (match !== null && (best === null || phrase.words.length > best.phrase.words.length))
      best = match;
  }
  return best;
}
