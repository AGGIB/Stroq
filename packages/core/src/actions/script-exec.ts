import { basename, isAbsolute, resolve, sep } from 'node:path';
import type { ActionClass } from '../types.js';
import { classifyCommandGroups, type CommandClassification } from './classify-bash.js';
import { changesGlobbing, newPatternBudget } from './file-glob.js';
import { MAX_SCRIPT_BYTES, readScript } from './script-read.js';
import {
  broughtInto,
  foldPath,
  isFolder,
  isProgram,
  mayBeMade,
  onlySetsVariables,
  startsShell,
} from './script-made.js';
import {
  segmentWrites,
  type SegmentWrites,
  type Write,
  type WrittenSource,
} from './script-writes.js';
import {
  expandedPath,
  named,
  resolveScript,
  SCRIPT_EXTENSION,
  scriptPaths,
  type ScriptReference,
} from './script-paths.js';
import { baseOf, MAX_PATH_CHARS, placedSegments, words } from './script-places.js';
import { runOrder } from './script-order.js';
import { isEnvAssignment, readReferences, spellings } from './script-references.js';
import { commandWord } from './shell-segments.js';
import { literalVariables } from './shell-top-level.js';

/**
 * A script an agent runs is the command it was written to be, and the hook sees only
 * its name.
 *
 * Two of the worst incidents of 2026 are this and nothing else. In claude-code #88462 the
 * agent wrote a helper whose `trap` removed `$HOME` on exit, then ran `bash helper.sh`:
 * the permission check saw one harmless command, and the home directory, with its SSH
 * keys and credentials, was gone. In #87360 an agent-written `.ps1` ran `git clean -xdff`
 * in the workspace root and deleted 21 projects; the user's own deny rules for
 * `git clean -f*` did not fire, because the command was `& junction-test.ps1`, and their
 * `PreToolUse` hook passed it.
 *
 * So when a command runs a script that exists on disk, the script's text is read at the
 * moment of the decision and classified as the commands it contains. It is read, not
 * remembered: the file may have been written by the agent a minute ago, by a build, or
 * by a repository the agent cloned, and in every case what matters is what is in it now.
 *
 * Limits, stated rather than implied. Only shell-family scripts are read (`.sh`,
 * `.bash`, `.zsh`, `.ps1`, `.bat`, `.cmd`, the shells' own `source`, and a file with a
 * shell `#!` line run by its path); a Python or Node program is a different problem. A
 * script is read one level deep. A script the same line writes, copies or moves first is
 * judged by where its text comes from (`script-writes.ts`), and one the line may make some
 * other way, after a download, an unpacked archive, a clone or an inline program, is a
 * question (`script-made.ts`); one that changes between the read and the run in any other
 * way is not seen. What a script computes at run time (a variable set
 * in a loop or a function, a name built from `$(…)`) is not followed. A script too big,
 * one that exists and cannot be read, or a command naming too many, is reported as unread
 * (`shell.unparsed`) rather than passed.
 */

/**
 * What a script can add to the command that runs it, and as what. The dangers carry over,
 * with two softenings. `config.self` and `config.git_exec`, which the policy denies at any
 * taint when a command does them directly, are mapped to the class it asks about
 * (`config.self_touch`) or denies only in a tainted session (`config.persistence`): a
 * script that touches agent configuration or installs a git hook is more often a setup
 * script than an attack, and a hard block on one would stop an installer the user asked
 * for. And `eval "$(tool init)"` is not carried over at all (see `NOT_CARRIED_OVER`).
 *
 * `shell.network`, `fs.secrets` and `git.push_external` carry over unchanged. The policy
 * denies each once the session has read something hostile, and in a clean one allows the
 * first two and asks about the third, exactly as for the same line typed directly; leaving
 * them out made "write x.sh, then run `bash x.sh`" a way round every taint-gated deny. An
 * ordinary script is not touched by the push: `git.push_external` is a push to an address
 * (`git push https://…`), a `git remote add` or `set-url`, or `gh repo create --push`, not
 * `git push origin main`; but a script that adds a remote, as a project's setup script may,
 * is asked about as the same line typed directly is. `config.instructions` (a write to a
 * file the agent loads as instructions) and `shell.unparsed` (a line the classifier cannot
 * read, `iex $payload`) carry over for the same reason: each is asked about when typed.
 */
