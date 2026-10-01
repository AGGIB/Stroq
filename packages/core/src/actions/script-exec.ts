import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import type { ActionClass } from '../types.js';
import { classifyCommandGroups, type CommandClassification } from './classify-bash.js';
import { commandWord } from './shell-segments.js';

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
 * script is read one level deep. A script that does not exist yet, or changes between
 * the read and the run, is not seen. What a script computes at run time (a variable set
 * in a loop or a function, a name built from `$(…)`) is not followed. A script too big,
 * or a command naming too many, is reported as unread (`shell.unparsed`) rather than
 * passed.
 */

/**
 * What a script can add to the command that runs it, and as what. The dangers carry over,
 * with two softenings. `config.self` and `config.git_exec`, which the policy denies at any
 * taint when a command does them directly, are mapped to the class it asks about
 * (`config.self_touch`) or denies only in a tainted session (`config.persistence`): a
 * script that touches agent configuration or installs a git hook is more often a setup
 * script than an attack, and a hard block on one would stop an installer the user asked
 * for. And `eval "$(tool init)"` is not carried over at all (see `NOT_CARRIED_OVER`).
 */
const SCRIPT_CLASS: ReadonlyMap<ActionClass, ActionClass> = new Map<ActionClass, ActionClass>([
  ['shell.exec_encoded', 'shell.exec_encoded'],
  ['shell.destructive', 'shell.destructive'],
  ['config.persistence', 'config.persistence'],
  ['config.self', 'config.self_touch'],
  ['config.git_exec', 'config.persistence'],
]);

/**
 * Signals a script's lines raise that say nothing about the script. `eval "$(tool init)"`
 * is how `nvm.sh`, `~/.zshrc`, `/etc/profile`, direnv, starship, pyenv and ssh-agent set
 * themselves up: of the 128 shell scripts on one developer's machine that were read, 14
 * raised it, and `source ~/.nvm/nvm.sh` would have been a denial at any taint. Run
 * directly, `eval "$(curl …)"` is still caught by its own network signal.
 */
const NOT_CARRIED_OVER: ReadonlySet<string> = new Set(['eval-dynamic']);

const MAX_SCRIPTS = 8;
const MAX_PATH_CHARS = 4096;
/** The most candidate paths one command may have looked up before it is reported as unread. */
const MAX_REFERENCE_PROBES = 256;
/** The most values one variable is tried with (see `withVariablesResolved`). */
const MAX_VARIANTS = 4;
const MAX_SCRIPT_BYTES = 1024 * 1024;
const MAX_SCRIPT_LINES = 20_000;
/** The longest value a variable keeps; past it the value is a stand-in (see `withVariablesResolved`). */
const MAX_VALUE_CHARS = 2048;
/** What one line, and the whole script, may grow by when its variables are replaced. */
const MAX_LINE_EXPANSION = 32 * 1024;
const MAX_SCRIPT_EXPANSION = 4 * 1024 * 1024;
const SHEBANG_BYTES = 128;
const SCRIPT_SHELLS: ReadonlySet<string> = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'fish',
  'source',
  '.',
]);
const POWERSHELLS: ReadonlySet<string> = new Set([
  'powershell',
  'powershell.exe',
  'pwsh',
  'pwsh.exe',
]);
const SCRIPT_EXTENSION = /\.(?:sh|bash|zsh|ksh|ps1|bat|cmd)$/i;
/** `#!/bin/bash`, `#!/usr/bin/env -S bash -e`: a file that says it is a shell script. */
const SHELL_SHEBANG = /^#!\s*(?:\S*\/)?(?:env\s+(?:-\S+\s+)*)?(?:ba|z|da|k|fi)?sh\b/;
/** Options of a shell whose next word is their value, not the script. */
const SHELL_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '-o',
  '+o',
  '-O',
  '+O',
  '--rcfile',
  '--init-file',
]);

