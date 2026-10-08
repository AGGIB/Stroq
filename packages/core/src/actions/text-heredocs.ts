import { COMMAND_ENVIRONMENT } from './command-environment.js';
import { isGitProgramOption, subcommandOf } from './git-exec.js';
import { flattened } from './shell-names.js';
import type { Lexed, Region, Stage } from './shell-lex.js';
import { PLAIN_WRAPPERS, readWords, resolve, type Word } from './shell-words.js';

/**
 * Which here-documents are text. A document, a commit message or a pull request body that an agent
 * writes with `cat <<'EOF'` is words, and a reading that takes each line of it for a command asks
 * about `rm -rf ~` in a runbook and denies `eval "$(ssh-agent -s)"` in a note. A here-document is
 * a program only for something that runs it: a shell or an interpreter that is given it, a pipe into
 * one, a file that is written and then run, a client that sends it to a server that does
 * (`psql`, `sqlite3`, `ssh`, `crontab`, `at`), a program that starts an editor or a pager that
 * reads it (`git commit` with `core.editor` set to `sh -s`).
 *
 * So the bodies are left out of what the detectors read only when the whole command is plain file
 * and version-control work: every command in it, in every text nested in it, is on the list below
 * and is called by its bare name, and the lexer was sure of all of them. One command that is not on
 * it (a shell, an interpreter, `make`, a script by its path, a word nobody can name) and the
 * bodies are read as they always were. Only a body whose delimiter is quoted is text: one that
 * expands (`<<EOF`) runs the commands in its `$(…)` and backticks, and is read as it is.
 */

/** The shell's own structure: what a loop runs is the commands in it, each read for itself. */
const STRUCTURE: ReadonlySet<string> = new Set([
  'for',
  'while',
  'until',
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'do',
  'done',
  'case',
  'esac',
  'in',
  'select',
  '{',
  '}',
  '(',
  ')',
  '!',
]);

/**
 * Commands that read and write files and text and do not run what they are handed: not a shell, an
 * interpreter, an editor with a shell escape, a build tool, a package manager, or a command that
 * takes a command (`xargs`, `find -exec`, `watch`, `ssh`, `sort --compress-program`, `rg --pre`).
 * Each is matched by the word as it is written, with no directory and no change of case: `./cat`
 * and `/tmp/cat` are files the agent may have written, not `cat`.
 */
const FILE_WORK: ReadonlySet<string> = new Set([
  ...STRUCTURE,
  '',
  'git',
  'gh',
  'cat',
  'tee',
  'cd',
  'pwd',
  'ls',
  'mkdir',
  'cp',
  'mv',
  'rm',
  'touch',
  'echo',
  'printf',
  'true',
  'false',
  'test',
  '[',
  'head',
  'tail',
  'wc',
  'grep',
  'date',
  'sleep',
  'export',
  'set',
  'unset',
  'wait',
  ':',
]);

/**
 * The files a document may be written to and stay a document: a name that says text. A body written
 * to a script, to a program, to a file with no extension, or to a name a variable makes, may be run
 * by what runs next (`./run`, `source x`, a hook, an rc file), and is read as the commands it holds.
 * Not a patch: `git apply` and `patch` make files from it.
 */
const TEXT_FILE = /\.(?:md|markdown|txt|text|rst|adoc|csv|tsv|log|html?)$/i;
const NO_FILE = /^(?:-|\/dev\/(?:stdout|stderr|null|tty))$/;

/** Where a stage writes what it is given: the targets of its output redirects, and what `tee` is given. */
function outputTargets(stage: Stage): string[] {
  const words = readWords(stage.text).words;
  const targets: string[] = [];
  words.forEach((word, i) => {
    if (!word.redirect) return;
    const match = /^(?:\d+|&)?(?:>>|>\||>)(.*)$/.exec(word.value);
    if (match === null || /^(?:\d+|&)?(?:<<<|<<|<&|<>|<)/.test(word.value)) return;
    const target = match[1] !== '' ? match[1] : words[i + 1]?.value;
    // `2>&1` and `>&2` name a descriptor.
    if (target !== undefined && !/^&?\d+-?$/.test(target.replace(/^&/, ''))) targets.push(target);
  });
  const found = resolve(stage.text);
  if (found !== null && found.name === 'tee')
    for (const word of found.args)
      if (!word.redirect && !word.value.startsWith('-')) targets.push(word.value);
  return targets;
}

