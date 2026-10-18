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
export type Alternatives = readonly string[];

export interface Phrase {
  readonly kind: PhraseKind;
  readonly words: readonly Alternatives[];
}

const RUNNER_PHRASES = [
  'npx',
  'bunx',
  'uvx',
  // `pnpm exec` runs a binary that is already installed and fetches nothing: it is no launch.
  'pnpm dlx|create',
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
  'uv run python -m pip install',
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
