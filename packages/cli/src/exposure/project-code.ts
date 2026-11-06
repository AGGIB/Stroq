// What a folder from someone else runs or hides, read from its files and never run.
//
// `repoSurface` answers what git and an editor run from a folder. This answers the question after it:
// a person, or an agent, is about to run `npm test` in it, and what will that do? A reading of text
// cannot know, so what comes out is a list of places to read first, each a signal and none a verdict.
// `strong` is for what honest projects rarely do and what the hook may ask about; `look` is the rest,
// which `stroq inspect` lists and nothing else acts on.
//
// The folder is read as a hostile input: nothing is followed, a pipe is never opened, every file is
// read through `readRegularFile` under a cap, and a run of the walk stops at its limits and says what
// it did not reach. What comes out is fixed phrases, a digest and a path made safe for a terminal. A
// path is still words the folder's author chose: it goes to a person and not to a model.
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, type Dirent } from 'node:fs';
import { basename, join } from 'node:path';
import { classifyCommand, readRegularFile } from '@stroq/core';
import { READ_CAP_BYTES } from '../install/inspect/blind-spots.js';
import { addressOf } from '../install/inspect/addresses.js';
import { entriesOf, ownObject, parseJsonObject } from '../install/inspect/json.js';
import { LONG_LINE, obfuscationReasons } from '../install/inspect/obfuscation.js';
import { showable } from '../install/inspect/safe-text.js';
import { languageOf } from '../install/inspect/source-lines.js';
import { shebangInterpreter } from '../install/inspect/shell-sources.js';
import { LineIndex, type TextFile } from '../install/inspect/text-files.js';

export type CodeSignalKind =
  | 'fetched-text-runs'
  | 'text-runs'
  | 'hidden-past-blanks'
  | 'code-in-data-file'
  | 'obfuscated'
  | 'script-fetches-and-runs'
  | 'raw-dependency'
  | 'tool-file-runs-code'
  | 'tool-runs-programs'
  | 'instruction-runs-code';

export type CodeSignalStrength = 'strong' | 'look';

export interface CodeSignal {
  readonly kind: CodeSignalKind;
  readonly strength: CodeSignalStrength;
  /** The path in the folder, with `/` between its parts, made safe to print. */
  readonly file: string;
  readonly line: number | null;
  /** A digest of what the file holds, so that what was said of it can be held to those bytes. */
  readonly pin: string;
}

export interface ProjectCodeReading {
  /** Strong ones first, then by file and line. */
  readonly signals: readonly CodeSignal[];
  /** What was not looked at, in words. A reading that is not whole says so here and never by silence. */
  readonly notRead: readonly string[];
  readonly filesRead: number;
}

export interface ProjectCodeOptions {
  /** How long the walk may go on, in milliseconds. */
  readonly budgetMs?: number;
  /** The most files read. */
  readonly maxFiles?: number;
  /** The most bytes read, all files together. */
  readonly maxBytes?: number;
}

const BUDGET_MS = 8000;
const MAX_FILES = 20_000;
const MAX_BYTES = 128 * 1024 * 1024;
/** Names looked at, read or not: a folder of a million empty folders is not a project either. */
const MAX_VISITED = 200_000;
const MAX_SIGNALS = 200;
const PATH_SHOWN = 300;
/** The most lines of one file handed to the classifier. */
const MAX_COMMANDS_PER_FILE = 50;
/** The longest piece of a line handed to the classifier. */
const COMMAND_MAX = 2000;
const COMMAND_DEADLINE_MS = 200;
/** The most lines handed to the classifier in one reading, whatever the files. */
const MAX_COMMANDS = 400;
/** The most places of one `package.json`. */
const MAX_MANIFEST_PLACES = 20;
/** How far blanks at the start of a line are looked past to find a comment's mark. */
const MAX_INDENT = 512;
/** How many names go by between two looks at the clock and the other limits of the walk. */
const NAMES_BETWEEN_LOOKS = 256;
/** This many blanks in a row and then more on the line is not how anyone formats code. */
const HIDING_BLANKS = 200;

// ---------------------------------------------------------------------------------------------
// Which files
// ---------------------------------------------------------------------------------------------