/** Whitespace-separated words with quotes honoured and backslashes kept: a Windows path stays one. */
function words(segment: string): string[] {
  return (segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((w) => w.replace(/^["']|["']$/g, ''));
}

const isEnvAssignment = (word: string): boolean => /^[A-Za-z_]\w*=/.test(word);
const baseOf = (word: string): string => word.replace(/^.*[/\\]/, '');

/** A script a command names: as it is written, and whether only a shell `#!` line makes it one. */
interface ScriptReference {
  readonly token: string;
  readonly needsShebang: boolean;
}

const named = (token: string): ScriptReference => ({ token, needsShebang: false });

/**
 * The script a shell is told to run. Its options come first and the script is the first
 * word that is not one: after the script, `-c` and `-n` belong to the script. A shell
 * given a string (`-c`) or only asked to check syntax (`-n`) runs no file; one given no
 * script reads its standard input, which `bash < x.sh` points at a file.
 */
function shellScript(rest: readonly string[]): string | null {
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i] as string;
    if (token === '--') return rest[i + 1] ?? null;
    // Letters captured, then tested: `-[A-Za-z]*[cn][A-Za-z]*` split one long word two ways
    // and took 2 s on `bash -nnnn…`.
    const letters = /^-([A-Za-z]+)$/.exec(token)?.[1];
    if (token === '--noexec' || (letters !== undefined && /[cn]/.test(letters))) return null;
    // `-o pipefail`, and a cluster that ends in one: `-euo pipefail`, `-eO extglob`.
    if (SHELL_VALUE_OPTIONS.has(token) || (letters !== undefined && /[oO]$/.test(letters))) {
      i += 1;
      continue;
    }
    if (token === '<') return rest[i + 1] ?? null;
    if (token.startsWith('<') && !token.startsWith('<<') && !token.startsWith('<(')) {
      return token.slice(1);
    }
    if (!token.startsWith('-') && !token.startsWith('+')) return token;
  }
  return null;
}

/** The script files a segment runs, as written: `bash x.sh`, `source x.sh`, `./x.sh`, `pwsh -File x.ps1`. */
function scriptReferences(segment: string): ScriptReference[] {
  const tokens = words(segment);
  // PowerShell's call operator: `& ./clean.ps1`, `& 'C:\\tools\\clean.ps1' -Force`.
  if (tokens[0] === '&') {
    const callee = tokens[1];
    return callee !== undefined && SCRIPT_EXTENSION.test(callee) ? [named(callee)] : [];
  }
  const word = commandWord(segment).toLowerCase();
  if (word === '') return [];
  const at = tokens.findIndex((t) => !isEnvAssignment(t) && baseOf(t).toLowerCase() === word);
  if (at === -1) return [];
  const head = tokens[at] ?? '';
  const rest = tokens.slice(at + 1);
  if (SCRIPT_SHELLS.has(word)) {
    const target = shellScript(rest);
    return target === null ? [] : [named(target)];
  }
  if (POWERSHELLS.has(word)) {
    const file = rest.findIndex((t) => /^-f(?:ile)?$/i.test(t));
    if (file !== -1 && rest[file + 1] !== undefined) return [named(rest[file + 1] as string)];
    const direct = rest.find((t) => !t.startsWith('-') && SCRIPT_EXTENSION.test(t));
    return direct === undefined ? [] : [named(direct)];
  }
  if (word === 'cmd' || word === 'cmd.exe') {
    const run = rest.findIndex((t) => /^\/[ck]$/i.test(t));
    const target = run === -1 ? undefined : rest[run + 1];
    return target !== undefined && SCRIPT_EXTENSION.test(target) ? [named(target)] : [];
  }
  // Run directly, by a path: `./deploy.sh`, `scripts\clean.ps1`, and `./cleanup` when the
  // file begins with a shell `#!` line.
  if (!/[/\\]/.test(head)) return [];
  return [{ token: head, needsShebang: !SCRIPT_EXTENSION.test(head) }];
}

/** A path as the shell would expand it: `~`, `$HOME` and `$PWD` at the front; any other variable is unknown. */
function expandedPath(token: string, cwd: string): string | null {
  const front = /^(?:~|\$HOME|\$\{HOME\}|\$PWD|\$\{PWD\})(?=[/\\]|$)/.exec(token);
  const rest = front === null ? token : token.slice(front[0].length);
  const root = front === null ? '' : front[0].includes('PWD') ? cwd : homedir();
  const joined = front === null ? rest : join(root, rest);
  return /[$`*?<>|]/.test(joined) ? null : joined;
}

function resolveScript(token: string, cwd: string): string | null {
  if (token === '') return null;
  // `source .env` loads variables; it is configuration, not a program.
  if (/(?:^|[/\\])\.env(?:\.[\w-]+)?$/i.test(token)) return null;
  const expanded = expandedPath(token, cwd);
  if (expanded === null) return null;
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

type ScriptRead =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'too-large' }
  | { readonly kind: 'none' };

/**
 * The script's text, read through one descriptor: what is checked (a regular file, its
 * size, a shell `#!` line) is what is read, so a file swapped between a check and a read is
 * not a way around either.
 */
function readScript(path: string, needsShebang: boolean): ScriptRead {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const info = fstatSync(fd);
    if (!info.isFile()) return { kind: 'none' };
    if (needsShebang) {
      const head = Buffer.alloc(SHEBANG_BYTES);
      const read = readSync(fd, head, 0, SHEBANG_BYTES, 0);
      if (!SHELL_SHEBANG.test(head.toString('latin1', 0, read))) return { kind: 'none' };
    }
    if (info.size > MAX_SCRIPT_BYTES) return { kind: 'too-large' };
    const buffer = Buffer.alloc(info.size);
    let filled = 0;
    while (filled < info.size) {
      const read = readSync(fd, buffer, filled, info.size - filled, filled);
      if (read === 0) break;
      filled += read;
    }
    const text = buffer.toString('utf8', 0, filled);
    return text.includes('\0') ? { kind: 'none' } : { kind: 'text', text };
  } catch {
    return { kind: 'none' };
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

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

/** What the script's own lines would be if run, merged from the classes in `SCRIPT_CLASSES`. */
function classifyScriptText(text: string, cwd: string, name: string): CommandClassification | null {
  const body = withVariablesResolved(withoutTextHeredocs(text))
    .split('\n')
    .filter((line) => !isComment(line))
    .join('\n');
  const found = classifyCommandGroups(body, cwd);
  const classes = new Set<ActionClass>();
  const signals: string[] = [];
  for (const [cls, own] of found.groups) {
    const mapped = SCRIPT_CLASS.get(cls);
    const carried = own.filter((signal) => !NOT_CARRIED_OVER.has(signal));
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
 * them is read or none adds a danger. Reads the files; that is the point. What it could
 * not read for want of room (a script past the size or line limit, a command that names
 * more scripts than it reads) is `shell.unparsed`, not nothing.
 */
export function classifyReferencedScripts(
  segments: readonly string[],
  cwd: string,
): CommandClassification | null {
  const classes = new Set<ActionClass>();
  const signals: string[] = [];
  const hosts = new Set<string>();
  const seen = new Set<string>();
  let probes = 0;
  let scripts = 0;
  let overflow = false;
  let directory = cwd;
  const saved: string[] = [];
  for (const raw of segments) {
    const opens = /^[\s(]*/.exec(raw)?.[0].replace(/\s/g, '').length ?? 0;
    for (let k = 0; k < opens; k += 1) saved.push(directory);
    const segment = raw.replace(/^[\s({]+/, '');
    directory = directoryAfter(segment, directory);
    for (const reference of scriptReferences(segment)) {
      const path = resolveScript(reference.token, directory);
      if (path === null || seen.has(path)) continue;
      seen.add(path);
      // Only a file that is a shell script counts toward the limit: a line of a `git add \`
      // list or of a heredoc that starts with a path is looked up and passed over.
      probes += 1;
      if (probes > MAX_REFERENCE_PROBES) {
        overflow = true;
        break;
      }
      const read = readScript(path, reference.needsShebang);
      if (read.kind === 'none') continue;
      scripts += 1;
      if (scripts > MAX_SCRIPTS) {
        overflow = true;
        continue;
      }
      if (read.kind === 'too-large') {
        classes.add('shell.unparsed');
        signals.push(`script:${basename(path)}:too-large`);
        continue;
      }
      if (read.text.split('\n', MAX_SCRIPT_LINES + 1).length > MAX_SCRIPT_LINES) {
        classes.add('shell.unparsed');
        signals.push(`script:${basename(path)}:too-many-lines`);
      }
      const found = classifyScriptText(read.text, directory, basename(path));
      if (found === null) continue;
      for (const cls of found.classes) classes.add(cls);
      signals.push(...found.signals);
      for (const host of found.hosts) hosts.add(host);
    }
    for (let k = trailingCloses(raw); k > 0 && saved.length > 0; k -= 1) {
      directory = saved.pop() ?? directory;
    }
  }
  if (overflow) {
    classes.add('shell.unparsed');
    signals.unshift('script-limit');
  }
  return classes.size === 0 ? null : { classes: [...classes], hosts: [...hosts], signals };
}

/** How many `)` a segment ends with, read back from its end (a regex here was quadratic). */
function trailingCloses(raw: string): number {
  let count = 0;
  for (let i = raw.length - 1; i >= 0; i -= 1) {
    const ch = raw.charAt(i);
    if (ch === ')') count += 1;
    else if (!/\s/.test(ch)) break;
  }
  return count;
}

/** The directory a `cd` or `pushd` leaves the command in; an unknown target leaves it as it was. */
function directoryAfter(segment: string, directory: string): string {
  const word = commandWord(segment);
  if (word !== 'cd' && word !== 'pushd') return directory;
  const target = words(segment)
    .slice(1)
    .find((w) => w === '-' || !w.startsWith('-'));
  if (target === undefined) return homedir();
  if (target === '-') return directory;
  const expanded = expandedPath(target, directory);
  if (expanded === null) return directory;
  const next = isAbsolute(expanded) ? expanded : resolve(directory, expanded);
  // No real path is this long; a chain of `pushd a` would otherwise grow it with every step.
  return next.length > MAX_PATH_CHARS ? directory : next;
}