/** Whether every file a stage writes is a text file or no file. */
const writesOnlyText = (stage: Stage): boolean =>
  outputTargets(stage).every((target) => NO_FILE.test(target) || TEXT_FILE.test(target));

/**
 * Commands that start other programs which share their input: `git commit` starts an editor, `gh pr
 * create` another, and an editor that is `sh -s` reads the input as commands. They are given input
 * only where they read it themselves, as data (`-F -`).
 */
const STARTS_PROGRAMS: ReadonlySet<string> = new Set(['git', 'gh']);

/** The options that name a file to read, which `-` makes the input: `-F -`, `--body-file -`. */
const INPUT_OPTION = /^(?:-[A-Za-z]*F|--(?:file|body-file|notes-file|message-file|input))$/;
/** The same with the value attached, and `gh api`'s `key=@-`. */
const INPUT_ATTACHED =
  /^(?:(?:-F|--(?:file|body-file|notes-file|message-file|input))=?-|(?:\w+=)?@-)$/;

/** Whether a command is told to read its input itself, as the text that it is: `-F -`. */
function readsInputAsData(args: readonly Word[]): boolean {
  return args.some(
    (word, i) =>
      INPUT_ATTACHED.test(word.value) ||
      (word.value === '-' && INPUT_OPTION.test(args[i - 1]?.value ?? '')),
  );
}

/** Whether a stage has its input redirected from a file, a word or a here-document. */
const hasInputRedirect = (stage: Stage): boolean =>
  readWords(stage.text).words.some(
    (word) => word.redirect && /^\d*(?:<<<|<<-?|<>|<&|<)/.test(word.value),
  );

/**
 * Whether a body given to the stage stays a document. Where it ends must be certain: only a plain
 * delimiter is read the same way by every shell (a delimiter that is `$'EOF'`, or has a backslash
 * in double quotes or a line continuation, is read in another way by one of them, and the lines
 * after the shell's own end of the body would be left out). The stage must have a command to give
 * it to (a here-document on the closing word of a loop or a group is given to what is in it, which
 * is not known here), there must be no shebang, and no file that may be run may be written. That the
 * command does not run it is for `isFileWork`, which reads every stage of the command that is left.
 */
function staysText(stage: Stage, body: string, plain: boolean): boolean {
  if (!plain || body.startsWith('#!')) return false;
  const found = resolve(stage.text);
  if (found === null || found.name === '' || STRUCTURE.has(found.word)) return false;
  return writesOnlyText(stage);
}

/** Where a `#` begins a comment: at the start of a word. */
const startsWord = (text: string, at: number): boolean =>
  at === 0 || /[\s;&|(){}<>]/.test(text[at - 1] as string);

