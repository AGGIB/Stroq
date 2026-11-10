// The evidence of a folder that runs code on open: a digest of what runs, which a false-alarm mark is
// kept under (`false-alarms.ts`), so that a mark on a folder is gone once what it runs changes.
//
// What runs is what each agent setting's command runs and what each file git reads says, and the files
// they name, one step deep. Where the reading cannot be sure it has all of it, the evidence holds a value
// that is never the same twice (`unkeyable`), and the moment cannot be marked: that is how a mark fails.
// It cannot be sure of a variable other than the home and the project, a glob, a change of directory, a
// word that names a folder, more words or files than it reads, and more bytes than it hashes.
//
// The commands are read with the hook's own shell reader (`argv`), so a quoted path is one word and an
// expansion is known for one. A config file is plain text and is read word by word: the file itself is
// hashed whole, so what it says is covered, and a file it names is followed when it is there.
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { argv, readRegularFile } from '@stroq/core';

/** The most bytes one folder's evidence hashes, all of its files together. */
const FOLDER_BYTES = 64 * 1024 * 1024;
/** The longest file whose text is read for the files it names. */
const MAX_TEXT_BYTES = 4 * 1024 * 1024;
/** The most files one text names that go into the evidence, and the most words of it looked at. */
const MAX_NAMED = 32;
const MAX_WORDS = 2_000;
/** What separates the words of a config text that could name a file. Quotes are taken off first. */
const WORD_BREAKS = /[\s\0;&|()<>`=,{}[\]]+/;

/**
 * Programs a command runs by name from outside the folder, known by their path and not hashed: a node
 * binary is about 100 MiB, and one that was replaced is a machine taken over, not a folder that changed.
 */
const INTERPRETER =
  /^(?:node|nodejs|python\d*(?:\.\d+)?|bash|sh|zsh|dash|fish|deno|bun|ruby|perl|php|env)$/;

/** Words that make what follows run from another directory, which the reading does not follow. */
const ELSEWHERE: ReadonlySet<string> = new Set([
  'cd',
  'pushd',
  '-C',
  '--prefix',
  '--cwd',
  '--dir',
  '--directory',
  '--manifest-path',
  '--project',
]);
/** `-C<dir>`, the short flag with its directory glued on. */
const GLUED_ELSEWHERE = /^-C./;
const isElsewhere = (word: string): boolean =>
  GLUED_ELSEWHERE.test(word) ||
  ELSEWHERE.has(word) ||
  [...ELSEWHERE].some((flag) => flag.startsWith('--') && word.startsWith(`${flag}=`));

/**
 * The files a runner reads for what it runs, when the command names the runner and not the file:
 * `npm run setup` runs what `package.json` says.
 */
const RUNNER_FILES: Readonly<Record<string, readonly string[]>> = {
  npm: ['package.json'],
  npx: ['package.json'],
  pnpm: ['package.json'],
  yarn: ['package.json'],
  bun: ['package.json'],
  bunx: ['package.json'],
  make: ['Makefile', 'makefile', 'GNUmakefile'],
  gmake: ['Makefile', 'makefile', 'GNUmakefile'],
  just: ['justfile', 'Justfile', '.justfile'],
  task: ['Taskfile.yml', 'Taskfile.yaml'],
  uv: ['pyproject.toml'],
  poetry: ['pyproject.toml'],
  pdm: ['pyproject.toml'],
  hatch: ['pyproject.toml'],
  deno: ['deno.json', 'deno.jsonc'],
  cargo: ['Cargo.toml'],
  composer: ['composer.json'],
  rake: ['Rakefile'],
};

/** Evidence that is never the same twice: a moment with it in its key cannot be marked. */
export const unkeyable = (): string => `unkeyable:${randomBytes(16).toString('hex')}`;

/** What one folder's evidence may still hash. */
export interface Budget {
  bytes: number;
}
export const folderBudget = (): Budget => ({ bytes: FOLDER_BYTES });

/** Opens for a look that neither follows a link nor waits on a pipe: what is read is what the handle shows. */
const LOOK_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/** The digest of what the handle `fd` holds, read through it, within the folder's budget. */
function digestThrough(fd: number, path: string, budget: Budget): string {
  const info = fstatSync(fd);
  if (info.isDirectory()) return `dir:${readdirSync(path).sort().join('\u0000')}`;
  if (!info.isFile()) return 'other';
  if (info.size > budget.bytes) return unkeyable();
  budget.bytes -= info.size;
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(64 * 1024);
  for (let at = 0; at < info.size;) {
    const read = readSync(fd, buffer, 0, buffer.length, at);
    if (read === 0) break;
    hash.update(buffer.subarray(0, read));
    at += read;
  }
  return `file:${hash.digest('hex')}`;
}

/**
 * What the file at `path` holds, as a digest: its bytes, or a folder's names; for a link, where it leads
 * and what is there. The path is opened once, without following a link, and the handle is what is looked
 * at and read, so a file swapped in between is not mistaken for the one that was looked at.
 */
export function fileDigest(path: string, budget: Budget): string {
  let fd: number;
  try {
    fd = openSync(path, LOOK_FLAGS);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ELOOP') return 'unreadable';
    try {
      const real = realpathSync(path);
      return `link:${readlinkSync(path)}\u0000${real}\u0000${fileDigest(real, budget)}`;
    } catch {
      return 'link:dangling';
    }
  }
  try {
    return digestThrough(fd, path, budget);
  } catch {
    return 'unreadable';
  } finally {
    closeSync(fd);
  }
}

/** The text of a file, when it is a regular file small enough to read; else empty. */
function textOf(path: string): string {
  try {
    const read = readRegularFile(path, MAX_TEXT_BYTES);
    return read.kind === 'text' ? read.text : '';
  } catch {
    return '';
  }
}

const isWithin = (path: string, root: string): boolean => {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/** A path with the home and the project spelled out, or null for one with a variable or a glob left in. */
function spelledOut(word: string, root: string): string | null {
  const home = homedir();
  const out = word
    .replace(/^~(?=\/|$)/, home)
    .replace(/\$(?:HOME|\{HOME\})(?=\/|$)/g, home)
    .replace(/\$(?:CLAUDE_PROJECT_DIR|\{CLAUDE_PROJECT_DIR\})(?=\/|$)/g, root);
  return /[$*?[{]/.test(out) || out.startsWith('~') ? null : out;
}

/** What one word names: a file's digest, a reason the evidence cannot be sure, or nothing. */
function wordEvidence(
  word: string,
  root: string,
  bases: readonly string[],
  budget: Budget,
  strict: boolean,
): string | null {
  for (const base of bases) {
    let real: string;
    try {
      real = realpathSync(isAbsolute(word) ? word : join(base, word));
    } catch {
      continue;
    }
    let isFile: boolean;
    try {
      isFile = statSync(real).isFile();
    } catch {
      continue;
    }
    // A command that names a folder runs what the folder holds (`node .`), which is not read.
    if (!isFile) return strict ? unkeyable() : null;
    if (INTERPRETER.test(basename(real)) && !isWithin(real, root)) return `program:${real}`;
    return `${real}\u0000${fileDigest(real, budget)}`;
  }
  return null;
}

/**
 * The files a runner named in a command reads, and what they run. `package.json`'s scripts are commands
 * and are read as commands are; another runner's file is read word by word, and a variable or a glob in
 * it is taken for what the reading cannot follow. `depth` keeps a script that names a runner from
 * leading on: past the first step the evidence cannot cover what runs.
 */
/** The scripts an install runs, in the order npm runs them. */
const INSTALL_SCRIPTS = [
  'preinstall',
  'install',
  'postinstall',
  'preprepare',
  'prepare',
  'postprepare',
];
const INSTALL = new Set([
  'install',
  'i',
  'in',
  'ins',
  'inst',
  'insta',
  'instal',
  'isnt',
  'isnta',
  'isntal',
  'isntall',
  'add',
  'ci',
  'rebuild',
  'rb',
]);
const INSTALL_TEST = new Set(['it', 'install-test', 'cit', 'install-ci-test']);
const RUN = new Set(['run', 'run-script', 'rum', 'urn']);
const TEST = new Set(['test', 't', 'tst']);

/**
 * The scripts of a `package.json` that `runner` runs with the words after it (`args`), with their `pre`
 * and `post`; null for a subcommand the reading does not know, or one that runs a package rather than
 * a script (`npx`, `exec`, `dlx`), which no reading of the folder can follow.
 */
function scriptsRun(
  scripts: Readonly<Record<string, unknown>>,
  runner: string,
  args: readonly string[],
): string[] | null {
  if (runner === 'npx' || runner === 'bunx') return null;
  const words = args.filter((word) => !word.startsWith('-'));
  const [sub, name] = words;
  const around = (script: string): string[] => [`pre${script}`, script, `post${script}`];
  // A bare `yarn`, `pnpm` or `bun` installs; a bare `npm` only prints its help.
  if (sub === undefined) return runner === 'npm' ? [] : INSTALL_SCRIPTS;
  if (RUN.has(sub)) return name === undefined ? [] : around(name);
  if (TEST.has(sub)) return around('test');
  if (sub === 'start' || sub === 'stop') return around(sub);
  if (sub === 'restart') return [...around('restart'), ...around('stop'), ...around('start')];
  if (INSTALL.has(sub)) return INSTALL_SCRIPTS;
  if (INSTALL_TEST.has(sub)) return [...INSTALL_SCRIPTS, ...around('test')];
  // `yarn build`, `pnpm build`, `bun build` run the script of that name; npm does not.
  if (runner !== 'npm' && Object.hasOwn(scripts, sub)) return around(sub);
  return null;
}

function runnerEvidence(
  runner: string,
  root: string,
  budget: Budget,
  depth: number,
  args: readonly string[],
): string[] {
  if (depth > 0) return [unkeyable()];
  return (RUNNER_FILES[runner] ?? []).flatMap((config) => {
    const path = join(root, config);
    const digest = `${config}\u0000${fileDigest(path, budget)}`;
    const text = textOf(path);
    if (config !== 'package.json')
      return text === '' ? [digest] : [digest, ...textEvidence(text, root, [root], budget, true)];
    // The subcommand is read first: one that runs a package (`npx`, `exec`) cannot be followed with or
    // without a `package.json`.
    let scripts: unknown = {};
    if (text !== '') {
      try {
        scripts = (JSON.parse(text) as { scripts?: unknown }).scripts ?? {};
      } catch {
        return [unkeyable()];
      }
    }
    if (scripts === null || typeof scripts !== 'object' || Array.isArray(scripts))
      return [unkeyable()];
    const table = scripts as Readonly<Record<string, unknown>>;
    const names = scriptsRun(table, runner, args);
    if (names === null) return [unkeyable()];
    return [
      digest,
      ...names
        .filter((name) => Object.hasOwn(table, name))
        .flatMap((name) => {
          const script = table[name];
          return typeof script === 'string'
            ? commandEvidence(script, root, [root], budget, depth + 1)
            : [unkeyable()];
        }),
    ];
  });
}

/** The operator words of a list of commands, which `argv` gives as words of their own. */
const LIST_OPERATORS: ReadonlySet<string> = new Set(['&&', '||', ';', '|', '|&']);
/** An unquoted word that still holds one: the reading would not see the command after it. */
const GLUED_OPERATOR = /[;&|]/;
/** An input redirect: the command reads a file the words do not name as a file. */
const INPUT_REDIRECT = /^(?:\d+|\{[A-Za-z_]\w*\})?(?:<<<|<<-|<<|<&|<>|<)/;

/**
 * The evidence of a command an agent setting runs, read as the shell reads it. A runner it names adds
 * the file it reads; a variable, a glob, a change of directory or a folder it names, more words or
 * files than are read: the evidence then cannot cover what runs, and says so.
 */
export function commandEvidence(
  command: string,
  root: string,
  bases: readonly string[],
  budget: Budget,
  depth = 0,
): string[] {
  let words;
  try {
    words = argv(command);
  } catch {
    return [unkeyable()];
  }
  if (words.length > MAX_WORDS) return [unkeyable()];
  const found = new Set<string>();
  // A list of simple commands is read stage by stage; anything else the reading does not follow.
  if (words.some((w) => isElsewhere(w.value))) return [unkeyable()];
  /** The words a runner at `at` is given: up to the operator that ends its command. */
  const argsAfter = (at: number): string[] => {
    const args: string[] = [];
    for (const w of words.slice(at + 1)) {
      if (!w.quoted && LIST_OPERATORS.has(w.value)) break;
      args.push(w.value);
    }
    return args;
  };
  for (const [at, w] of words.entries()) {
    if (found.size > MAX_NAMED) return [unkeyable()];
    if (!w.quoted && LIST_OPERATORS.has(w.value)) continue;
    if (w.redirect) {
      if (INPUT_REDIRECT.test(w.value)) return [unkeyable()];
      continue;
    }
    if (!w.quoted && GLUED_OPERATOR.test(w.value)) return [unkeyable()];
    const word = w.expands ? spelledOut(w.value, root) : w.value;
    if (word === null) return [unkeyable()];
    if (word === '' || word.startsWith('-') || word.includes('://')) continue;
    if (RUNNER_FILES[basename(word)] !== undefined)
      for (const part of runnerEvidence(basename(word), root, budget, depth, argsAfter(at)))
        found.add(part);
    const named = wordEvidence(word, root, bases, budget, true);
    if (named !== null) found.add(named);
  }
  return [...found].sort();
}

/**
 * The evidence of the files a config text names, word by word. The text's own file is hashed whole by
 * the caller, so what it says is covered; a file it names is added when it is there.
 */
export function textEvidence(
  text: string,
  root: string,
  bases: readonly string[],
  budget: Budget,
  strict = false,
): string[] {
  const found = new Set<string>();
  const all = text
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, '$$$1')
    .replace(/["']/g, '')
    .split(WORD_BREAKS);
  if (all.length > MAX_WORDS) return [unkeyable()];
  for (const raw of all) {
    if (found.size > MAX_NAMED) return [unkeyable()];
    if (raw === '' || raw.startsWith('-') || raw.includes('://')) continue;
    const word = spelledOut(raw, root);
    // A git config's own words hold globs and fields (`refs/heads/*`) that name no file: they are passed
    // over. A runner's file runs what it says, so there a variable or a glob is not followed.
    if (word === null) {
      if (strict) return [unkeyable()];
      continue;
    }
    const named = wordEvidence(word, root, bases, budget, strict);
    if (named !== null) found.add(named);
  }
  return [...found].sort();
}

/** The evidence of a file git reads: its bytes, and what it names. */
export function configEvidence(root: string, file: string, budget: Budget): string {
  const path = join(root, file);
  return [
    fileDigest(path, budget),
    ...textEvidence(textOf(path), root, [root, dirname(path)], budget),
  ].join('\u0001');
}
