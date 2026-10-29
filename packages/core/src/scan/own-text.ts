import { basename, isAbsolute, relative, resolve } from 'node:path';
import type { ScanTarget } from '../rules/atr-types.js';
import { inFetched } from './fetched-paths.js';
import { printsOwnText } from './local-commands.js';
import { DEPENDENCY_DIR_WORD, INSTRUCTION_READ_PATH, withinWorktree } from './scan-target.js';

/**
 * A file or folder an agent loads as instructions, named in a command line (`cat AGENTS.md`,
 * `grep -r x .claude/`, `cd .claude`), as `scanTargetForTool` reads a path for `Read`; a working copy
 * of the project under `.claude/worktrees/` or `.codex/worktrees/` is no such file.
 */
const INSTRUCTION_WORD =
  /(?:^|[\s'"=:/\\])(?:(?:CLAUDE(?:\.local)?|AGENTS(?:\.override)?|GEMINI|QWEN|CRUSH|CONVENTIONS|SKILL|copilot-instructions)\.md|\.(?:cursorrules|windsurfrules|clinerules))(?=$|[\s'";|&)<>:])|(?:^|[\s'"=:/\\])\.(?:claude|cursor|codex|windsurf|clinerules|roo|kiro|junie|kilocode|continue)(?:[/\\](?!worktrees[/\\])|(?=$|[\s'";|&)<>]))|(?:^|[\s'"=:/\\])\.github[/\\]instructions[/\\]/i;

/** The names a pattern may not reach for what it reads to be the project's own. */
const NOT_OWN_NAMES = [
  'CLAUDE.md',
  'CLAUDE.local.md',
  'AGENTS.md',
  'GEMINI.md',
  'SKILL.md',
  'CONVENTIONS.md',
  '.cursorrules',
  '.windsurfrules',
  '.clinerules',
  '.claude',
  '.cursor',
  '.codex',
  '.windsurf',
  'node_modules',
  'vendor',
  'site-packages',
  '.venv',
  'venv',
  'Pods',
  'third_party',
];

/** Longer than this, a command is not read: what it runs is not known (`printsOwnText` holds the same). */
const MAX_COMMAND_CHARS = 64 * 1024;
/** The longest pattern looked at: past it, a word is taken to reach anything. */
const MAX_PATTERN_CHARS = 256;

/** A shell pattern, or a brace expansion, as a regular expression over one name. */
function patternSource(part: string): string | null {
  let source = '';
  let depth = 0;
  for (const ch of part) {
    if (ch === '*') source += '.*';
    else if (ch === '?') source += '.';
    else if (ch === '{') {
      depth += 1;
      source += '(?:';
    } else if (ch === '}' && depth > 0) {
      depth -= 1;
      source += ')';
    } else if (ch === ',' && depth > 0) source += '|';
    else if (ch === '[' || ch === ']' || ch === '^' || ch === '-') source += ch;
    else if (ch === '!') source += '^';
    else source += ch.replace(/[.+()|$\\}]/g, '\\$&');
  }
  return depth === 0 ? source : null;
}

/**
 * Whether a path or a shell pattern may name a file or folder of `NOT_OWN_NAMES` or one of `also`
 * (`*.md` may be `AGENTS.md`, `.cl*` may be `.claude`, `{AGENTS,CLAUDE}.md` names both): each part of
 * it between slashes is matched against them. `folders: false` passes over a folder part that is a
 * pattern (`**`, `src/*`): for a search whose output names every file it found, which is read instead.
 */
function mayReachOthers(pattern: string, also: readonly string[] = [], folders = true): boolean {
  if (pattern.length > MAX_PATTERN_CHARS) return true;
  const names = [...NOT_OWN_NAMES, ...also];
  const parts = pattern.split(/[/\\]/);
  return parts.some((part, at) => {
    // `[` and `[[` alone are the test command, not a pattern.
    if (part === '' || /^\[{1,2}$/.test(part)) return false;
    if (!folders && at < parts.length - 1 && /[*?[{]/.test(part)) return false;
    const source = patternSource(part);
    if (source === null) return true;
    let re: RegExp;
    try {
      re = new RegExp(`^(?:${source})$`, 'i');
    } catch {
      return true;
    }
    return names.some((name) => re.test(name));
  });
}

/** Words of a command line that are patterns a shell expands: unquoted `*`, `?`, `[` or `{`. */
const PATTERN_WORD = /(?:^|[\s(])((?:[^\s'"*?[{]*[*?[{][^\s'"]*))/g;
/** What a shell cuts a word at, which a pattern glued to it (`*.md|head`, `*.md;`) is not part of. */
const WORD_END = /[;|&)<>].*$/s;

/** The names of the files the session downloaded, long enough to be told apart in a text. */
const fetchedNames = (fetched: readonly string[]): string[] =>
  fetched.map((path) => basename(path)).filter((name) => name.length >= 3);

/** Whether a text names a file the session downloaded: by its path, its path from here, or its name. */
function namesFetched(text: string, cwd: string, fetched: readonly string[]): boolean {
  return fetched.some((path) => {
    const near = relative(cwd, path);
    const name = basename(path);
    return (
      text.includes(path) ||
      (near !== '' && !near.startsWith('..') && text.includes(near)) ||
      (name.length >= 3 &&
        new RegExp(
          `(?:^|[\\s'"=/:])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[\\s'";|&)<>:])`,
        ).test(text))
    );
  });
}

/** Programs whose output names the files it came from: a search, a listing, a history of changes. */
const SEARCHES =
  /(?:^|[\s;&|(`'"])(?:[\w./-]*\/)?(?:grep|egrep|fgrep|rg|ag|ack|find|fd|tree|ls|git\s+(?:grep|diff|log|show|blame)|get-childitem|gci|dir|select-string|sls)(?=\s|$)/i;
/** Programs that print what is in the files they are given. */
const READERS =
  /(?:^|[\s;&|(`'"])(?:[\w./-]*\/)?(?:cat|bat|batcat|head|tail|less|more|sed|awk|grep|egrep|fgrep|rg|ag|ack|strings|xxd|od|hexdump|nl|tac|cut|sort|uniq|jq|yq|get-content|gc|select-string|sls)(?=\s|$)/i;

/** Output that holds a dependency's file or an instruction file, as a search or listing prints it. */
const reachesOthers = (text: string): boolean =>
  DEPENDENCY_DIR_WORD.test(text) || INSTRUCTION_WORD.test(text);

/**
 * Whether a tool's result is the developer's own text: a file read with Read or Grep, or what a
 * local command printed. A flag there does not taint the session; what is copied from the text is
 * still asked about, as from any text the agent read (see `StroqEngine.post`). Not own text, so a
 * flag taints as it always has: what somebody else wrote (`web_content`, which already covers a
 * fetched page, an issue and a dependency's files read with Read or Grep; an MCP result or tool
 * list; an instruction file), and any command that runs a program not known to print only local
 * text (`printsOwnText`), names a dependency's folder or an instruction file, gives a reader a
 * pattern that may reach one or a path a substitution makes, or whose search printed one. Nor is
 * what the session downloaded (`fetched`, see `fetchedPaths`), read back by any of these. `any` is
 * a tool nothing is known about.
 */
export function isOwnText(
  toolName: string,
  toolInput: Readonly<Record<string, unknown>>,
  target: ScanTarget,
  text = '',
  cwd = '/',
  fetched: readonly string[] = [],
): boolean {
  if (target === 'repo_content') {
    const path =
      toolName === 'Read' ? (toolInput.file_path ?? toolInput.notebook_path) : toolInput.path;
    if (typeof path === 'string' && fetched.length > 0) {
      const full = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
      if (inFetched(full, fetched)) return false;
    }
    if (toolName === 'Read') return true;
    if (toolName !== 'Grep') return false;
    if (typeof path === 'string' && INSTRUCTION_READ_PATH.test(withinWorktree(path))) return false;
    const glob = toolInput.glob;
    if (typeof glob === 'string' && mayReachOthers(glob, fetchedNames(fetched), false))
      return false;
    return !reachesOthers(text) && !namesFetched(text, cwd, fetched);
  }
  if (target !== 'command_output') return false;
  const command = toolInput.command;
  if (typeof command !== 'string' || command.length > MAX_COMMAND_CHARS) return false;
  if (DEPENDENCY_DIR_WORD.test(command) || INSTRUCTION_WORD.test(command)) return false;
  if (namesFetched(command, cwd, fetched)) return false;
  for (const match of command.matchAll(PATTERN_WORD)) {
    const word = (match[1] ?? '').replace(WORD_END, '');
    // A brace is a pattern only with a list or a range in it (`{a,b}`, `{1..3}`), not a group's `{`.
    const pattern = /[*?[]/.test(word) || /\{[^{}\s]*(?:,|\.\.)[^{}\s]*\}/.test(word);
    if (pattern && mayReachOthers(word, fetchedNames(fetched))) return false;
  }
  // A reader given a path that a substitution makes (`cat $(npm root)/x/README.md`) reads where nobody can say.
  if (/\$\(|`/.test(command) && READERS.test(command)) return false;
  if (SEARCHES.test(command) && (reachesOthers(text) || namesFetched(text, cwd, fetched)))
    return false;
  return printsOwnText(command, cwd);
}
