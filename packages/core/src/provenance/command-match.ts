import { shellWord } from './shell-word.js';
import { PHRASES, canonicalCommand, type Alternatives, type Phrase } from './tool-phrases.js';

/**
 * Which phrase of the table the words of a command begin with, and how many of its words the
 * phrase takes. The options that stand between the tool and each verb are passed over, and which
 * of them take the word after them as a value is a matter of the tool: `-w` is a workspace and
 * takes one in npm, and takes none in pnpm. Where the words cannot be matched with certainty (an
 * option nobody knows, a verb that may be the value of an option, more options than are looked
 * at) the match is a doubt, and it is never the answer that the command is no launcher while a
 * verb of the tool stands anywhere further on.
 */

const options = (...names: string[]): ReadonlySet<string> => new Set(names);

/** The options before a verb that take the word after them as a value, by tool, compared as written. */
const OPTIONS_WITH_VALUE: Readonly<Record<string, ReadonlySet<string>>> = {
  npm: options(
    '--prefix',
    '-w',
    '--workspace',
    '--registry',
    '--loglevel',
    '--cache',
    '--userconfig',
    '--globalconfig',
    '--tag',
    '--before',
    '--otp',
    '--scope',
    '--script-shell',
  ),
  pnpm: options(
    '-C',
    '--dir',
    '--filter',
    '-F',
    '--reporter',
    '--store-dir',
    '--loglevel',
    '--registry',
    '--node-options',
    '--workspace-concurrency',
  ),
  yarn: options(
    '--cwd',
    '--registry',
    '--cache-folder',
    '--modules-folder',
    '--network-timeout',
    '--proxy',
    '--https-proxy',
    '--mutex',
    '--link-folder',
    '--global-folder',
    '--preferred-cache-folder',
  ),
  bun: options('--cwd', '-c', '--config', '--registry', '--cache-dir', '--install', '--tag'),
  pip: options(
    '--python',
    '--proxy',
    '--cache-dir',
    '--log',
    '--retries',
    '--timeout',
    '--exists-action',
    '--trusted-host',
    '--cert',
    '--client-cert',
    '--use-feature',
    '--use-deprecated',
  ),
  uv: options(
    '--directory',
    '--project',
    '--config-file',
    '--cache-dir',
    '--python',
    '-p',
    '--python-preference',
    '--color',
    '--env-file',
    '--refresh-package',
    '--index-url',
    '--extra-index-url',
    '--with',
    '--with-requirements',
  ),
  cargo: options('--config', '-C', '-Z', '--color', '--manifest-path', '--target-dir'),
  poetry: options('--directory', '-C', '--project', '-P'),
  pdm: options('-c', '--config', '-p', '--project'),
  pipx: options('--python'),
  conda: options('-n', '--name', '-p', '--prefix', '-c', '--channel'),
  go: options('-C'),
  gem: options(),
  bundle: options('--gemfile', '--path'),
  deno: options('--config', '-c', '--import-map', '--lock'),
  brew: options(),
};

/** The letters of the flags of a Python interpreter that stand alone: `python -u -B -m pip`, and clusters of them (`-uBm`). */
const PYTHON_ALONE = 'uBEsSIOqvbRxdih';
/** What the `py` launcher takes to choose a version: `-3`, `-3.11`, `-3-64`. */
const PYTHON_LAUNCHER_VERSION = /^-\d(?:\.\d+)?(?:-\d+)?$/;

/** How many options are passed over, from the tool on, before the verb is given up on as not reached. */
const MAX_SKIPPED = 48;

/** A phrase and how many of the words of a command it takes, the options before its verbs included. */
export interface CommandMatch {
  readonly phrase: Phrase;
  readonly consumed: number;
  /** The words could not be matched with certainty: see the note above. */
  readonly doubt: boolean;
  /** The last word of the phrase, as written. */
  readonly verb: string;
  /** The options were not all passed over: the verb was not reached, and what is read is a guess. */
  readonly unreached?: true;
}

interface Found {
  readonly at: number;
  readonly doubt: boolean;
  readonly word: string;
  /** The module glued to `-m` (`-mpip`), when it was. */
  readonly attached?: string;
  /** The options were not all passed over: the verb was not reached. */
  readonly exhausted?: boolean;
}

const written = (raw: string | undefined): string => shellWord(raw ?? '').word;

/** A word compared with the verbs of a phrase: lower-cased and a command's spellings folded in. */
function verbWord(raw: string | undefined): string {
  const word = written(raw);
  return word.includes('/') || word.includes('\\')
    ? word.toLowerCase()
    : canonicalCommand(raw ?? '');
}

const isOption = (word: string, tool: string): boolean =>
  word.startsWith('-') || (tool === 'cargo' && word.startsWith('+') && word.length > 1);

const takesValue = (tool: string, word: string): boolean =>
  !word.includes('=') && OPTIONS_WITH_VALUE[tool]?.has(word) === true;

/** Where a verb of `alternatives` stands in the words from `from` on, or -1. */
function indexOfVerb(words: readonly string[], from: number, alternatives: Alternatives): number {
  for (let at = from; at < words.length; at += 1)
    if (alternatives.includes(verbWord(words[at]))) return at;
  return -1;
}

/**
 * Where the verb `alternatives` stands in `words`, from `from` on, past the options that come
 * first. An option takes the word after it when it is one of those the tool has that take a
 * value, and otherwise stands alone; a value that is itself a verb is read as the verb, and the
 * match is a doubt. A word that is neither the verb nor an option is the value of an option
 * nobody knows, or another command of the tool (`npm run`): the match is a doubt if a verb stands
 * anywhere after it, and no match if none does.
 */
