// What one call of a session leaves for the calls after it: a change to where requests go, and a
// key put in a variable.
//
// A config file a call wrote (`~/.curlrc`, `~/.gitconfig`, `/etc/hosts`, a shell's startup file,
// the file Claude Code reads its variables from), a proxy a call named, or, in a shell that keeps
// its variables (Codex, Cursor), a variable whose name is not written out or a file sourced: any
// of these may send a later request somewhere it does not name, so a later request to the key's
// own service, or to this machine, is another company's; so may a write to a path written as a
// pattern. And a variable an earlier call set to a key, or to a value that uses such a variable,
// holds it in a later call that uses it: a later call that can send sent it to another company.
// Every reader here goes through the text once, with no pattern that backtracks.
import { isShellTool } from '@stroq/core';
import type { Place } from './place.js';
import { COPIERS } from './shell-place.js';
import { commandReading, MAX_READ_CHARS, readBudgetLeft } from './shell-read.js';
import { allStages, joinedText, setsUnwrittenName } from './shell-route.js';
import { writtenFiles, writtenFilesCut } from './where.js';

/** Words that change where later requests go, wherever they stand in a call. */
const PERSIST_WORDS: readonly string[] = [
  'proxy',
  'insteadof',
  'sshcommand',
  'git_ssh',
  'curl_home',
  'wgetrc=',
  'git_config',
  'hostaliases',
  'res_options',
  'localdomain',
  'ld_preload',
  'dyld_insert',
];

/** Files that decide where later requests go, or what a later shell sets: by a piece of their path. */
const ROUTE_FILES: readonly string[] = [
  '.curlrc',
  '_curlrc',
  '.wgetrc',
  '.gitconfig',
  '.git/config',
  '.config/git/',
  '.ssh/',
  '.npmrc',
  '.yarnrc',
  'pip.conf',
  '.docker/config.json',
  '.bashrc',
  '.bash_profile',
  '.bash_login',
  '.profile',
  '.zshrc',
  '.zshenv',
  '.zprofile',
  '.zlogin',
  '.envrc',
  '/etc/',
  // The file Claude Code reads its variables from before each command.
  'claude_env_file',
];

/** Programs that only read the files they are given. */
const READERS: ReadonlySet<string> = new Set([
  'cat',
  'head',
  'tail',
  'less',
  'more',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'ls',
  'stat',
  'wc',
  'file',
  'bat',
  'diff',
  'test',
  '[',
]);

/** Whether a command, its words joined, only reads: no redirect, and every command a reader. */
function onlyReads(joined: string): boolean {
  if (joined.includes('>')) return false;
  return joined
    .split(/[;&|()\n]+/)
    .map((part) => part.trim().split(/\s+/)[0] ?? '')
    .every((word) => word === '' || READERS.has(word));
}

/**
 * Whether a call may change where the requests of later calls go. `agent` decides whether a
 * shell's variables outlive the call: Claude Code starts each command afresh.
 */
export function changesRoutes(
  tool: string,
  input: Readonly<Record<string, unknown>>,
  agent: string,
  cwd: string | null = null,
): boolean {
  if (isShellTool(tool)) {
    const command = typeof input['command'] === 'string' ? input['command'] : '';
    const joined = joinedText(command);
    const lower = joined.toLowerCase();
    if (PERSIST_WORDS.some((word) => lower.includes(word))) return true;
    if (ROUTE_FILES.some((file) => lower.includes(file)) && !onlyReads(joined)) return true;
    if (writesAPattern(command, cwd)) return true;
    return agent !== 'claude-code' && (setsUnwrittenName(joined) || setsUnsafeName(joined));
  }
  // A patch past the files read may write one that changes where requests go.
  if (writtenFilesCut(input)) return true;
  return writtenFiles(input).some((path) => {
    const file = path.toLowerCase();
    return ROUTE_FILES.some((piece) => file.includes(piece)) || WILDCARD.test(file);
  });
}

/**
 * Variables a shell that keeps them (Codex, Cursor) may set without changing where a later request
 * goes. Any other one set may: a proxy, a config file, a CA, a library loaded before it connects.
 */
const SAFE_NAMES: ReadonlySet<string> = new Set([
  'PS1',
  'PS2',
  'PS4',
  'TERM',
  'COLUMNS',
  'LINES',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'PAGER',
  'GIT_PAGER',
  'EDITOR',
  'VISUAL',
  'NODE_ENV',
  'CI',
  'DEBUG',
  'FORCE_COLOR',
  'NO_COLOR',
  'HISTFILE',
  'HISTSIZE',
]);

/** Whether a command, its words joined, sets a variable that is not on the short list of safe ones. */
function setsUnsafeName(joined: string): boolean {
  for (const match of joined.matchAll(ASSIGNED))
    if (!SAFE_NAMES.has(match[1] as string)) return true;
  return false;
}

