import { statSync } from 'node:fs';
import { basename, isAbsolute, resolve, sep } from 'node:path';
import { expandedPath, SCRIPT_EXTENSION, type ScriptReference } from './script-paths.js';
import { baseOf, MAX_PATH_CHARS, type PlacedSegment } from './script-places.js';
import type { SegmentWrites } from './script-writes.js';
import { SHELL_STARTERS, SHELL_WORDS } from './shell-lex.js';
import { commandWord } from './shell-segments.js';
import { resolve as resolveCommand } from './shell-words.js';

/**
 * Whether a script a line runs, that is not on disk when the line is judged, may be one the line itself
 * makes: then what runs cannot be read, and `classifyReferencedScripts` asks about the line. The line
 * must make files somehow (`SegmentWrites.makes`); this says which of the scripts it runs it may have made.
 */

/** The characters of a file name a line makes and then runs: none a shell would split, quote or expand. */
const MADE_NAME = /^[\w.@+-]+$/;

/** A program a virtual environment or a package's install puts there: made by an install, not a script. */
const INSTALLED_PROGRAM =
  /(?:^|[/\\])(?:\.?venv[\w.-]*|env|virtualenv|\.tox[/\\][^/\\]+)[/\\](?:bin|Scripts)[/\\][^/\\]+$|(?:^|[/\\])node_modules[/\\]\.bin[/\\][^/\\]+$/;

/** Programs that start a shell, which reads the startup files of the directory it is pointed at. */
const SHELL_LAUNCHERS: ReadonlySet<string> = new Set([
  ...SHELL_WORDS,
  ...SHELL_STARTERS,
  'script',
  'tmux',
  'screen',
  'login',
  'parallel',
]);

/** Whether a segment starts a shell: `zsh -c true`, `env -i HOME=d bash -l`, `script -q /dev/null`. */
export function startsShell(segment: string): boolean {
  const name = resolveCommand(segment)?.name || commandWord(segment);
  return SHELL_LAUNCHERS.has(baseOf(name).toLowerCase());
}

/** The commands that only set a variable of the shell, which the shells it starts later see. */
const SETTERS: ReadonlySet<string> = new Set(['export', 'declare', 'typeset', 'readonly', 'local']);

/** Whether a segment only sets variables: `HOME=d`, `HOME="a b"`, `export ZDOTDIR=d`, `declare -x HOME=d`. */
export function onlySetsVariables(segment: string): boolean {
  const command = resolveCommand(segment);
  return command === null ? /^\s*[A-Za-z_]\w*\+?=/.test(segment) : SETTERS.has(command.name);
}

const FOLDED = process.platform === 'darwin' || process.platform === 'win32';
/** macOS and Windows name `X.sh` and `x.sh` the same file. */
export const foldPath = (path: string): string => (FOLDED ? path.toLowerCase() : path);

/**
 * Whether a path may hold what the line brings in: below a folder it unpacks an archive or clones a
 * repository into (`SegmentWrites.into`). Any path when one of those folders is not known, and a path
 * that is not known (a `word:` key) when the line brings anything in.
 */
export function broughtInto(
  placed: readonly PlacedSegment[],
  made: readonly SegmentWrites[],
): (path: string) => boolean {
  const folders = new Set<string>();
  let anywhere = false;
  placed.forEach(({ directories }, index) => {
    for (const word of made[index]?.into ?? [])
      for (const directory of directories) {
        const expanded = word === null ? null : expandedPath(word, directory);
        if (expanded === null || expanded.length > MAX_PATH_CHARS) anywhere = true;
        else
          folders.add(
            foldPath(isAbsolute(expanded) ? resolve(expanded) : resolve(directory, expanded)),
          );
      }
  });
  return (path) => {
    if (anywhere) return true;
    if (path.startsWith('word:')) return folders.size > 0;
    const folded = foldPath(path);
    for (const folder of folders)
      if (folded === folder || folded.startsWith(folder.endsWith(sep) ? folder : `${folder}${sep}`))
        return true;
    return false;
  };
}

/**
 * Whether a script that is not on disk may be one the line made. Not a file a shell looks for as it
 * starts and skips when it is missing (`ScriptReference.startup`); not a program an install puts in a
 * virtual environment or `node_modules/.bin` (`python -m venv v && v/bin/pip …`), unless the line
 * brought something in where it is (`brought`). In the command itself, any other: a name given to a
 * shell however it is spelled, a path however it is written. In the text read out of it (a body, a
 * substitution, a heredoc) the reading is less sure of what is a command, so only what is run as a
 * script is: by a shell, by its name (`x.sh`), by a path from here (`./x`) or from the root through a
 * folder (`/tmp/p`), under a plain file name, which a piece of a `sed` program or a URL is not.
 */
export function mayBeMade(reference: ScriptReference, own: boolean, brought: boolean): boolean {
  // An address read as a command word is no file the line made.
  if (reference.startup === true || reference.token === '' || reference.token.includes('://'))
    return false;
  if (reference.direct === true && !brought && INSTALLED_PROGRAM.test(reference.token))
    return false;
  if (own) return true;
  const name = basename(reference.token);
  if (!MADE_NAME.test(name) || /^\d+$/.test(name)) return false;
  // From the root, through a folder at least (`/tmp/p`): `/return s` is a piece of a `sed` program.
  return (
    reference.direct !== true ||
    SCRIPT_EXTENSION.test(reference.token) ||
    /^(?:\.\.?[/\\]|[/\\][^/\\]+[/\\]|[A-Za-z]:[/\\])/.test(reference.token)
  );
}

/** A folder that is there. */
export function isFolder(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** A file that is there and can run: executable for someone, or a folder. */
export function isProgram(path: string): boolean {
  try {
    const info = statSync(path);
    return info.isDirectory() || (info.isFile() && (info.mode & 0o111) !== 0);
  } catch {
    return false;
  }
}
