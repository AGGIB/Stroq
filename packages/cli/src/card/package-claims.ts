// Which package a command installs or runs, read from its words.
//
// A page that says "run npx some-pkg" and an agent that then runs `npx some-pkg` is the one case of a
// package link worth counting. Everything else the loose link caught was a word: `npx` or `install` in
// prose, a GitHub `owner/repo`, a name the project already depends on. So the command is read as the
// shell reads it (`shell-view.ts`), the phrase has to be one that fetches and runs or installs, and
// the name has to be a name a registry could hold.
import { normalizePackageName } from '@stroq/core';
import { isCommonWord } from './english-words.js';
import { baseOf, type StageView } from './shell-view.js';

export type Ecosystem = 'npm' | 'python';

export interface PackageMention {
  readonly name: string;
  readonly ecosystem: Ecosystem;
}

type Kind = 'run' | 'install';

interface Phrase {
  readonly tool: string;
  /** The words after the tool, in order, that make the phrase; each is one of the alternatives. */
  readonly then: readonly (readonly string[])[];
  readonly kind: Kind;
  readonly ecosystem: Ecosystem;
}

const phrase = (
  tool: string,
  then: readonly string[],
  kind: Kind,
  ecosystem: Ecosystem,
): Phrase => ({ tool, then: then.map((word) => word.split('|')), kind, ecosystem });

const PHRASES: readonly Phrase[] = [
  phrase('npx', [], 'run', 'npm'),
  phrase('pnpx', [], 'run', 'npm'),
  phrase('bunx', [], 'run', 'npm'),
  phrase('uvx', [], 'run', 'python'),
  phrase('pnpm', ['dlx'], 'run', 'npm'),
  phrase('yarn', ['dlx'], 'run', 'npm'),
  phrase('npm', ['exec|x'], 'run', 'npm'),
  phrase('bun', ['x'], 'run', 'npm'),
  phrase('pipx', ['run'], 'run', 'python'),
  phrase('uv', ['tool', 'run'], 'run', 'python'),
  phrase('npm', ['install|i|add'], 'install', 'npm'),
  phrase('pnpm', ['add|install|i'], 'install', 'npm'),
  phrase('yarn', ['add'], 'install', 'npm'),
  phrase('bun', ['add|install|i'], 'install', 'npm'),
  phrase('pip', ['install'], 'install', 'python'),
  phrase('pip3', ['install'], 'install', 'python'),
  phrase('python', ['-m', 'pip', 'install'], 'install', 'python'),
  phrase('python3', ['-m', 'pip', 'install'], 'install', 'python'),
  phrase('pipx', ['install'], 'install', 'python'),
  phrase('uv', ['add'], 'install', 'python'),
  phrase('uv', ['pip', 'install'], 'install', 'python'),
];

/** Options whose next word is their value and not a package. */
const VALUE_FLAGS: ReadonlySet<string> = new Set([
  '-r',
  '--requirement',
  '-c',
  '--constraint',
  '-e',
  '--editable',
  '-i',
  '--index-url',
  '--extra-index-url',
  '--registry',
  '--prefix',
  '--target',
  '-t',
  '--cwd',
  '--filter',
  '-w',
  '--workspace',
  '--python',
  '--from',
  '--with',
]);
/** The options of a runner that name the package to fetch. */
const PACKAGE_FLAGS: ReadonlySet<string> = new Set(['-p', '--package']);

/** Words after a phrase, which are the packages it names. */
function namesAfter(words: readonly string[], from: number, kind: Kind): string[] {
  const named: string[] = [];
  for (let i = from; i < words.length; i += 1) {
    const word = words[i] ?? '';
    if (PACKAGE_FLAGS.has(word)) {
      const value = words[i + 1];
      if (value !== undefined) named.push(value);
      i += 1;
    } else if (word.startsWith('--package=')) {
      named.push(word.slice('--package='.length));
    } else if (VALUE_FLAGS.has(word)) {
      i += 1;
    } else if (!word.startsWith('-')) {
      named.push(word);
      // A runner fetches the first word and runs it: the rest are its arguments.
      if (kind === 'run') break;
    }
  }
  return named;
}

/** Where the phrase's later words are in a stage's words, or -1 when this stage is not that phrase. */
function matchAfter(view: StageView, entry: Phrase): number {
  let at = view.cmd + 1;
  for (const alternatives of entry.then) {
    // The subcommand is the next word that is not an option of the tool (`pnpm --filter x add`).
    while ((view.words[at] ?? '').startsWith('-') && !alternatives.includes(view.words[at] ?? ''))
      at += 1;
    if (!alternatives.includes(view.words[at] ?? '')) return -1;
    at += 1;
  }
  return at;
}

/** The packages a stage installs or runs. */
export function packagesOf(view: StageView): PackageMention[] {
  if (view.cmd === -1) return [];
  const tool = baseOf(view.words[view.cmd] ?? '');
  const out: PackageMention[] = [];
  for (const entry of PHRASES) {
    if (entry.tool !== tool) continue;
    const from = matchAfter(view, entry);
    if (from === -1) continue;
    for (const written of namesAfter(view.words, from, entry.kind))
      out.push({ name: written, ecosystem: entry.ecosystem });
  }
  return out;
}

/** A name npm could hold: a scope and a name, or a name; lower case, no path, no URL. */
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
/** A name PyPI could hold. */
const PYPI_NAME = /^[a-z0-9][a-z0-9._-]*$/;
const MAX_NAME = 214;
const MIN_NAME = 2;

/** The one form of a Python name (PEP 503), for comparing two spellings of it. */
const pythonForm = (name: string): string => name.toLowerCase().replace(/[-_.]+/g, '-');

/** A name as a registry reads it: no version, no extras, lower case. */
export const nameOf = (written: string): string => normalizePackageName(written);

/** Whether the name is a name of the registry and not a word, a path, a URL or a slug. */
export function isPackageName(name: string, ecosystem: Ecosystem): boolean {
  if (name.length < MIN_NAME || name.length > MAX_NAME) return false;
  if (!(ecosystem === 'npm' ? NPM_NAME : PYPI_NAME).test(name)) return false;
  return !isCommonWord(name);
}

/** Whether two spellings are the same package of that registry. */
export const samePackage = (a: string, b: string, ecosystem: Ecosystem): boolean =>
  ecosystem === 'python' ? pythonForm(a) === pythonForm(b) : a === b;

/** Stroq itself is never "a package a page told the agent to run": a security tool's page quotes it. */
export const isStroq = (name: string): boolean => name === 'stroq' || name.startsWith('@stroq/');

/** Names a project depends on or has installed, by registry; see `declaredPackages`. */
export interface DeclaredPackages {
  has(name: string, ecosystem: Ecosystem): boolean;
}

export const NOTHING_DECLARED: DeclaredPackages = { has: () => false };