/** What a comment may hold that bash 3.2 or another shell may read as more than a comment. */
const IN_A_COMMENT = /[()'"`\\${}]/;

/**
 * What can follow a `$` that is not a parameter or a substitution that begins one. Not a quote: `$'…'`
 * is a string with escapes to bash 3.2, which counts what is in it as its own, and its quote count
 * is not what the plain quote count says (`$'\''` is one string, and three quotes to a counter that
 * does not know it); a body with one in it is read as the commands it may be.
 */
const AFTER_DOLLAR = /[A-Za-z0-9_(?#!@*$-]/;

/**
 * Whether bash 3.2 (`/bin/bash` and `/bin/sh` on a Mac) finds the end of a `$( … )` where the other
 * shells do. It does not know there is a here-document in the substitution: it counts brackets and
 * quotes in the text, so a `)` that no `(` opens ends the substitution there, and the next line runs
 * as a command, where every other shell reads the document first and keeps the lines as text. This
 * reads `inside` (everything the lexer, which knows about the document, puts inside the
 * substitution: the line that opens it, the body, the line that ends it) as bash 3.2 does, and says
 * whether it comes out at its end and not before: every `(` closed, every quote paired, and nothing
 * in it that is read in some other way (a backslash, a brace, a `$` that does not begin a name, a `$`
 * or a backslash in a pair of quotes, a comment, which hides what is in it from that count, with a
 * bracket or a quote in it).
 */
function naiveScanAgrees(inside: string): boolean {
  let depth = 1;
  let quote: string | null = null;
  for (let i = 0; i < inside.length; i += 1) {
    const ch = inside[i] as string;
    if (quote !== null) {
      // In a pair of quotes only its end matters, but a `$`, a backslash or another quote may nest.
      if (ch === quote) quote = null;
      else if (quote === '"' && (ch === '$' || ch === '\\' || ch === '`')) return false;
      else if (quote === '`' && (ch === '$' || ch === '\\' || ch === "'" || ch === '"'))
        return false;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      // The substitution ended before its end: what comes after is a command of the outer line.
      if (depth <= 0) return false;
    } else if (ch === '\\' || ch === '{' || ch === '}' || ch === '\r') return false;
    else if (ch === '$' && !AFTER_DOLLAR.test(inside[i + 1] ?? '')) return false;
    else if (ch === '#' && startsWord(inside, i)) {
      const end = inside.indexOf('\n', i);
      if (IN_A_COMMENT.test(inside.slice(i, end === -1 ? undefined : end))) return false;
      if (end === -1) return depth === 1;
      i = end - 1;
    }
  }
  return quote === null && depth === 1;
}

/** How deep into substitutions the bodies are looked for. */
const MAX_DEPTH = 16;
/** The most bodies that are taken out: past it the command is read whole. */
const MAX_BODIES = 4096;

/**
 * The subcommands of `git` and `gh` that a here-document goes with: a message, a body, a note.
 * Another one (`git apply` makes files from a patch, `git config` and `gh alias` name commands,
 * `gh extension` runs one) is not on it.
 */
const SUBCOMMANDS: Readonly<Record<string, ReadonlySet<string>>> = {
  git: new Set([
    'add',
    'commit',
    'tag',
    'notes',
    'merge',
    'stash',
    'status',
    'diff',
    'log',
    'show',
    'branch',
    'checkout',
    'switch',
    'restore',
    'reset',
    'push',
    'pull',
    'fetch',
    'remote',
    'rev-parse',
    'ls-files',
    'mv',
    'rm',
  ]),
  gh: new Set([
    'pr',
    'issue',
    'release',
    'gist',
    'repo',
    'run',
    'workflow',
    'api',
    'search',
    'status',
    'browse',
    'label',
  ]),
};
/** What `cp` and `mv` may be given: a text file, a directory, `.`. */
const COPY_ARGUMENT = /(?:\.(?:md|markdown|txt|text|rst|adoc|csv|tsv|log|html?)|\/|^\.\.?)$/i;

/**
 * Whether one stage is plain file work: a command word that is a bare name on the list (not `./cat`
 * or `/tmp/cat`, which name a file and not the command), no variable that changes what runs, the
 * `git` and `gh` subcommands a message goes with and no input for them but what they read as data,
 * files copied or moved only where a text file or a directory is, and output only to text files.
 */
export function stageIsFileWork(stage: Stage, piped: boolean): boolean {
  if (COMMAND_ENVIRONMENT.test(flattened(stage.text))) return false;
  const found = resolve(stage.text);
  if (found === null) return true;
  if (found.deep || found.evalProgram !== null) return false;
  // `NAME=value cmd`: any variable can be one a command runs something from (the list of the ones
  // that are is `COMMAND_ENVIRONMENT`'s, and never finished). A value that is a text is a text for
  // the variable, and a variable is not a file.
  if (found.assigned === true) return false;
  // `git fetch --upload-pack="$x"` runs what the option is given, which may be what a body made.
  if (found.args.some((word) => isGitProgramOption(word.value))) return false;
  if (!found.wrappers.every((wrapper) => PLAIN_WRAPPERS.has(wrapper))) return false;
  const command = found.word;
  if (!FILE_WORK.has(command)) return false;
  if (STARTS_PROGRAMS.has(command)) {
    const subcommands = Object.hasOwn(SUBCOMMANDS, command) ? SUBCOMMANDS[command] : undefined;
    const subcommand = subcommandOf(command, found.args);
    if (subcommands === undefined || subcommand === null || !subcommands.has(subcommand))
      return false;
    // Given input by a pipe or a redirect, and not told to read it as data: an editor may read it.
    if ((piped || hasInputRedirect(stage)) && !readsInputAsData(found.args)) return false;
  }
  if (command === 'cp' || command === 'mv') {
    const operands = found.args.filter((word) => !word.redirect && !word.value.startsWith('-'));
    if (!operands.every((word) => COPY_ARGUMENT.test(word.value))) return false;
  }
  return writesOnlyText(stage);
}

/**
 * Whether the lines of a document given to a stage may be commands that run later: the stage writes a file that
 * is not a text file (`cat > run.sh <<'EOF'`, `tee ~/.zshrc`). A filter, an interpreter or a mailer (`sort`, `jq`,
 * `python3`, `mail`, `base64`) is given data or another language, and a shell is given a program that is read as
 * the program it is (`shell-input.ts`); `at now <<'EOF'` is a job by its first line.
 */
export function bodyMayBeScript(stage: Stage, piped: boolean): boolean {
  const found = resolve(stage.text);
  // A document given to no command (`> notes <<'EOF'` only empties the file) is given to nobody.
  if (found === null || found.word === '') return false;
  // `xargs echo` is given words, not commands.
  if (found.wrappers.some((w) => w === 'xargs' || w === 'parallel' || w === 'watch')) return false;
  return FILE_WORK.has(found.word) && !stageIsFileWork(stage, piped);
}

/**
 * Whether every command in the texts is file work, and every text was read with certainty. The
 * texts are those of the command with the bodies already taken out, so that what is in a body (a
 * word `eval` and a `$(`, which a regular expression takes for a command) is not among them.
 */
export function isFileWork(texts: readonly string[], lexedOf: (text: string) => Lexed): boolean {
  for (const text of texts) {
    const lexed = lexedOf(text);
    if (lexed.uncertain) return false;
    for (const stages of lexed.pipelines)
      for (const [index, stage] of stages.entries())
        if (!stageIsFileWork(stage, index > 0)) return false;
  }
  return true;
}

/**
 * The ranges of the here-document bodies that are text (their delimiter was quoted) in `text` and in
 * the `$( … )` and `<( … )` inside it, as positions in `text`, merged and in order. A backtick pair is not looked into: its text has its
 * escapes taken off, so its positions are not the text's.
 */
export function bodyRanges(text: string, lexedOf: (text: string) => Lexed): Region[] {
  const found: Region[] = [];
  let ambiguous = false;
  // `agrees`: bash 3.2 reads every substitution this is in as the other shells do (see
  // `naiveScanAgrees`). A body at the top level is read by every shell the same way.
  const collect = (inside: string, offset: number, depth: number, agrees: boolean): void => {
    const lexed = lexedOf(inside);
    // A text that the shells read in ways of their own (`LexState.ambiguous`) has no body that is
    // text to every one of them, and where a substitution ends in it is not certain either: nothing
    // in the command is taken for text.
    if (lexed.ambiguous) {
      ambiguous = true;
      return;
    }
    for (const { range, stage, plain } of lexed.heredocBodies) {
      const body = inside.slice(range[0], range[1]);
      if (depth > 0 && !agrees) continue;
      if (staysText(stage, body, plain)) found.push([offset + range[0], offset + range[1]]);
    }
    if (depth >= MAX_DEPTH || found.length > MAX_BODIES) return;
    for (const nested of lexed.nested)
      if (!nested.backtick) {
        const inner = inside.slice(nested.from, nested.to);
        collect(inner, offset + nested.from, depth + 1, agrees && naiveScanAgrees(inner));
      }
  };
  collect(text, 0, 0, true);
  if (ambiguous) return [];
  found.sort((a, b) => a[0] - b[0]);
  const merged: Region[] = [];
  for (const range of found) {
    const last = merged[merged.length - 1];
    if (last !== undefined && range[0] <= last[1])
      merged[merged.length - 1] = [last[0], Math.max(last[1], range[1])];
    else merged.push(range);
  }
  return merged;
}

/** The text with the ranges taken out. */
export function withoutRanges(text: string, ranges: readonly Region[]): string {
  if (ranges.length === 0) return text;
  const parts: string[] = [];
  let from = 0;
  for (const [start, end] of ranges) {
    parts.push(text.slice(from, start));
    from = end;
  }
  parts.push(text.slice(from));
  return parts.join('');
}
