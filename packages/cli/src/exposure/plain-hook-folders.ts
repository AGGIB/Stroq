import { lstatSync, readdirSync } from 'node:fs';
import { join, posix } from 'node:path';
import { readRegularFile } from '@stroq/core';
import { INSTALL_SCRIPT_NAMES } from './agent-editor.js';
import { hookOutcome } from './hook-outcome.js';
import type { RepoExecHit } from './repo-surface.js';

/**
 * The git hooks of a folder on disk that a commit runs: husky's, a `.githooks` folder's, a folder
 * `core.hooksPath` names, in git's own config or in a script of package.json, and the folder a
 * script tells husky to use. Each file is taken as one in `.git/hooks` is (see `hookOutcome`): a
 * file that is not a commit hook, or a commit hook that downloads and runs code, runs hidden code
 * or sends a secret out, fails before anyone commits, and so does one that is a link, cannot be
 * read, or comes past the files read. Any other is listed.
 *
 * A script fails when it may point git at hooks in a folder this cannot place: one that mentions
 * `core.hooksPath`, its quotes and backslashes taken off, more often than a plain
 * `git config core.hooksPath <folder>` places one; one that runs `git config` or `git -c` (or a
 * command the shell fills in) and holds a `$` or a backquote anywhere, since the shell may build
 * the key or the folder; one that tells husky a folder this does not place; and one that mentions
 * husky across more than one line. Each is one coarse reading, so no two can disagree.
 */