const SCRIPT_CLASS: ReadonlyMap<ActionClass, ActionClass> = new Map<ActionClass, ActionClass>([
  ['shell.exec_encoded', 'shell.exec_encoded'],
  ['shell.destructive', 'shell.destructive'],
  ['shell.network', 'shell.network'],
  ['fs.secrets', 'fs.secrets'],
  ['git.push_external', 'git.push_external'],
  ['config.instructions', 'config.instructions'],
  ['shell.unparsed', 'shell.unparsed'],
  ['config.persistence', 'config.persistence'],
  ['config.self', 'config.self_touch'],
  ['config.git_exec', 'config.persistence'],
]);

/**
 * Signals a script's lines raise that say nothing about the script. `eval "$(tool init)"`
 * is how `nvm.sh`, `~/.zshrc`, `/etc/profile`, direnv, starship, pyenv and ssh-agent set
 * themselves up: of the 128 shell scripts on one developer's machine that were read, 14
 * raised it, and `source ~/.nvm/nvm.sh` would have been a denial at any taint. Run
 * directly, `eval "$(curl …)"` is still caught by its own network signal. The other is
 * PowerShell's `& $command`: of 358 shell and PowerShell scripts read on the same machine,
 * the two that raised it were Python virtualenv `activate.ps1` files, which run an agent's
 * every `.venv\\Scripts\\Activate.ps1`. The third is a shell handed a program from a command
 * this cannot read (`nvm_download … | clean=yes sh`, which `nvm.sh` itself has): typed, it is
 * asked about; inside a script that `source ~/.nvm/nvm.sh` runs, it would ask on every shell.
 * The fourth is a command word that a command substitution makes (`$(dirname "$0")/lib.sh`,
 * `$(npm bin)/tsc`): typed, none of 20,008 commands of a real history has one and it is asked about;
 * in the scripts that the same history ran, 326 of the commands that ran one had it.
 * The programs it CAN read, and what they do, are carried like any other line.
 */
const NOT_CARRIED_OVER: ReadonlySet<string> = new Set([
  'eval-dynamic',
  'ps-call-operator-expression',
  'opaque-shell-input',
]);

/** The ones that are not carried however deep the program was found (`shell-input:`, `ssh-remote:`). */
const NOT_CARRIED_AT_ANY_DEPTH: ReadonlySet<string> = new Set(['command-from-substitution']);

const isCarried = (signal: string): boolean =>
  !NOT_CARRIED_OVER.has(signal) &&
  !NOT_CARRIED_AT_ANY_DEPTH.has(signal.replace(/^(?:shell-input:|ssh-remote:)+/, ''));