function findVerb(
  words: readonly string[],
  from: number,
  alternatives: Alternatives,
  tool: string,
): Found | null {
  let at = from;
  for (let steps = 0; at < words.length; steps += 1) {
    if (steps >= MAX_SKIPPED) return { at, doubt: true, word: '', exhausted: true };
    const word = verbWord(words[at]);
    if (alternatives.includes(word)) return { at, doubt: false, word };
    const option = written(words[at]);
    if (isOption(option, tool)) {
      const valued = takesValue(tool, option);
      if (valued && alternatives.includes(verbWord(words[at + 1])))
        return { at: at + 1, doubt: true, word: verbWord(words[at + 1]) };
      at += valued ? 2 : 1;
      continue;
    }
    const later = indexOfVerb(words, at + 1, alternatives);
    return later === -1 ? null : { at: later, doubt: true, word: verbWord(words[later]) };
  }
  return null;
}

/** What the letters of one short-option word of a Python interpreter say, read as CPython reads them. */
type Cluster =
  /** `m`: the rest of the word, or the next word when nothing is left, is the module to run. */
  | { readonly kind: 'module'; readonly glued: string; readonly doubt: boolean }
  /** `c`: the rest of the word, or the next word, is code. That is not a module run. */
  | { readonly kind: 'code' }
  /** Flags only; `W` and `X` take the rest of the word or the next word as a value. */
  | { readonly kind: 'flags'; readonly takesNext: boolean; readonly doubt: boolean };

function readCluster(word: string): Cluster {
  let doubt = false;
  for (let k = 1; k < word.length; k += 1) {
    const letter = word.charAt(k);
    if (letter === 'm') return { kind: 'module', glued: word.slice(k + 1), doubt };
    if (letter === 'c') return { kind: 'code' };
    if (letter === 'W' || letter === 'X')
      return { kind: 'flags', takesNext: k === word.length - 1, doubt };
    if (!PYTHON_ALONE.includes(letter)) doubt = true;
  }
  return { kind: 'flags', takesNext: false, doubt };
}

const isShortWord = (word: string): boolean => /^-[^-]/.test(word);

/** Where a short-option word that runs a module stands in `words` after `from`, or -1. */
const indexOfModule = (words: readonly string[], from: number): number =>
  words.findIndex(
    (word, k) =>
      k >= from && isShortWord(written(word)) && readCluster(written(word)).kind === 'module',
  );

/**
 * Where the flag that runs a module (`-m`) stands in the words of a Python command, past the
 * flags of the interpreter: a cluster is read letter by letter (`-um pip`, `-Bm pip`, `-mpip`),
 * `W` and `X` take a value, and `c` is code, which is no module run. An unknown flag is a doubt, and
 * so is a word that is none of them with a module flag further on.
 */
function findModule(words: readonly string[], from: number): Found | null {
  let at = from;
  let doubt = false;
  for (let steps = 0; at < words.length; steps += 1) {
    if (steps >= MAX_SKIPPED) return { at, doubt: true, word: '', exhausted: true };
    const flag = written(words[at]);
    if (!isShortWord(flag) && !flag.startsWith('--')) {
      const later = indexOfModule(words, at + 1);
      return later === -1 ? null : { at: later, doubt: true, word: '-m' };
    }
    if (flag.startsWith('--')) {
      doubt = true;
      at += 1;
    } else if (PYTHON_LAUNCHER_VERSION.test(flag)) at += 1;
    else {
      const cluster = readCluster(flag);
      if (cluster.kind === 'code') return null;
      if (cluster.kind === 'module')
        return {
          at,
          doubt: doubt || cluster.doubt,
          word: '-m',
          ...(cluster.glued === '' ? {} : { attached: cluster.glued.toLowerCase() }),
        };
      doubt = doubt || cluster.doubt;
      at += cluster.takesNext ? 2 : 1;
    }
  }
  return null;
}

function followPhrase(phrase: Phrase, words: readonly string[]): CommandMatch | null {
  let at = 1;
  let doubt = false;
  let verb = '';
  let tool = canonicalCommand(words[0] ?? '');
  let attached: string | null = null;
  for (const alternatives of phrase.words.slice(1)) {
    if (attached !== null && alternatives.includes(attached)) {
      verb = attached;
      attached = null;
    } else {
      const found =
        alternatives[0] === '-m' ? findModule(words, at) : findVerb(words, at, alternatives, tool);
      if (found === null) return null;
      if (found.exhausted === true)
        return { phrase, consumed: found.at, doubt: true, verb: '', unreached: true };
      at = found.at + 1;
      doubt = doubt || found.doubt;
      verb = found.word;
      attached = found.attached ?? null;
    }
    if (OPTIONS_WITH_VALUE[verb] !== undefined) tool = verb;
  }
  return { phrase, consumed: at, doubt, verb };
}

/**
 * The phrase the words of a command begin with, the longest if several do and, among those, one
 * that is not a doubt, and how many of its words it takes. The tool may be spelled with a path or
 * quotes (see `canonicalCommand`).
 */
export function matchCommand(words: readonly string[]): CommandMatch | null {
  const first = canonicalCommand(words[0] ?? '');
  let best: CommandMatch | null = null;
  for (const phrase of PHRASES) {
    if (phrase.words[0]?.includes(first) !== true) continue;
    const match = followPhrase(phrase, words);
    if (match === null) continue;
    const longer = best === null || phrase.words.length > best.phrase.words.length;
    const clearer =
      best !== null &&
      phrase.words.length === best.phrase.words.length &&
      best.doubt &&
      !match.doubt;
    if (longer || clearer) best = match;
  }
  return best;
}