const NOT_ENTERED: ReadonlySet<string> = new Set(['.git', '.hg', '.svn']);
const CODE_FILE = /\.(?:js|mjs|cjs|jsx|ts|tsx|mts|cts|py)$/i;
const SHELL_FILE = /\.(?:sh|bash|zsh|ps1)$/i;
const MAKE_FILE = /^(?:GNUmakefile|[Mm]akefile|[Jj]ustfile)$|\.mk$/;
/** Files with a name that says they are not text. A real one has a NUL in it. SVG is text, so it is not here. */
const DATA_FILE = /\.(?:woff2?|ttf|otf|eot|png|jpe?g|gif|ico|webp|bmp|mp[34]|wav|pdf)$/i;
const INSTRUCTION_NAME =
  /^(?:CLAUDE|AGENTS|GEMINI|QWEN)\.md$|^\.(?:cursorrules|windsurfrules|clinerules)$/;
const INSTRUCTION_PATH =
  /^\.(?:cursor|windsurf|clinerules)\/.*\.(?:md|mdc|txt)$|^\.github\/copilot-instructions\.md$|^\.github\/instructions\//;
/** What a tool loads and runs when it is started, with no script that names the file. */
const TOOL_FILE =
  /^(?:(?:hardhat|webpack|vite|vitest|jest|next|nuxt|rollup|babel|postcss|tailwind|svelte|astro|playwright|cypress|eslint)\.config\.[cm]?[jt]s|truffle(?:-config)?\.js|\.eslintrc\.c?js|\.babelrc\.js|(?:gulpfile|Gruntfile)\.[cm]?[jt]s|conftest\.py|setup\.py|noxfile\.py|fabfile\.py)$/;

const isInstruction = (path: string): boolean =>
  INSTRUCTION_NAME.test(basename(path)) || INSTRUCTION_PATH.test(path);

const wanted = (path: string): boolean => {
  const name = basename(path);
  return (
    CODE_FILE.test(name) ||
    SHELL_FILE.test(name) ||
    MAKE_FILE.test(name) ||
    DATA_FILE.test(name) ||
    name === 'package.json' ||
    name === 'foundry.toml' ||
    isInstruction(path)
  );
};