const MAX_SCRIPTS = 8;
/** The most copies one command's scripts are followed back through (`mv a b && sh b` reads `a`). */
const MAX_COPIES = 16;
/** The most writes one path is judged for: a line that writes a file over and over is read for the first few. */
const MAX_WRITES_PER_PATH = 8;
/** A file of variables, as `source .env` reads one. */
const DOT_ENV = /(?:^|[/\\])\.env(?:\.[\w-]+)?$/i;
/** A variable named in a script's path: `$S`, `${S}`. */
const NAMED_VARIABLE = /\$\{?([A-Za-z_]\w*)/g;
/** The most candidate paths one command may have looked up before it is reported as unread. */
const MAX_REFERENCE_PROBES = 256;
/** The most values one variable is tried with (see `withVariablesResolved`). */
const MAX_VARIANTS = 4;
/** The text the scripts of one command may add up to: one script's worth, so a command costs what a script does. */
const MAX_TOTAL_SCRIPT_CHARS = MAX_SCRIPT_BYTES;
const MAX_SCRIPT_LINES = 20_000;
/** The longest value a variable keeps; past it the value is a stand-in (see `withVariablesResolved`). */
const MAX_VALUE_CHARS = 2048;
/** What one line, and the whole script, may grow by when its variables are replaced. */
const MAX_LINE_EXPANSION = 32 * 1024;
const MAX_SCRIPT_EXPANSION = 4 * 1024 * 1024;
/** Variables whose value is a place the user lives; every other unknown one is a stand-in. */
const HOME_LIKE = new Set([
  'home',
  'userprofile',
  'homepath',
  'homedrive',
  'onedrive',
  'appdata',
  'localappdata',
  'systemroot',
  'windir',
  'programfiles',
]);
const BASH_ASSIGNMENT =
  /^\s*(?:export\s+|local\s+|readonly\s+|declare\s+(?:-[A-Za-z]+\s+)?)?([A-Za-z_]\w*)=(.*)$/;
const POWERSHELL_ASSIGNMENT = /^\s*\$([A-Za-z_]\w*)\s*=\s*(.*)$/;
// `${NAME}` and the forms that modify it (`${OUT:-dist}`, `${#list}`) are one use of a variable.
// The modifier is bounded: an unclosed `${a${a${a…` would otherwise rescan the line from each `$`.
const VARIABLE_USE =
  /\$(?:env:)?(?:\{([A-Za-z_]\w*)[^}]{0,200}\}|([A-Za-z_]\w*))|\$(?:\{[^}]{0,200}\}|\d|[@*#?!])/g;
const SAFE_PLACEHOLDER = '__stroq_var__';

/**
 * A value without its trailing comment and its quotes. The comment is found by searching
 * for `<space>#`, not by a `\s+#.*$` replace, which retries from every space of a run
 * that has no `#` after it: 128k spaces took 8 s, and the file is the attacker's.
 */
function stripQuotes(value: string): string {
  const comment = value.search(/\s#/);
  const bare = (comment === -1 ? value : value.slice(0, comment)).trim();
  return bare.replace(/^(["'])(.*)\1$/, '$2');
}

/**
 * The script with its variables replaced by what they were set to, so that
 * `HT_HOME="$HOME"` … `rm -rf "$HT_HOME"` reads as the delete of `$HOME` it is. A value
 * taken from a command (`$(mktemp -d)`) is not a place the user lives, and nor is a
 * variable nothing set — a script's own `rm -rf "$BUILD_DIR"` is not a delete of home —
 * so those become a harmless stand-in. Only the user's own directories stay as they are.
 *
 * What is substituted is bounded three ways, because the script is the attacker's.
 * A value is kept only up to `MAX_VALUE_CHARS`: `A1=$A0$A0`, `A2=$A1$A1`, … doubles at
 * every line, and 23 lines of it were 312 bytes that ran the process out of memory. One
 * line takes at most `MAX_LINE_EXPANSION` characters of substitutions and the whole script
 * `MAX_SCRIPT_EXPANSION`; past either, a variable is the stand-in. And an assignment is
 * passed on as written: its value is not a command, and expanding it only made the text
 * the classifier reads larger than the file.
 */
function withVariablesResolved(text: string): string {
  const lines = text.split(/\r?\n/).slice(0, MAX_SCRIPT_LINES);
  let scriptBudget = MAX_SCRIPT_EXPANSION;
  const expand = (line: string, choose: (name: string) => string | undefined): string => {
    let lineBudget = MAX_LINE_EXPANSION;
    return line.replace(VARIABLE_USE, (whole, braced?: string, plain?: string) => {
      const name = braced ?? plain;
      if (name === undefined) return SAFE_PLACEHOLDER;
      const value = choose(name);
      if (value === undefined) return HOME_LIKE.has(name.toLowerCase()) ? whole : SAFE_PLACEHOLDER;
      if (value.length > lineBudget || value.length > scriptBudget) return SAFE_PLACEHOLDER;
      lineBudget -= value.length;
      scriptBudget -= value.length;
      return value;
    });
  };
  // Pass 1: what each assignment sets, with the values known when it runs.
  const current = new Map<string, string>();
  const every = new Map<string, string[]>();
  const assignedAt = new Map<number, readonly [string, string]>();
  lines.forEach((line, index) => {
    const match = BASH_ASSIGNMENT.exec(line) ?? POWERSHELL_ASSIGNMENT.exec(line);
    if (!match) return;
    const name = match[1] as string;
    const raw = stripQuotes(match[2] ?? '');
    const resolved = /\$\(|`|\$\(\(/.test(raw)
      ? SAFE_PLACEHOLDER
      : expand(raw, (n) => current.get(n));
    const value = resolved.length > MAX_VALUE_CHARS ? SAFE_PLACEHOLDER : resolved;
    current.set(name, value);
    const seen = every.get(name) ?? [];
    if (!seen.includes(value) && seen.length < MAX_VARIANTS) every.set(name, [...seen, value]);
    assignedAt.set(index, [name, value]);
  });
  // Pass 2: each line read with the value its variables hold there, and once more with each
  // other value they take anywhere in the file, so that neither a reassignment after the use
  // (`T=$HOME; rm -rf $T; T=./build`) nor a function defined before the assignment it reads
  // hides what the line can do.
  const now = new Map<string, string>();
  const out: string[] = [];
  lines.forEach((line, index) => {
    const assignment = assignedAt.get(index);
    if (assignment !== undefined) {
      now.set(assignment[0], assignment[1]);
      out.push(line);
      return;
    }
    const names = new Set<string>();
    for (const m of line.matchAll(VARIABLE_USE)) {
      const name = m[1] ?? m[2];
      if (name !== undefined) names.add(name);
      if (names.size > 8) break;
    }
    const candidates = (name: string): string[] => {
      const here = now.get(name);
      const all = every.get(name) ?? [];
      return here === undefined ? all : [here, ...all.filter((v) => v !== here)];
    };
    let variants = 1;
    for (const name of names) variants = Math.max(variants, candidates(name).length);
    for (let k = 0; k < Math.min(variants, MAX_VARIANTS); k += 1) {
      out.push(
        expand(line, (name) => {
          const list = candidates(name);
          return list.length === 0 ? undefined : list[Math.min(k, list.length - 1)];
        }),
      );
    }
  });
  return out.join('\n');
}

const isComment = (line: string): boolean => /^\s*(?:#|::|rem\b)/i.test(line);

const TEXT_PRODUCERS: ReadonlySet<string> = new Set(['cat', 'echo', 'printf']);
/** A heredoc piped anywhere is input to something: a shell, or `tee` into a file a later line runs. */
const HEREDOC_PIPED = /\|/;
/** A script that pipes into a shell anywhere may be piping a function's printed heredoc into it. */
const FEEDS_A_SHELL = /\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b|\|\s*(?:source|\.)(?:\s|$)/;
/** The file a redirect writes: `> p.sh`, `>>"$dir/run"`. */
const REDIRECT_TARGET = /(?<![<>&\d])\d?>>?\s*(["']?)([^\s"'|;&<>]{1,512})\1/;
const HEREDOC_DELIMITER = /^-?\s*(['"]?)([A-Za-z_]\w*)\1/;
/** A redirect that leaves the terminal for a file: not `2>&1`, `>&2` or `>/dev/null`. */
const REDIRECT_TO_FILE = /(?<![<>&\d])\d?>>?(?!&|\s*\/dev\/null)/;

/**
 * The delimiter of the heredoc a line opens, or null. A `<<` inside quotes or after a
 * comment is text, and `<<<` is a here-string: neither opens one, and treating them as
 * if they did would hide every line up to a marker that never comes.
 */
function heredocDelimiter(line: string): string | null {
  let quote = '';
  for (let i = 0; i < line.length; i += 1) {
    const ch = line.charAt(i);
    if (quote !== '') {
      if (ch === '\\' && quote === '"') i += 1;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '\\') i += 1;
    else if (ch === '#' && (i === 0 || /\s/.test(line.charAt(i - 1)))) return null;
    else if (ch === '<' && line.charAt(i + 1) === '<') {
      if (line.charAt(i + 2) === '<' || line.charAt(i - 1) === '<') {
        i += 2;
        continue;
      }
      const delimiter = HEREDOC_DELIMITER.exec(line.slice(i + 2, i + 130));
      return delimiter === null ? null : (delimiter[2] as string);
    }
  }
  return null;
}

/**
 * The script without the bodies of heredocs that only print text to the terminal. A usage
 * message (`cat <<EOF … rm -rf ~/.example … EOF`) is words, not a command. Kept, because
 * that body is or becomes a program: a heredoc that is piped (`cat <<EOF | bash`), one given
 * to a shell (`sh <<EOF`), one that is written to a file (`cat > p.sh <<EOF`, which a later line runs),
 * and any whose closing line never comes.
 */
function withoutTextHeredocs(text: string): string {
  const lines = text.split(/\r?\n/);
  // Where each delimiter-shaped line is, so a closing line is found without a scan.
  const markers = new Map<string, number[]>();
  lines.forEach((line, index) => {
    const marker = line.trim();
    if (!/^\w+$/.test(marker)) return;
    const seen = markers.get(marker);
    if (seen === undefined) markers.set(marker, [index]);
    else seen.push(index);
  });
  // A script that pipes into a shell anywhere outside a heredoc body can be piping a printed
  // heredoc into it, from a function or a continued line: none of its heredocs is only text.
  // A body's own `| bash` (a Dockerfile's RUN line) is the body's, and does not count.
  const inBody = new Uint8Array(lines.length);
  for (let i = 0; i < lines.length; i += 1) {
    const delimiter = heredocDelimiter(lines[i] as string);
    if (delimiter === null) continue;
    const close = (markers.get(delimiter) ?? []).find((index) => index > i);
    const end = close ?? lines.length;
    for (let k = i + 1; k < end; k += 1) inBody[k] = 1;
    i = end;
  }
  if (lines.some((line, index) => inBody[index] !== 1 && FEEDS_A_SHELL.test(line))) return text;
  const run = runTargets(lines);
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    kept.push(line);
    const delimiter = heredocDelimiter(line);
    if (delimiter === null || !TEXT_PRODUCERS.has(commandWord(line))) continue;
    // Continued onto the next line, the heredoc may be piped there.
    if (HEREDOC_PIPED.test(line) || /\\\s*$/.test(line)) continue;
    if (REDIRECT_TO_FILE.test(line)) {
      // Written to a file: a program if the file is one (`p.sh`), or if the script runs it
      // (`bash p`, `./p`, `chmod +x p`); data otherwise (a Dockerfile, a README).
      const target = REDIRECT_TARGET.exec(line)?.[2];
      if (target === undefined || SCRIPT_EXTENSION.test(target) || run.has(baseOf(target)))
        continue;
    }
    const close = (markers.get(delimiter) ?? []).find((index) => index > i);
    if (close !== undefined) i = close;
  }
  return kept.join('\n');
}

const RUNNERS: ReadonlySet<string> = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'fish',
  'source',
  '.',
  'exec',
  'chmod',
  'pwsh',
  'powershell',
]);

/** The base names of the files a script runs anywhere: `bash x`, `./x`, `"$dir/x"`, `chmod +x x`. */
function runTargets(lines: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const line of lines) {
    for (const part of line.split(/[;&|()]+/)) {
      const words = part
        .trim()
        .split(/\s+/)
        .map((w) => w.replace(/^["']|["']$/g, ''));
      let at = 0;
      while (at < words.length && (words[at] === 'sudo' || isEnvAssignment(words[at] as string)))
        at += 1;
      const head = words[at];
      if (head === undefined || head === '') continue;
      if (/[/\\]/.test(head)) names.add(baseOf(head));
      if (RUNNERS.has(head)) {
        for (const w of words.slice(at + 1))
          if (!w.startsWith('-') && !w.startsWith('+')) names.add(baseOf(w));
      }
    }
  }
  return names;
}

/** `eval "$(curl …)"`: a fetch run, which `NOT_CARRIED_OVER` must not take for a tool's init. */
const EVAL_REMOTE =
  /\beval\b[^\n]{0,200}?(?:\$\(|`)\s*(?:[A-Za-z_]\w*=\S*\s+){0,3}(?:curl|wget|nc|ncat|socat|fetch|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b/i;

/** Whether every line of a file is a comment or a variable set to text: nothing in it runs. */
/** A copied file as a path from the directory the copy was made in, or as written when that is not known. */
function sourcePath(token: string, directory: string): string {
  const expanded = expandedPath(token, directory);
  if (expanded === null || expanded.length > MAX_PATH_CHARS) return token;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(directory, expanded);
}

/** Whether two writes of a path put the same thing there. */
const sameSource = (a: WrittenSource, b: WrittenSource): boolean =>
  a.kind === b.kind &&
  (a.kind !== 'text' || (b.kind === 'text' && a.text === b.text)) &&
  (a.kind !== 'copy' || (b.kind === 'copy' && a.from === b.from));

function isPlainEnvironment(text: string): boolean {
  return text.split('\n').every((line) => {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return true;
    return /^(?:export\s+)?[A-Za-z_]\w*=/.test(trimmed) && !/\$\(|`/.test(trimmed);
  });
}

/** What the script's own lines would be if run, merged from the classes in `SCRIPT_CLASSES`. */
function classifyScriptText(text: string, cwd: string, name: string): CommandClassification | null {
  const body = withVariablesResolved(withoutTextHeredocs(text))
    .split('\n')
    .filter((line) => !isComment(line))
    .join('\n');
  // Not read for the functions it calls: what is read is a bag of lines, one for each value the variables
  // of a line take, and no function in it ends where it should. A script is read as the lines it holds.
  const found = classifyCommandGroups(body, cwd, 0, { functions: null });
  const classes = new Set<ActionClass>();
  const signals: string[] = [];
  for (const [cls, own] of found.groups) {
    const mapped = SCRIPT_CLASS.get(cls);
    const carried = own.filter(isCarried);
    if (mapped === undefined || carried.length === 0) continue;
    classes.add(mapped);
    signals.push(...carried.map((signal) => `script:${name}:${signal}`));
  }
  if (EVAL_REMOTE.test(body)) {
    classes.add('shell.exec_encoded');
    signals.push(`script:${name}:eval-remote`);
  }
  return classes.size === 0 ? null : { classes: [...classes], hosts: found.hosts, signals };
}

/**
 * The classification of every script file `segments` run, merged, or null when none of
 * them is read or none adds a danger. Reads the files; that is the point. The text of each
 * one read is pushed to `readTexts`, whatever it adds: the secret guard looks through them
 * for a known value, and a script that raised no class can still print one for a later stage
 * of the command to send. What it could
 * not read for want of room (a script past the size or line limit, a command that names
 * more scripts than it reads) is `shell.unparsed`, not nothing.
 */
export function classifyReferencedScripts(
  segments: readonly string[],
  cwd: string,
  readTexts?: string[],
  extraFiles: readonly string[] = [],
  /** Where the segments read out of the command's own (an `sh -c` body, a substitution) begin. */
  nestedFrom: number = segments.length,
  /** The segments the command itself runs (`ownCommandSegments`); without it, those before `nestedFrom`. */
  ownSegments?: ReadonlySet<string>,
): CommandClassification | null {
  const classes = new Set<ActionClass>();
  const signals: string[] = [];
  const hosts = new Set<string>();
  const seen = new Set<string>();
  /** The paths read that were on disk. */
  const present = new Set<string>();
  let probes = 0;
  let scripts = 0;
  let chars = 0;
  let overflow = false;
  const patterns = newPatternBudget();
  patterns.unreliable = segments.some(changesGlobbing);
  const ownAt = (index: number): boolean =>
    ownSegments === undefined ? index < nestedFrom : ownSegments.has(segments[index] as string);
  // Where each segment runs and what it writes, read once for the whole line before anything is judged:
  // a folder the line unpacks into holds what it brought wherever the line runs from it.
  // Read as the shell would expand the variables the line set to a literal (`M=x.sh; bash $M`).
  const variables = literalVariables(segments, ownAt);
  const placed = placedSegments(variables.segments, cwd);
  const made = placed.map(({ segment }) => segmentWrites(segment));
  const broughtOver = broughtInto(placed, made);
  const order = runOrder(segments, nestedFrom, ownAt);
  /** Reads the files a reference names, and says whether one of them was on disk. */
  const consume = (reference: ScriptReference, directory: string): boolean => {
    const found = scriptPaths(reference, directory, patterns);
    if (!found.complete) overflow = true;
    let onDisk = false;
    for (const path of found.paths) {
      consumePath(reference, path, directory);
      if (present.has(path)) onDisk = true;
    }
    return onDisk;
  };
  const consumePath = (reference: ScriptReference, path: string, directory: string): void => {
    if (seen.has(path)) return;
    seen.add(path);
    // Only a file that is a shell script counts toward the limit: a line of a `git add \`
    // list or of a heredoc that starts with a path is looked up and passed over.
    probes += 1;
    if (probes > MAX_REFERENCE_PROBES) {
      overflow = true;
      return;
    }
    const read = readScript(path, reference.needsShebang);
    if (read.kind === 'none') {
      // A program that is there (`/bin/ls`) is no script the line made: it is only not a script,
      // unless the line brought something in that may have replaced it. A file that is there and
      // cannot run (a LICENSE) may be one the line writes and makes runnable.
      if (isProgram(path) && !broughtOver(path)) present.add(path);
      return;
    }
    present.add(path);
    if (read.kind === 'unreadable') {
      // A path that merely looks like a script (a program run by its path, not named as
      // a script) is passed over: only a file the command names as one is worth an ask.
      if (!reference.needsShebang && reference.uncertain !== true) {
        classes.add('shell.unparsed');
        signals.push(`script:${basename(path)}:unreadable`);
      }
      return;
    }
    scripts += 1;
    if (scripts > MAX_SCRIPTS) {
      overflow = true;
      return;
    }
    if (read.kind === 'too-large') {
      classes.add('shell.unparsed');
      signals.push(`script:${basename(path)}:too-large`);
      return;
    }
    // The scripts one command runs share a budget: reading costs time in proportion to the
    // text, the hook has one thread, and a host that times it out treats that as an allow.
    chars += read.text.length;
    if (chars > MAX_TOTAL_SCRIPT_CHARS) {
      classes.add('shell.unparsed');
      signals.push(`script:${basename(path)}:budget`);
      return;
    }
    readTexts?.push(read.text);
    if (read.text.split('\n', MAX_SCRIPT_LINES + 1).length > MAX_SCRIPT_LINES) {
      classes.add('shell.unparsed');
      signals.push(`script:${basename(path)}:too-many-lines`);
    }
    // `source .env` loads variables: configuration, unless a line of it runs something.
    if (reference.sourced === true && DOT_ENV.test(path) && isPlainEnvironment(read.text)) return;
    const found = classifyScriptText(read.text, directory, basename(path));
    if (found === null) return;
    for (const cls of found.classes) classes.add(cls);
    signals.push(...found.signals);
    for (const host of found.hosts) hosts.add(host);
  };
  // Files the command writes before it runs them (`script-writes.ts`): what runs then is not only what
  // is on disk now. Each is judged by where its text comes from as well as by the file on disk, which
  // is always read too (an append keeps what the file held). A path the shell makes as it runs
  // (`"$tmp"`) is matched by the word as it is written.
  const written = new Map<string, WrittenSource[]>();
  /** Paths written more often than they are judged for: run, they are a question. */
  const overflowed = new Set<string>();
  const judged = new WeakSet<WrittenSource>();
  let makes = false;
  /** A piece that may make files without naming them, not placed where it runs: a question only for what the command itself runs. */
  let makesEarly = false;
  const writtenKey = (token: string, directory: string): string => {
    const expanded = expandedPath(token, directory);
    return foldPath(
      expanded !== null && expanded.length <= MAX_PATH_CHARS
        ? isAbsolute(expanded)
          ? resolve(expanded)
          : resolve(directory, expanded)
        : `word:${token.replace(/\$\{(\w+)\}/g, '$$$1')}`,
    );
  };
  // The same write, read again from another directory the line may be in or from another reading of
  // the segment, is one write; a copy's source is put as a path from where the copy was made.
  const remember = (write: Write, directory: string): void => {
    const target = writtenKey(write.path, directory);
    // A copy into a folder that is there lands under its own name (`cp a.sh dir && sh dir/a.sh`).
    const key =
      write.source.kind === 'copy' && isFolder(target)
        ? foldPath(`${target}${sep}${basename(write.source.from)}`)
        : target;
    const source: WrittenSource =
      write.source.kind === 'copy'
        ? { kind: 'copy', from: sourcePath(write.source.from, directory) }
        : write.source;
    const sources = written.get(key) ?? [];
    if (sources.some((known) => sameSource(known, source))) return;
    if (sources.length < MAX_WRITES_PER_PATH) sources.push(source);
    else overflowed.add(key);
    written.set(key, sources);
  };
  /** Judges what the line wrote to a path it runs; returns the files it copied there. */
  const judgeWritten = (reference: ScriptReference, directory: string): string[] => {
    const key = writtenKey(reference.token, directory);
    const name = basename(key.replace(/^word:/, ''));
    // Past the writes a path is judged for, what the last of them made is not known.
    if (overflowed.has(key)) {
      classes.add('shell.unparsed');
      signals.push(`script:${name}:writes-limit`);
    }
    const copied: string[] = [];
    for (const source of written.get(key) ?? []) {
      if (source.kind === 'copy') copied.push(source.from);
      else if (source.kind === 'decoded') {
        classes.add('shell.exec_encoded');
        signals.push(`script:${name}:decoded-then-run`);
      } else if (source.kind === 'fetched') {
        // Run as a script, it is `curl | sh` by another road; a program run by its path, a question.
        classes.add(reference.needsShebang ? 'shell.unparsed' : 'shell.exec_encoded');
        signals.push(`script:${name}:fetched-then-run`);
      } else if (source.kind === 'varies') {
        classes.add('shell.unparsed');
        signals.push(`script:${name}:written-from-a-variable`);
      } else if (source.kind === 'text' && !judged.has(source)) {
        judged.add(source);
        // The text shares the budget of the scripts read, and is read once however often it is run.
        chars += source.text.length;
        if (chars > MAX_TOTAL_SCRIPT_CHARS) {
          classes.add('shell.unparsed');
          signals.push(`script:${name}:budget`);
          continue;
        }
        readTexts?.push(source.text);
        if (reference.sourced === true && DOT_ENV.test(key) && isPlainEnvironment(source.text))
          continue;
        const found = classifyScriptText(source.text, directory, name);
        for (const cls of found?.classes ?? []) classes.add(cls);
        signals.push(...(found?.signals ?? []));
        for (const host of found?.hosts ?? []) hosts.add(host);
      }
    }
    return copied;
  };
  /**
   * A script that is not on disk, run after something in the line that makes files, was made by it
   * (see `mayBeMade`). What the line wrote there is judged by what it wrote, unless that is not known:
   * a copy, a move or another program's output may be just what it made.
   */
  const judgeMissing = (
    reference: ScriptReference,
    directory: string,
    onDisk: boolean,
    own: boolean,
  ): void => {
    if (onDisk || !(makes || (own && makesEarly))) return;
    const key = writtenKey(reference.token, directory);
    const sources = written.get(key);
    if (sources !== undefined && sources.every((source) => source.kind !== 'unknown')) return;
    if (!mayBeMade(reference, own, broughtOver(key))) return;
    classes.add('shell.unparsed');
    signals.push(`script:${basename(reference.token)}:made-by-the-line`);
  };
  // What the line wrote to a path it runs is judged wherever it runs it: only a path the same line
  // wrote is, so a word that only reads as a path costs nothing there.
  /** The copies followed back, each once: the path run, the file it came from, and by whom. */
  const copies = new Set<string>();
  const run = (
    reference: ScriptReference,
    directory: string,
    own: boolean,
    followed: ReadonlySet<string> = new Set(),
  ): void => {
    const copied = judgeWritten(reference, directory);
    const onDisk = consume(reference, directory);
    if (reference.uncertain !== true) judgeMissing(reference, directory, onDisk, own);
    // A copy runs what it copied: the file it came from, on disk and as the line wrote it. A copy
    // back to a file already followed (`cp a a.bak … cp a.bak a`) is what was read there, and a
    // copy run again is read once.
    const key = writtenKey(reference.token, directory);
    const chain = new Set([...followed, key]);
    for (const from of copied) {
      const origin = writtenKey(from, directory);
      const edge = `${key}\0${origin}\0${own}`;
      if (chain.has(origin) || copies.has(edge)) continue;
      copies.add(edge);
      if (copies.size > MAX_COPIES) overflow = true;
      else run({ ...reference, token: from }, directory, own, chain);
    }
  };
  // What the bodies read out of the command write (`bash -c 'curl -o x.sh …' && sh x.sh`) is known
  // before the command's own segments run; they come last in the list, so they are read first.
  for (const writes of made.slice(nestedFrom)) {
    if (writes.makes) makes = true;
    for (const write of writes.writes) remember(write, cwd);
  }
  // So is what a piece read out of the command writes that is not placed where it runs (see
  // `script-order.ts`): a file it may make without naming it is a question only where the command
  // itself runs it, for a `python -c` may come after the paths of a `sed` program read as scripts.
  for (const [index, { directories }] of placed.entries()) {
    if (index >= nestedFrom || ownAt(index) || order.placed.has(index)) continue;
    const writes = made[index] as SegmentWrites;
    if (writes.makes && (writes.writes.length > 0 || writes.into.length > 0)) makes = true;
    else if (writes.makes) makesEarly = true;
    for (const write of writes.writes)
      for (const directory of directories) remember(write, directory);
  }
  /** Startup files a variable the line sets points a later shell at (`export ZDOTDIR=d`). */
  const later: { reference: ScriptReference; directories: readonly string[]; own: boolean }[] = [];
  // Every directory a segment may run in is looked in (see `placedSegments`).
  const judgeSegment = (index: number, own: boolean): void => {
    const { segment, directories } = placed[index] as (typeof placed)[number];
    // The files a shell looks for as it starts are read by the shell a segment starts (`HOME=d bash
    // -l`), and by one the line starts after a segment sets the variable (`export ZDOTDIR=d; …; zsh`):
    // what is made of them is judged as that shell starts.
    const starts = startsShell(segment);
    const sets = !starts && onlySetsVariables(segment);
    for (const found of readReferences(segment, own)) {
      // A name the line gives a literal and then another value is not put in where it cannot tell
      // which one runs, and is a question there.
      for (const [, name] of found.token.matchAll(NAMED_VARIABLE))
        if (variables.changing.has(name as string) && variables.literal.has(name as string)) {
          classes.add('shell.unparsed');
          signals.push(`script:$${name as string}:changes-in-the-line`);
        }
      const read =
        found.startup === true && (starts || sets) ? { ...found, startup: false } : found;
      if (sets && found.startup === true) later.push({ reference: read, directories, own });
      for (const directory of directories) run(starts ? read : found, directory, own);
    }
    if (starts)
      for (const pending of later.splice(0))
        for (const directory of pending.directories) run(pending.reference, directory, pending.own);
  };
  const registerWrites = (index: number): void => {
    const writes = made[index] as SegmentWrites;
    if (writes.makes) makes = true;
    for (const write of writes.writes)
      for (const directory of (placed[index] as (typeof placed)[number]).directories)
        remember(write, directory);
  };
  for (const index of placed.keys()) {
    if (order.placed.has(index)) continue;
    // The pieces that run as this segment runs, in the order of its text, before what it does itself.
    for (const piece of order.within.get(index) ?? []) {
      if (piece.judged) judgeSegment(piece.index, false);
      if (piece.writes) registerWrites(piece.index);
    }
    judgeSegment(index, ownAt(index));
    registerWrites(index);
  }
  // Files a shell is handed on its standard input, found where the pipe is visible.
  for (const file of extraFiles) {
    for (const token of spellings(file)) run(named(token), cwd, true);
  }
  if (overflow) {
    classes.add('shell.unparsed');
    signals.unshift('script-limit');
  }
  return classes.size === 0 ? null : { classes: [...classes], hosts: [...hosts], signals };
}
