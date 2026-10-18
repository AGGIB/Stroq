/**
 * The commands that fetch and run a package (a RUNNER: `npx x`, `pnpm dlx x`) and the ones that
 * install one (an INSTALLER: `npm install x`, `pip install x`), as the words that name them. One
 * table: the page side finds them with a pattern made from it, and the action side finds them in
 * the words of a command by the words themselves, so the two cannot disagree about which
 * commands there are.
 */

export type PhraseKind = 'runner' | 'installer';

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
  'pnpm dlx',
  'yarn dlx',
  'pipx run',
  'npm exec',
  'uv tool run',
];

const INSTALLER_PHRASES = [
  'npm i|install|add',
  'pnpm add|install',
  'yarn add',
  'pip|pip3 install',
  'uv add',
  'uv pip install',
  'pipx install',
  'cargo install',
  'gem install',
  'go install',
  'brew install',
];

const parse = (kind: PhraseKind, spec: string): Phrase => ({
  kind,
  words: spec.split(' ').map((word) => word.split('|')),
});

export const PHRASES: readonly Phrase[] = [
  ...RUNNER_PHRASES.map((spec) => parse('runner', spec)),
  ...INSTALLER_PHRASES.map((spec) => parse('installer', spec)),
];

const patternOf = (phrase: Phrase): string =>
  phrase.words
    .map((word) => (word.length > 1 ? `(?:${word.join('|')})` : (word[0] ?? '')))
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

/** A phrase and how many words of the command it takes. */
export interface PhraseMatch {
  readonly phrase: Phrase;
  readonly length: number;
}

/** The phrase the words of a command begin with, the longest if several do. */
export function matchPhrase(words: readonly string[]): PhraseMatch | null {
  let best: PhraseMatch | null = null;
  for (const phrase of PHRASES) {
    const fits = phrase.words.every((alternatives, i) => alternatives.includes(words[i] ?? ''));
    if (fits && (best === null || phrase.words.length > best.length))
      best = { phrase, length: phrase.words.length };
  }
  return best;
}