/** A file with no extension is a program only when it may be run, and its first line says of what. */
const isBareProgram = (full: string, name: string): boolean => {
  if (name.includes('.')) return false;
  try {
    return (lstatSync(full).mode & 0o111) !== 0;
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------------------------
// What is looked for
// ---------------------------------------------------------------------------------------------

// Text run as code, when the text is not written right there. The lookahead is what keeps
// `Function('return this')`, which every bundle of the last decade has, out of the reading.
const RUNS_TEXT = {
  js: /(?<![\w$.])eval\s*\(\s*(?!['"`])|(?<![\w$.])(?:new\s+)?Function\s*\(\s*(?!['"`])|\bvm\.(?:runIn\w+|compileFunction)\s*\(\s*(?!['"`])/g,
  py: /(?<![\w.])(?:eval|exec)\s*\(\s*(?!['"])/g,
} as const;

// Where such text would come from: the network, or a decoding.
const FEEDS_TEXT = {
  js: /\b(?:fetch|axios|got|superagent|needle)\s*[.(]|\b(?:XMLHttpRequest|WebSocket)\b|\bhttps?\.(?:get|request)\s*\(|\brequire\(\s*['"](?:node:)?https?['"]\s*\)|\batob\s*\(|['"](?:base64|hex)['"]\s*\)/,
  py: /\b(?:requests|urllib|urllib3|httpx|aiohttp|urlopen|socket)\b|\bb(?:64|32|85)decode\s*\(|\bcodecs\.decode\s*\(/,
} as const;

const COMMENT_START = { js: '//', py: '#' } as const;
const FETCH_WORD = /\b(?:curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod|base64)\b/g;
/** A line with a fetch in it and nothing that could hand it to anything is not worth a classifier's time. */
const HANDS_ON = /\||\b(?:sh|bash|zsh|iex|python3?|node|eval|source)\b/;
const CODE_WORDS = /\brequire\s*\(|\bfunction\b|\bimport\s|\beval\s*\(|=>|\bexec\s*\(|\bfetch\s*\(/;
const FFI_ON = /^[ \t]*ffi[ \t]*=[ \t]*true\b/m;
const SHELLS: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);

/** A NUL, or bytes that did not decode as UTF-8 (`readRegularFile` decodes and marks them): not text. */
const isText = (text: string): boolean => !text.includes('\u0000') && !text.includes('\ufffd');

/** What one run of the reading has left: a file can hold more work than a walk can see coming. */
interface Run {
  readonly deadline: number;
  commands: number;
  commandsCut: number;
  timedOut: boolean;
}

/** The time left, marking the run when there is none. */
function timeLeft(run: Run): number {
  const left = run.deadline - performance.now();
  if (left <= 0) run.timedOut = true;
  return left;
}

/** The text from a place to the end of its line, cut short: a line can be a megabyte long. */
function restOfLine(text: string, from: number): string {
  const end = Math.min(text.length, from + COMMAND_MAX);
  for (let at = from; at < end; at += 1) {
    if (text.charCodeAt(at) === 0x0a) return text.slice(from, at);
  }
  return text.slice(from, end);
}

/** Whether the first thing on a line is the mark of a comment. Blanks are looked past only so far. */
function startsWith(text: string, lineStart: number, mark: string): boolean {
  let at = lineStart;
  const end = Math.min(text.length, lineStart + MAX_INDENT);
  while (at < end && (text.charCodeAt(at) === 0x20 || text.charCodeAt(at) === 0x09)) at += 1;
  return text.startsWith(mark, at);
}

/** Takes off what closes a string or a sentence around a command: `os.system('curl … | sh')`. */
const withoutClosers = (text: string): string => text.replace(/['"`)\],;.\s]+$/, '');

/** Whether the words from a fetch on, as a shell would read them, fetch text and run it. */
function fetchesIntoShell(text: string, run: Run): boolean {
  const left = timeLeft(run);
  if (left <= 0) return false;
  if (run.commands >= MAX_COMMANDS) {
    run.commandsCut += 1;
    return false;
  }
  run.commands += 1;
  try {
    const { classes } = classifyCommand(
      withoutClosers(text.slice(0, COMMAND_MAX)),
      '/stroq/read',
      0,
      { deadlineMs: Math.max(1, Math.min(COMMAND_DEADLINE_MS, left)) },
    );
    return classes.includes('shell.exec_encoded');
  } catch {
    // The classifier is the only reader of this text, and one that cannot read it has found nothing.
    return false;
  }
}

/**
 * The first line of a file on which a fetch is handed to a shell, or null. A line is tried once, from
 * its first fetch to its end, and `keep` is given where it starts, so a long line costs no more than a
 * short one.
 */
function firstFetchIntoShell(
  file: TextFile,
  run: Run,
  keep: (lineStart: number) => boolean,
): number | null {
  let tried = 0;
  let last = 0;
  for (const match of file.text.matchAll(FETCH_WORD)) {
    const line = file.lines.lineAt(match.index);
    if (line === last) continue;
    last = line;
    if (!keep(file.lines.lineStart(line))) continue;
    const rest = restOfLine(file.text, match.index);
    if (!HANDS_ON.test(rest)) continue;
    tried += 1;
    if (tried > MAX_COMMANDS_PER_FILE) {
      run.commandsCut += 1;
      return null;
    }
    if (fetchesIntoShell(rest, run)) return line;
    if (run.timedOut) return null;
  }
  return null;
}

/** The first line with code far to the right of a long run of blanks, or null. One pass. */
function firstHiddenLine(text: string): number | null {
  let line = 1;
  let run = 0;
  let long = false;
  for (let at = 0; at < text.length; at += 1) {
    const c = text.charCodeAt(at);
    if (c === 0x0a) {
      line += 1;
      run = 0;
      long = false;
    } else if (c === 0x20 || c === 0x09) {
      run += 1;
      if (run >= HIDING_BLANKS) long = true;
    } else if (c !== 0x0d) {
      if (long) return line;
      run = 0;
    }
  }
  return null;
}

/** The first place text is run as code outside a comment, or null. */
function firstRun(file: TextFile, language: 'js' | 'py'): number | null {
  for (const match of file.text.matchAll(RUNS_TEXT[language])) {
    const line = file.lines.lineAt(match.index);
    if (!startsWith(file.text, file.lines.lineStart(line), COMMENT_START[language])) return line;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// One file at a time
// ---------------------------------------------------------------------------------------------

type Add = (kind: CodeSignalKind, strength: CodeSignalStrength, line: number | null) => void;

function readCode(file: TextFile, language: 'js' | 'py', run: Run, add: Add): void {
  const tool = TOOL_FILE.test(basename(file.path));
  const reasons = obfuscationReasons(file.text);
  if (reasons.length > 0) add('obfuscated', 'look', null);
  const hidden = firstHiddenLine(file.text);
  if (hidden !== null) add('hidden-past-blanks', 'strong', hidden);

  const fetched = firstFetchIntoShell(
    file,
    run,
    (start) => !startsWith(file.text, start, COMMENT_START[language]),
  );
  if (fetched !== null) add(tool ? 'tool-file-runs-code' : 'fetched-text-runs', 'strong', fetched);
  const textRun = firstRun(file, language);
  if (textRun === null) return;
  if (!FEEDS_TEXT[language].test(file.text)) {
    add('text-runs', 'look', textRun);
    return;
  }
  // A bundle holds a whole program's fetches and evals in one file, whatever it does.
  const bundled = reasons.includes(`a line of thousands of characters`) && file.size > LONG_LINE;
  add(tool ? 'tool-file-runs-code' : 'fetched-text-runs', bundled ? 'look' : 'strong', textRun);
}

function readManifest(file: TextFile, run: Run, add: Add): void {
  const manifest = parseJsonObject(file.text);
  if (manifest === null) return;
  // Each name is looked for from where its group starts, and only for what is reported, up to a limit.
  let placed = 0;
  const report = (
    kind: CodeSignalKind,
    strength: CodeSignalStrength,
    key: string,
    group: string,
  ) => {
    placed += 1;
    if (placed > MAX_MANIFEST_PLACES) return;
    const from = file.text.indexOf(`"${group}"`);
    const at = file.text.indexOf(`"${key}"`, Math.max(from, 0));
    add(kind, strength, at === -1 ? null : file.lines.lineAt(at));
  };
  const scripts = ownObject(manifest, 'scripts');
  for (const [name, text] of scripts === null ? [] : entriesOf(scripts)) {
    if (
      typeof text === 'string' &&
      text.search(FETCH_WORD) !== -1 &&
      HANDS_ON.test(text) &&
      fetchesIntoShell(text, run)
    ) {
      report('script-fetches-and-runs', 'strong', name, 'scripts');
    }
  }
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies'] as const) {
    const group = ownObject(manifest, field);
    for (const [name, spec] of group === null ? [] : entriesOf(group)) {
      const address = typeof spec === 'string' ? addressOf(spec) : null;
      // A dependency on a folder of the same repository is how a monorepo is built.
      if (address !== null && address.kind !== 'file')
        report('raw-dependency', 'look', name, field);
    }
  }
}

/** Reads one file for what it is. False when what it holds is not text. */
function readFile(path: string, text: string, size: number, run: Run, add: Add): boolean {
  if (!isText(text)) return false;
  const file: TextFile = {
    path,
    text,
    exec: false,
    size,
    truncated: false,
    lines: new LineIndex(text),
  };
  const name = basename(path);
  if (DATA_FILE.test(name)) {
    if (CODE_WORDS.test(text)) add('code-in-data-file', 'strong', null);
    return true;
  }
  if (name === 'package.json') {
    readManifest(file, run, add);
    return true;
  }
  if (name === 'foundry.toml') {
    const at = text.search(FFI_ON);
    if (at !== -1) add('tool-runs-programs', 'look', file.lines.lineAt(at));
    return true;
  }
  if (isInstruction(path)) {
    const line = firstFetchIntoShell(file, run, () => true);
    if (line !== null) add('instruction-runs-code', 'strong', line);
    return true;
  }
  if (MAKE_FILE.test(name)) {
    const line = firstFetchIntoShell(file, run, (start) => text.charCodeAt(start) === 0x09);
    if (line !== null) add('script-fetches-and-runs', 'strong', line);
    return true;
  }
  if (SHELL_FILE.test(name) || SHELLS.has(shebangInterpreter(text) ?? '')) {
    const line = firstFetchIntoShell(file, run, (start) => !startsWith(text, start, '#'));
    if (line !== null) add('script-fetches-and-runs', 'look', line);
    return true;
  }
  const language = languageOf(file);
  if (language !== null) readCode(file, language, run, add);
  return true;
}

// ---------------------------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------------------------

/** The names in a folder in a fixed order, or null when it cannot be listed. */
function listOf(full: string): readonly Dirent[] | null {
  try {
    return readdirSync(full, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
  } catch {
    return null;
  }
}

const order = (a: CodeSignal, b: CodeSignal): number =>
  Number(a.strength === 'look') - Number(b.strength === 'look') ||
  (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
  (a.line ?? 0) - (b.line ?? 0);

const OUT_OF_TIME = 'the time this reading may take ran out';

/** Reads a folder as far as its limits allow. Throws nothing: what it could not do is in `notRead`. */
export function readProjectCode(dir: string, options: ProjectCodeOptions = {}): ProjectCodeReading {
  const budgetMs = options.budgetMs ?? BUDGET_MS;
  const maxFiles = options.maxFiles ?? MAX_FILES;
  const maxBytes = options.maxBytes ?? MAX_BYTES;
  const run: Run = {
    deadline: performance.now() + budgetMs,
    commands: 0,
    commandsCut: 0,
    timedOut: false,
  };

  const signals: CodeSignal[] = [];
  const counts = { tooBig: 0, dataTooBig: 0, unreadable: 0, notText: 0, links: 0, cut: 0 };
  let moduleFolders = 0;
  let stopped: string | null = null;
  let visited = 0;
  let bytesRead = 0;
  let filesRead = 0;

  const addFor = (path: string, text: string): Add => {
    let pin: string | null = null;
    return (kind, strength, line) => {
      pin ??= createHash('sha256').update(text).digest('hex');
      if (signals.length >= MAX_SIGNALS) counts.cut += 1;
      else signals.push({ kind, strength, file: showable(path, PATH_SHOWN), line, pin });
    };
  };

  const readOne = (relative: string, full: string): void => {
    const data = DATA_FILE.test(basename(relative));
    let read;
    try {
      read = readRegularFile(full, READ_CAP_BYTES, { noFollow: true });
    } catch {
      counts.unreadable += 1;
      return;
    }
    if (read.kind === 'not-regular') return;
    if (read.kind === 'too-large') {
      if (data) counts.dataTooBig += 1;
      else counts.tooBig += 1;
      return;
    }
    filesRead += 1;
    bytesRead += read.size;
    const add = addFor(relative, read.text);
    if (!readFile(relative, read.text, read.size, run, add) && !data) counts.notText += 1;
  };

  const limitReached = (): string | null => {
    if (timeLeft(run) <= 0) return OUT_OF_TIME;
    if (filesRead >= maxFiles) return `the reading stopped after ${maxFiles} files`;
    if (bytesRead >= maxBytes) return 'the reading reached the most it may read in all';
    if (visited >= MAX_VISITED) return 'the folder has more names than this reading looks at';
    return null;
  };

  // Folders nearest the top first: what a tool loads by itself sits there, and a limit should not cost it.
  let queue: string[] = [''];
  if (listOf(dir) === null) stopped = 'the folder could not be read';
  while (queue.length > 0 && stopped === null) {
    const next: string[] = [];
    for (const folder of queue) {
      visited += 1;
      stopped = limitReached();
      if (stopped !== null) break;
      const entries = listOf(folder === '' ? dir : join(dir, folder));
      if (entries === null) {
        counts.unreadable += 1;
        continue;
      }
      for (const entry of entries) {
        visited += 1;
        if (visited % NAMES_BETWEEN_LOOKS === 0) {
          stopped = limitReached();
          if (stopped !== null) break;
        }
        const relative = folder === '' ? entry.name : `${folder}/${entry.name}`;
        if (entry.isSymbolicLink()) {
          counts.links += 1;
        } else if (entry.isDirectory()) {
          if (entry.name === 'node_modules') moduleFolders += 1;
          else if (!NOT_ENTERED.has(entry.name)) next.push(relative);
        } else if (entry.isFile()) {
          const full = join(dir, relative);
          if (!wanted(relative) && !isBareProgram(full, entry.name)) continue;
          stopped = limitReached();
          if (stopped !== null) break;
          readOne(relative, full);
        }
      }
    }
    queue = next;
  }
  const notRead = [
    ...(stopped === null && run.timedOut ? [OUT_OF_TIME] : []),
    ...(stopped === null ? [] : [stopped]),
    ...(run.commandsCut > 0
      ? [`${run.commandsCut} files or commands past the most one reading looks at`]
      : []),
    ...(moduleFolders > 0 ? ['node_modules: what it holds was not read'] : []),
    ...(counts.tooBig > 0
      ? [`${counts.tooBig} files of code over 1 MiB, which a reading does not take`]
      : []),
    ...(counts.dataTooBig > 0
      ? [`${counts.dataTooBig} files named as fonts, images or media over 1 MiB`]
      : []),
    ...(counts.unreadable > 0 ? [`${counts.unreadable} files or folders it may not read`] : []),
    ...(counts.notText > 0 ? [`${counts.notText} files of code that are not UTF-8 text`] : []),
    ...(counts.links > 0 ? [`${counts.links} links, which are not followed`] : []),
    ...(counts.cut > 0 ? [`${counts.cut} more places past the first ${MAX_SIGNALS}`] : []),
  ];
  return { signals: [...signals].sort(order), notRead, filesRead };
}