/** What sets `core.hooksPath` in a script: `git config core.hooksPath <folder>`. */
const SETS_HOOKS_PATH = /core\.hookspath["']?(?:\s*=\s*|\s+)([^\s;&|)]+)/gi;
/**
 * What tells husky which folder to use, in a script with its quotes and backslashes taken off:
 * `husky <folder>` or `husky install <folder>`, its program with a path in front
 * (`./node_modules/.bin/husky`) or a version after (`husky@9`), never across a line.
 */
const HUSKY_FOLDER =
  /(?:^|[\s;&|(])(?:[^\s;&|()]*\/)?husky(?:@[^\s;&|()]*)?[ \t]+(?:install[ \t]+)?([^\s;&|()]+)/gi;
/** Words husky takes that name no folder. */
const HUSKY_FLAGS: ReadonlySet<string> = new Set(['-h', '--help', '-v', '--version']);
/** A mention of the key, however it is spelled, once quotes and backslashes are taken off. */
const MENTIONS_HOOKS_PATH = /hookspath/g;
/** The parts of a script a shell runs one after another, or in a subshell. */
const COMMANDS = /[;&|\n\r()]/;
/** What a shell fills in at run time: a variable, a substitution. */
const FILLED_IN = /[$`]/;
/**
 * Whether the name that ends at `at` is a word of its own: what follows it, past a version
 * (`husky@9`), is a blank, the end, or what separates commands. Anything else (`husky/bin.js`,
 * `husky:x`, `HUSKY_DIR`) is husky run or named in a way this does not read.
 */
const endsAWord = (text: string, at: number): boolean =>
  /^(?:@[^\s;&|()]*)?(?:[\s;&|()]|$)/.test(text.slice(at, at + 256));

/**
 * `.git` followed by a `/`, a blank, a separator, a quote, a brace, a comma or the end, anywhere:
 * `x.git/hooks` counts. `.gitignore`, `.github` or `.gitkeep` are other names.
 */
const GIT_PATH = /\.git(?=$|[/\s;&|()<>'"{},])/;
/**
 * Settings that say where git, its config, its folder or its templates are, which can point it at
 * other hooks or bring hooks in: `GIT_DIR`, `--git-dir`, `GIT_WORK_TREE`, any `GIT_CONFIG*`
 * variable, `git-config`, `--exec-path`, `--config-env`, `include.path`, a `.gitconfig`,
 * `--template`, `GIT_TEMPLATE_DIR`, `init.templateDir`. `core.hooksPath` is read on its own above.
 */
const GIT_SETTINGS =
  /git_dir|--git-dir|git_work_tree|git_config|git-config|--exec-path|--config-env|include\.path|\.gitconfig|--template|git_template_dir|init\.templatedir/;
/** A backslash inside or next to `.g`, which hides `.git` from a reading of either kind. */
const BACKSLASH_NEAR_G = /\\\.g|\.\\+g|\.g\\/;
/** Programs that unpack an archive, whose files can land in `.git/hooks`. */
const EXTRACTORS: ReadonlySet<string> = new Set(['tar', 'bsdtar', 'gtar', 'unzip', '7z']);
/** A word that is only option letters, one of them `x`: `-xf`, `xzf`, `--extract` is not one. */
const EXTRACT_FLAG = /^-{0,2}[a-z]*x[a-z]*$/;

/** The words of a command line, split at blanks and at what separates commands. */
const wordsOf = (text: string): string[] => text.split(/[\s;&|()<>]+/).filter((w) => w !== '');

/** Whether a word has a dot followed, later in it, by a glob or brace character. */
function globsAfterDot(word: string): boolean {
  const dot = word.indexOf('.');
  return dot !== -1 && /[*?[{]/.test(word.slice(dot + 1));
}

/** Whether a command of `text` unpacks an archive: `unzip`, `7z`, or `tar` given an `x`. */
const extracts = (text: string): boolean =>
  text.split(/[;&|()\n\r]/).some((part) => {
    const words = wordsOf(part);
    return words.some((w, i) => {
      const program = posix.basename(w).replace(/\.(?:exe|cmd|bat)$/, '');
      if (!EXTRACTORS.has(program)) return false;
      return (
        program !== 'tar' ||
        words.slice(i + 1).some((f) => EXTRACT_FLAG.test(f) || f === '--extract' || f === '--get')
      );
    });
  });

/**
 * Whether a lifecycle script may set or write where git hooks run in a way this does not read.
 * Coarse, so such a script fails: a `$` or a backquote anywhere; a backslash next to `.g`; and, read
 * twice in lower case, unquoted, once with backslashes taken off and once with them as `/`, a
 * `.git` path (`GIT_PATH`), a setting of `GIT_SETTINGS`, a word with a glob or brace after a dot,
 * or an archive unpacked.
 */
function mayWriteHooks(script: string): boolean {
  if (FILLED_IN.test(script)) return true;
  const lower = script.toLowerCase();
  if (BACKSLASH_NEAR_G.test(lower) || BACKSLASH_NEAR_G.test(lower.replace(/["']/g, '')))
    return true;
  return [lower.replace(/["'\\]/g, ''), lower.replace(/["']/g, '').replace(/\\/g, '/')].some(
    (text) =>
      GIT_PATH.test(text) ||
      GIT_SETTINGS.test(text) ||
      wordsOf(text).some(globsAfterDot) ||
      extracts(text),
  );
}

/** The scripts npm runs by itself on install, read coarsely. */
const LIFECYCLE: ReadonlySet<string> = new Set(INSTALL_SCRIPT_NAMES);
/**
 * Lifecycle scripts known to start no other script, compared trimmed, with blanks collapsed and in
 * lower case. Any other lifecycle script may run a runner (npm, a task runner, a script by name),
 * so then every script of the package.json is read coarsely.
 */
const KNOWN_LIFECYCLE: ReadonlySet<string> = new Set([
  'husky',
  'husky install',
  'tsc',
  'tsc -b',
  'node-gyp rebuild',
  'patch-package',
  'simple-git-hooks',
  'lefthook install',
  'is-ci || husky',
]);

/**
 * Whether a lifecycle script is one of `KNOWN_LIFECYCLE`, or `tsc -p` with a plain path: letters,
 * digits, `.`, `_`, `/` and `-` only, so no `;&|(){}<>$` or backquote can follow it.
 */
function isKnownLifecycle(script: string): boolean {
  const text = script.trim().replace(/\s+/g, ' ').toLowerCase();
  return KNOWN_LIFECYCLE.has(text) || /^tsc -p [a-z0-9._/-]+$/.test(text);
}

/** A line break, which a backslash before it may join to the next line. */
const LINE_BREAK = /[\n\r]/;

/** A script with its quotes and backslashes taken off, as a shell may read its words. */
const unquoted = (script: string): string => script.replace(/["'\\]/g, '');

/**
 * Whether a script may set a git config key, or the folder it names, from what the shell fills in:
 * it holds `config` or `-c` as a word, a `$` or a backquote anywhere, and a word that ends in
 * `git` (any letter case, a `.exe` aside) or a command the shell fills in. A coarse reading: such a
 * script fails whatever its words say.
 */
function mayBuildGitConfig(text: string): boolean {
  if (!FILLED_IN.test(text)) return false;
  // In lower case and without a Windows program suffix: a Mac and Windows run `GIT` and
  // `Git.EXE` as git. A word that ends in `git` counts, since a Windows path loses its
  // backslashes when unquoted (`C:\Program Files\Git\bin\git.exe` reads `...bingit.exe`).
  const parts = text.split(COMMANDS).map((part) =>
    part
      .split(/\s+/)
      .filter((w) => w !== '')
      .map((w) => w.toLowerCase().replace(/\.(?:exe|cmd|bat)$/, '')),
  );
  const words = parts.flat();
  if (!words.some((w) => w === 'config' || w === '-c')) return false;
  return (
    words.some((w) => w.endsWith('git')) ||
    parts.some((p) => p[0] !== undefined && FILLED_IN.test(p[0]))
  );
}

/** A plain relative path: no quote, blank, `$`, backquote or `~`, and not absolute. */
const PLAIN_PATH = /^[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*\/?$/;
/** The most bytes of one hook read; a longer one is not read, and fails. */
const MAX_HOOK_BYTES = 256 * 1024;
/** The most files of one folder read; past them, one finding fails. */
const MAX_HOOK_FILES = 200;

/** Why a commit hook fails before anyone commits. */
const RUNS_ON_COMMIT =
  'which a commit runs, and whose text downloads and runs code or sends a secret out';

/** A folder named by a value of `core.hooksPath`, or undefined when it cannot be placed. */
function placed(value: string): string | undefined {
  const quoted = /^(["'])(.*)\1$/.exec(value.trim());
  const text = quoted === null ? value.trim() : (quoted[2] as string);
  if (!PLAIN_PATH.test(text)) return undefined;
  const folder = posix.normalize(text).replace(/\/+$/, '');
  return folder === '..' || folder.startsWith('../') ? undefined : folder;
}

/** What a hook file is: listed, or failing with why. */
function hookHit(root: string, folder: string, name: string, husky: boolean): RepoExecHit {
  const file = `${folder}/${name}`;
  const failing = (why: string): RepoExecHit => ({
    kind: 'git-hook-routine',
    file,
    what: `${name}, ${why}`,
  });
  const path = join(root, folder, name);
  let text: string | undefined;
  try {
    if (lstatSync(path).isSymbolicLink()) return failing('a link, which was not read');
    const read = readRegularFile(path, MAX_HOOK_BYTES);
    text = read.kind === 'text' ? read.text : undefined;
  } catch {
    text = undefined;
  }
  const outcome = hookOutcome(name, text);
  if (outcome === 'routine') return { kind: 'git-hook-routine', file, what: name };
  if (outcome === 'unsafe')
    return failing(text === undefined ? 'which could not be read' : RUNS_ON_COMMIT);
  return husky ? { kind: 'husky-hook', file, what: name } : { kind: 'git-hook', file, what: name };
}

/** The hook files of one folder: the files in it, but husky's own `_` folder and dot files. */
function folderHits(root: string, folder: string): RepoExecHit[] {
  let names: string[];
  try {
    names = readdirSync(join(root, folder), { withFileTypes: true })
      .filter((e) => !e.name.startsWith('.') && !e.name.startsWith('_') && !e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
  const husky = folder === '.husky';
  const hits = names.slice(0, MAX_HOOK_FILES).map((name) => hookHit(root, folder, name, husky));
  const cut = names[MAX_HOOK_FILES];
  if (cut !== undefined)
    hits.push({
      kind: 'git-hook-routine',
      file: `${folder}/${cut}`,
      what: `${names.length - MAX_HOOK_FILES} more hook files, which were not read`,
    });
  return hits;
}

/**
 * The hooks of every folder a commit may run them from. `hooksPaths` are the values git's own
 * config gives `core.hooksPath`; `scripts` the scripts of package.json, by name. Every script is
 * read for the folders it names; a lifecycle script, which npm runs by itself on install, is also
 * read coarsely (see `mayWriteHooks`).
 */
export function plainHookHits(
  root: string,
  hooksPaths: readonly string[],
  scripts: Readonly<Record<string, unknown>>,
): RepoExecHit[] {
  const folders = new Set(['.husky', '.githooks']);
  const out: RepoExecHit[] = [];
  for (const value of hooksPaths) {
    const folder = placed(value);
    if (folder !== undefined) folders.add(folder);
  }
  const unplaced = (value: string): void => {
    out.push({
      kind: 'git-hook-routine',
      file: 'package.json',
      what: `a script points git at hooks in ${value}, a folder this cannot place, so its hooks were not read`,
    });
  };
  // A lifecycle script not known to start nothing else may start any script: then every one is
  // read coarsely.
  const everyCoarse = Object.entries(scripts).some(
    ([name, script]) =>
      LIFECYCLE.has(name) && (typeof script !== 'string' || !isKnownLifecycle(script)),
  );
  const coarse = (name: string): boolean => LIFECYCLE.has(name) || everyCoarse;
  for (const [name, script] of Object.entries(scripts)) {
    if (typeof script !== 'string') continue;
    const before = out.length;
    // Every mention must be one the exact reading placed; a spelling it cannot read fails.
    const text = unquoted(script);
    const mentions = text.toLowerCase().match(MENTIONS_HOOKS_PATH);
    let placedCount = 0;
    let failed = false;
    for (const match of script.matchAll(SETS_HOOKS_PATH)) {
      const folder = placed(match[1] as string);
      if (folder === undefined) {
        unplaced(match[1] as string);
        failed = true;
      } else {
        folders.add(folder);
        placedCount += 1;
      }
    }
    if (!failed && (mentions?.length ?? 0) > placedCount) {
      unplaced('a core.hooksPath this does not read');
      failed = true;
    }
    if (!failed && mayBuildGitConfig(text)) {
      unplaced('a folder git config may build from what the shell fills in');
      failed = true;
    }
    // One reading of husky: each folder it names is placed, or the script fails. A script over
    // more than one line may join them with a backslash, which no reading of one line sees.
    const huskyUnread = !/husky/i.test(text)
      ? undefined
      : LINE_BREAK.test(script)
        ? 'a husky folder on another line'
        : FILLED_IN.test(text)
          ? 'a husky folder the shell may fill in'
          : [...text.matchAll(/husky/gi)].some((m) => !endsAWord(text, m.index + 5))
            ? 'husky run in a way this does not read'
            : undefined;
    if (huskyUnread !== undefined) unplaced(huskyUnread);
    for (const match of text.matchAll(HUSKY_FOLDER)) {
      const value = match[1] as string;
      if (HUSKY_FLAGS.has(value.toLowerCase())) continue;
      const folder = value.startsWith('-') ? undefined : placed(value);
      // One finding a script: what fails it already is said above.
      if (folder !== undefined) folders.add(folder);
      else if (huskyUnread === undefined) unplaced(value);
    }
    // One finding a script: the coarse reading only when nothing above failed it.
    if (out.length === before && coarse(name) && mayWriteHooks(script))
      out.push({
        kind: 'git-hook-routine',
        file: 'package.json',
        what: `the ${name} script may set or write where git hooks run, in a way this does not read, so those hooks were not read`,
      });
  }
  return [...out, ...[...folders].flatMap((folder) => folderHits(root, folder))];
}