/** Characters that make a word a pattern the shell fills in. */
const WILDCARD = /[*?[{]/;

/**
 * Whether a command writes, copies or moves to a path written as a pattern (`> ~/.cur*rc`, `cp x
 * ~/.git{config,}`): read as the core expands it, a path that decides where later requests go is
 * one; any other pattern may be one, whatever its name says. A command too long to read that holds
 * a pattern may write one.
 */
function writesAPattern(command: string, cwd: string | null): boolean {
  if (!WILDCARD.test(command)) return false;
  if (command.length > MAX_READ_CHARS || !readBudgetLeft()) return true;
  const reading = commandReading(command, cwd);
  return allStages(reading).some((stage) => {
    const facts = reading.facts(stage);
    const copied = COPIERS.has(facts.name)
      ? (facts.resolved?.args ?? []).filter((w) => !w.redirect && !w.value.startsWith('-'))
      : [];
    return [...facts.writes, ...copied.map((w) => w.value)].some((target) => {
      const lower = target.toLowerCase();
      return WILDCARD.test(target) || ROUTE_FILES.some((piece) => lower.includes(piece));
    });
  });
}

/**
 * Curl's own config files, by any of their names (`~/.curlrc`, `~/.config/curlrc`,
 * `$XDG_CONFIG_HOME/curlrc`, `_curlrc`): curl reads one before every request, so one a session
 * wrote, read, listed or named may send every later curl request somewhere it does not name.
 */
const CURL_CONFIG = /curlrc/i;

/** Whether a text names a curl config file. */
export const namesCurlConfig = (text: string): boolean => CURL_CONFIG.test(text);

/** Whether a command runs curl, or may: a later request it makes reads curl's config file. */
export const mayRunCurl = (command: string): boolean => /curl/i.test(command);

/** A request whose route an earlier call may have changed: never the key's own service, nor this machine. */
export function rerouted(place: Place): Place {
  if (place.tier !== 'own_service' && !(place.tier === 'maybe' && place.local === true))
    return place;
  const { host: _host, local: _local, ...rest } = place;
  return { ...rest, tier: 'third_party' };
}

const isNameChar = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9_]/.test(c);
const isNameStart = (c: string | undefined): boolean => c !== undefined && /[A-Za-z_]/.test(c);

/** Characters that end a step of a command: a `NAME=` before one does not set what follows it. */
const STEP_END = new Set(['\n', ';', '&', '|']);

/**
 * The variables a command sets to a text that holds `form`: for each place it holds it, the name
 * of the nearest `NAME=` before it in the same step (`export K=…`, `K='…'`, `declare -x
 * T="Bearer …"`, `docker run -e K=…`), however far before it. One pass over the command: the last
 * `NAME=` of the step is kept as it is read, so nothing is looked at twice.
 */
export function variablesSetTo(command: string, form: string): string[] {
  const names = new Set<string>();
  if (form === '') return [];
  let next = command.indexOf(form);
  let last: string | null = null;
  for (let i = 0; i < command.length && next >= 0; i += 1) {
    if (i === next) {
      if (last !== null) names.add(last);
      next = command.indexOf(form, next + form.length);
    }
    const c = command[i] as string;
    if (STEP_END.has(c)) last = null;
    else if (c === '=' && isNameChar(command[i - 1])) {
      let from = i - 1;
      while (from > 0 && isNameChar(command[from - 1])) from -= 1;
      const before = command[from - 1];
      if (isNameStart(command[from]) && (before === undefined || /[\s(]/.test(before)))
        last = command.slice(from, i);
    }
  }
  return [...names];
}

/** The variables a command expands: `$NAME` and `${NAME…}`. */
export function variablesUsed(command: string): Set<string> {
  const used = new Set<string>();
  for (let i = command.indexOf('$'); i >= 0; i = command.indexOf('$', i + 1)) {
    const from = command[i + 1] === '{' ? i + 2 : i + 1;
    if (!isNameStart(command[from])) continue;
    let end = from;
    while (isNameChar(command[end])) end += 1;
    used.add(command.slice(from, end));
  }
  return used;
}

/** Variables a key is followed through across a session, at most. */
export const MAX_KEPT_VARIABLES = 4_096;

/** A name set where a word starts: `K=…`, `export K=…`, `env K=… cmd`. */
const ASSIGNED = /(?:^|[\s(])([A-Za-z_][A-Za-z0-9_]*)=/g;

/**
 * The names each step of a command sets, with the variables the same step uses: a name set in a
 * step that uses a variable a key was put in (`T="Bearer $K"`) may hold the key too. Steps are cut
 * at `;`, `&`, `|` and line breaks, and each is read once.
 */
export function stepAssignments(command: string): { names: string[]; uses: Set<string> }[] {
  const out: { names: string[]; uses: Set<string> }[] = [];
  for (const step of command.split(/[;&|\n]/)) {
    if (!step.includes('=') || !step.includes('$')) continue;
    const names = [...step.matchAll(ASSIGNED)].map((m) => m[1] as string);
    if (names.length > 0) out.push({ names, uses: variablesUsed(step) });
  }
  return out;
}
